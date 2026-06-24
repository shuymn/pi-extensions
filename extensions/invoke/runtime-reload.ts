import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyIfUI } from "../../lib/tui";
import type { InvokeOperation } from "./operations";
import {
  createArmedRuntimeReloadMarker,
  createConsumedRuntimeReloadMarker,
  createFailedRuntimeReloadMarker,
  findPendingRuntimeReloadMarker,
  RUNTIME_RELOAD_CONTINUATION_CUSTOM_TYPE,
  RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
  RUNTIME_RELOAD_OPERATION_NAME,
} from "./reload-state";

export const DEFAULT_RUNTIME_RELOAD_CONTINUATION_PROMPT = [
  "Runtime reload completed.",
  "Continue the current user-requested work from the refreshed extension runtime and recent context.",
  "Do not repeat completed steps.",
].join(" ");

type RuntimeReloadArgs = {
  continuationPrompt?: string;
  stopAfterReload: boolean;
};

type RuntimeReloadArgsParseResult =
  | { ok: true; value: RuntimeReloadArgs }
  | { ok: false; message: string };

type RuntimeReloadOptions = {
  createInvocationId?: () => string;
  now?: () => string;
};

type RuntimeReloadCommandContext = Pick<ExtensionCommandContext, "hasUI" | "reload" | "ui">;

const STALE_RUNTIME_RELOAD_MARKER_AGE_MS = 5 * 60 * 1000;

export function createRuntimeReloadOperation(
  pi: Pick<ExtensionAPI, "appendEntry">,
  options: RuntimeReloadOptions = {},
): InvokeOperation {
  return {
    name: RUNTIME_RELOAD_OPERATION_NAME,
    description: "Reload the extension runtime and optionally continue afterward",
    handler: async (args, ctx) => {
      await invokeRuntimeReload(pi, args, ctx, options);
    },
  };
}

export function registerRuntimeReloadContinuation(
  pi: Pick<ExtensionAPI, "appendEntry" | "on" | "sendMessage">,
  options: Pick<RuntimeReloadOptions, "now"> = {},
): void {
  const consumedInRuntime = new Set<string>();

  pi.on("session_start", (event, ctx) => {
    const marker = findPendingRuntimeReloadMarker(ctx.sessionManager.getBranch());
    if (!marker || consumedInRuntime.has(marker.invocationId)) return;

    const shouldContinue =
      event.reason === "reload" && !isStaleRuntimeReloadMarker(marker, options.now);
    consumeRuntimeReloadMarker(pi, marker, consumedInRuntime, options.now);

    if (!shouldContinue) return;

    if (marker.stopAfterReload) {
      notifyIfUI(ctx, "ランタイムリロードが完了しました。継続は行いません。", "info");
      return;
    }

    notifyIfUI(ctx, "ランタイムリロードが完了しました。継続ターンを開始します。", "info");
    sendRuntimeReloadContinuation(pi, marker);
  });
}

export async function invokeRuntimeReload(
  pi: Pick<ExtensionAPI, "appendEntry">,
  args: unknown | undefined,
  ctx: RuntimeReloadCommandContext,
  options: RuntimeReloadOptions = {},
): Promise<void> {
  const parsed = parseRuntimeReloadArgs(args);
  if (!parsed.ok) {
    notifyIfUI(ctx, parsed.message, "error");
    return;
  }

  const marker = createArmedRuntimeReloadMarker({
    invocationId: options.createInvocationId?.() ?? randomUUID(),
    continuationPrompt: parsed.value.continuationPrompt,
    stopAfterReload: parsed.value.stopAfterReload,
    ...(options.now ? { now: options.now } : {}),
  });

  try {
    pi.appendEntry(RUNTIME_RELOAD_MARKER_CUSTOM_TYPE, marker);
  } catch (error) {
    notifyIfUI(ctx, `ランタイムリロードの予約に失敗しました: ${errorMessage(error)}`, "error");
    return;
  }

  notifyIfUI(ctx, "ランタイムリロードを予約しました。リロードを開始します。", "info");

  try {
    await ctx.reload();
    return;
  } catch (error) {
    pi.appendEntry(
      RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
      createFailedRuntimeReloadMarker(marker, errorMessage(error), options.now),
    );
    notifyIfUI(ctx, `ランタイムリロードに失敗しました: ${errorMessage(error)}`, "error");
  }
}

export function parseRuntimeReloadArgs(args: unknown | undefined): RuntimeReloadArgsParseResult {
  if (args === undefined) return { ok: true, value: { stopAfterReload: false } };
  if (!isObject(args)) {
    return { ok: false, message: "runtime.reload の args は JSON object で指定してください。" };
  }

  const continuationPromptValue = args.continuationPrompt;
  if (continuationPromptValue !== undefined && typeof continuationPromptValue !== "string") {
    return { ok: false, message: "continuationPrompt は文字列で指定してください。" };
  }
  const continuationPrompt = continuationPromptValue?.trim() || undefined;

  const stopAfterReload = args.stopAfterReload;
  if (stopAfterReload !== undefined && typeof stopAfterReload !== "boolean") {
    return { ok: false, message: "stopAfterReload は boolean で指定してください。" };
  }

  return {
    ok: true,
    value: {
      ...(continuationPrompt ? { continuationPrompt } : {}),
      stopAfterReload: stopAfterReload === true,
    },
  };
}

function consumeRuntimeReloadMarker(
  pi: Pick<ExtensionAPI, "appendEntry">,
  marker: { invocationId: string },
  consumedInRuntime: Set<string>,
  now?: () => string,
): void {
  consumedInRuntime.add(marker.invocationId);
  pi.appendEntry(RUNTIME_RELOAD_MARKER_CUSTOM_TYPE, createConsumedRuntimeReloadMarker(marker, now));
}

function isStaleRuntimeReloadMarker(marker: { createdAt: string }, now?: () => string): boolean {
  const createdAtMs = Date.parse(marker.createdAt);
  if (!Number.isFinite(createdAtMs)) return true;

  const nowMs = now ? Date.parse(now()) : Date.now();
  if (!Number.isFinite(nowMs)) return false;

  return nowMs - createdAtMs > STALE_RUNTIME_RELOAD_MARKER_AGE_MS;
}

function sendRuntimeReloadContinuation(
  pi: Pick<ExtensionAPI, "sendMessage">,
  marker: { invocationId: string; continuationPrompt?: string },
): void {
  pi.sendMessage(
    {
      customType: RUNTIME_RELOAD_CONTINUATION_CUSTOM_TYPE,
      content: marker.continuationPrompt ?? DEFAULT_RUNTIME_RELOAD_CONTINUATION_PROMPT,
      display: false,
      details: {
        source: RUNTIME_RELOAD_OPERATION_NAME,
        invocationId: marker.invocationId,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
