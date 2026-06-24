import { describe, expect, test } from "bun:test";
import { createFakeUi } from "../../tests/support/fake-ui";
import {
  createArmedRuntimeReloadMarker,
  createConsumedRuntimeReloadMarker,
  RUNTIME_RELOAD_CONTINUATION_CUSTOM_TYPE,
  RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
  RUNTIME_RELOAD_OPERATION_NAME,
} from "./reload-state";
import {
  createRuntimeReloadOperation,
  DEFAULT_RUNTIME_RELOAD_CONTINUATION_PROMPT,
  invokeRuntimeReload,
  parseRuntimeReloadArgs,
  registerRuntimeReloadContinuation,
} from "./runtime-reload";

type EventHandler = (event: any, ctx: any) => Promise<void> | void;

type AppendRecord = { customType: string; data: unknown };
type SentMessageRecord = { message: any; options: unknown };

function createPi(options: { appendEntry?: (customType: string, data: unknown) => void } = {}) {
  const appendedEntries: AppendRecord[] = [];
  const sentMessages: SentMessageRecord[] = [];
  const events = new Map<string, EventHandler[]>();

  return {
    appendedEntries,
    sentMessages,
    events,
    appendEntry(customType: string, data: unknown) {
      if (options.appendEntry) return options.appendEntry(customType, data);
      appendedEntries.push({ customType, data });
    },
    sendMessage(message: any, options: unknown) {
      sentMessages.push({ message, options });
    },
    on(eventName: string, handler: EventHandler) {
      events.set(eventName, [...(events.get(eventName) ?? []), handler]);
    },
  };
}

function createReloadCommandContext(options: { reload?: () => Promise<void> | void } = {}) {
  const ui = createFakeUi();
  const reloadCalls: string[] = [];
  let stale = false;

  return {
    ctx: {
      hasUI: true,
      isIdle: () => true,
      ui: {
        ...ui,
        notify(message: string, level: string) {
          if (stale) throw new Error("old ctx used after reload");
          ui.notify(message, level);
        },
      },
      async reload() {
        reloadCalls.push("reload");
        await options.reload?.();
        stale = true;
      },
    },
    ui,
    reloadCalls,
  };
}

function customEntry(data: unknown) {
  return {
    type: "custom",
    customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
    data,
  };
}

function createSessionContext(entries: unknown[]) {
  const ui = createFakeUi();
  return {
    ctx: {
      hasUI: true,
      ui,
      sessionManager: {
        getBranch: () => entries,
      },
    },
    ui,
  };
}

describe("runtime.reload operation", () => {
  test("parses args with defaults, custom prompt, and stopAfterReload", () => {
    expect(parseRuntimeReloadArgs(undefined)).toEqual({
      ok: true,
      value: { stopAfterReload: false },
    });
    expect(
      parseRuntimeReloadArgs({
        continuationPrompt: "  Resume from reload.  ",
        stopAfterReload: true,
      }),
    ).toEqual({
      ok: true,
      value: { continuationPrompt: "Resume from reload.", stopAfterReload: true },
    });
    expect(parseRuntimeReloadArgs([])).toEqual({
      ok: false,
      message: "runtime.reload の args は JSON object で指定してください。",
    });
    expect(parseRuntimeReloadArgs({ continuationPrompt: 1 })).toEqual({
      ok: false,
      message: "continuationPrompt は文字列で指定してください。",
    });
    expect(parseRuntimeReloadArgs({ stopAfterReload: "false" })).toEqual({
      ok: false,
      message: "stopAfterReload は boolean で指定してください。",
    });
  });

  test("appends an armed marker and treats successful ctx.reload as terminal", async () => {
    const pi = createPi();
    const { ctx, ui, reloadCalls } = createReloadCommandContext();

    await invokeRuntimeReload(
      pi,
      { continuationPrompt: " Continue after reload. ", stopAfterReload: false },
      ctx as never,
      {
        createInvocationId: () => "reload-1",
        now: () => "2026-06-24T00:00:00.000Z",
      },
    );

    expect(reloadCalls).toEqual(["reload"]);
    expect(pi.appendedEntries).toEqual([
      {
        customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
        data: {
          version: 1,
          operation: RUNTIME_RELOAD_OPERATION_NAME,
          status: "armed",
          invocationId: "reload-1",
          continuationPrompt: "Continue after reload.",
          stopAfterReload: false,
          createdAt: "2026-06-24T00:00:00.000Z",
        },
      },
    ]);
    expect(ui.notifications).toEqual([
      { level: "info", message: "ランタイムリロードを予約しました。リロードを開始します。" },
    ]);
  });

  test("rejects invalid runtime.reload args before appending or reloading", async () => {
    const pi = createPi();
    const { ctx, ui, reloadCalls } = createReloadCommandContext();

    await invokeRuntimeReload(pi, { stopAfterReload: "no" }, ctx as never, {
      createInvocationId: () => "reload-1",
    });

    expect(reloadCalls).toEqual([]);
    expect(pi.appendedEntries).toEqual([]);
    expect(ui.notifications).toEqual([
      { level: "error", message: "stopAfterReload は boolean で指定してください。" },
    ]);
  });

  test("reports marker append failure before reloading", async () => {
    const pi = createPi({
      appendEntry: () => {
        throw new Error("disk full");
      },
    });
    const { ctx, ui, reloadCalls } = createReloadCommandContext();

    await invokeRuntimeReload(pi, undefined, ctx as never, {
      createInvocationId: () => "reload-1",
    });

    expect(reloadCalls).toEqual([]);
    expect(pi.appendedEntries).toEqual([]);
    expect(ui.notifications).toEqual([
      { level: "error", message: "ランタイムリロードの予約に失敗しました: disk full" },
    ]);
  });

  test("records failed marker and reports reload failure", async () => {
    const pi = createPi();
    const { ctx, ui, reloadCalls } = createReloadCommandContext({
      reload: () => {
        throw new Error("reload failed");
      },
    });

    await invokeRuntimeReload(pi, undefined, ctx as never, {
      createInvocationId: () => "reload-1",
      now: () => "2026-06-24T00:00:00.000Z",
    });

    expect(reloadCalls).toEqual(["reload"]);
    expect(pi.appendedEntries).toEqual([
      {
        customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
        data: expect.objectContaining({ status: "armed", invocationId: "reload-1" }) as never,
      },
      {
        customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
        data: {
          version: 1,
          operation: RUNTIME_RELOAD_OPERATION_NAME,
          status: "failed",
          invocationId: "reload-1",
          errorMessage: "reload failed",
          failedAt: "2026-06-24T00:00:00.000Z",
        },
      },
    ]);
    expect(ui.notifications.at(-1)).toEqual({
      level: "error",
      message: "ランタイムリロードに失敗しました: reload failed",
    });
  });

  test("createRuntimeReloadOperation exposes the allowlisted operation name", async () => {
    const pi = createPi();
    const operation = createRuntimeReloadOperation(pi, {
      createInvocationId: () => "reload-1",
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const { ctx, reloadCalls } = createReloadCommandContext();

    expect(operation.name).toBe(RUNTIME_RELOAD_OPERATION_NAME);
    expect(operation.description).toContain("Reload");

    await operation.handler({ stopAfterReload: true }, ctx as never);

    expect(reloadCalls).toEqual(["reload"]);
    expect(pi.appendedEntries[0]!.data).toMatchObject({
      operation: RUNTIME_RELOAD_OPERATION_NAME,
      status: "armed",
      stopAfterReload: true,
    });
  });
});

describe("runtime.reload continuation", () => {
  test("built-in reload without an armed marker does not trigger continuation", async () => {
    const pi = createPi();
    registerRuntimeReloadContinuation(pi as never);
    const { ctx, ui } = createSessionContext([]);

    await pi.events.get("session_start")![0]!({ reason: "reload" }, ctx);

    expect(pi.appendedEntries).toEqual([]);
    expect(pi.sentMessages).toEqual([]);
    expect(ui.notifications).toEqual([]);
  });

  test("consumes an armed marker once and sends a default hidden follow-up", async () => {
    const pi = createPi();
    registerRuntimeReloadContinuation(pi as never, {
      now: () => "2026-06-24T00:00:01.000Z",
    });
    const marker = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const { ctx, ui } = createSessionContext([customEntry(marker)]);

    await pi.events.get("session_start")![0]!({ reason: "reload" }, ctx);
    await pi.events.get("session_start")![0]!({ reason: "reload" }, ctx);

    expect(pi.appendedEntries).toEqual([
      {
        customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
        data: {
          version: 1,
          operation: RUNTIME_RELOAD_OPERATION_NAME,
          status: "consumed",
          invocationId: "reload-1",
          consumedAt: "2026-06-24T00:00:01.000Z",
        },
      },
    ]);
    expect(pi.sentMessages).toEqual([
      {
        message: {
          customType: RUNTIME_RELOAD_CONTINUATION_CUSTOM_TYPE,
          content: DEFAULT_RUNTIME_RELOAD_CONTINUATION_PROMPT,
          display: false,
          details: { source: RUNTIME_RELOAD_OPERATION_NAME, invocationId: "reload-1" },
        },
        options: { triggerTurn: true, deliverAs: "followUp" },
      },
    ]);
    expect(ui.notifications).toEqual([
      { level: "info", message: "ランタイムリロードが完了しました。継続ターンを開始します。" },
    ]);
  });

  test("uses custom continuation prompt", async () => {
    const pi = createPi();
    registerRuntimeReloadContinuation(pi as never, {
      now: () => "2026-06-24T00:00:01.000Z",
    });
    const marker = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      continuationPrompt: "Resume after runtime reload.",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const { ctx } = createSessionContext([customEntry(marker)]);

    await pi.events.get("session_start")![0]!({ reason: "reload" }, ctx);

    expect(pi.sentMessages[0]!.message.content).toBe("Resume after runtime reload.");
  });

  test("does not send continuation when stopAfterReload is true", async () => {
    const pi = createPi();
    registerRuntimeReloadContinuation(pi as never, {
      now: () => "2026-06-24T00:00:01.000Z",
    });
    const marker = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      stopAfterReload: true,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const { ctx, ui } = createSessionContext([customEntry(marker)]);

    await pi.events.get("session_start")![0]!({ reason: "reload" }, ctx);

    expect(pi.appendedEntries).toEqual([
      {
        customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
        data: createConsumedRuntimeReloadMarker(marker, () => "2026-06-24T00:00:01.000Z"),
      },
    ]);
    expect(pi.sentMessages).toEqual([]);
    expect(ui.notifications).toEqual([
      { level: "info", message: "ランタイムリロードが完了しました。継続は行いません。" },
    ]);
  });

  test("consumes orphaned markers on startup without continuing", async () => {
    const pi = createPi();
    registerRuntimeReloadContinuation(pi as never, {
      now: () => "2026-06-24T00:00:01.000Z",
    });
    const marker = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const { ctx, ui } = createSessionContext([customEntry(marker)]);

    await pi.events.get("session_start")![0]!({ reason: "startup" }, ctx);

    expect(pi.appendedEntries).toEqual([
      {
        customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
        data: createConsumedRuntimeReloadMarker(marker, () => "2026-06-24T00:00:01.000Z"),
      },
    ]);
    expect(pi.sentMessages).toEqual([]);
    expect(ui.notifications).toEqual([]);
  });

  test("consumes stale reload markers without continuing", async () => {
    const pi = createPi();
    registerRuntimeReloadContinuation(pi as never, {
      now: () => "2026-06-24T00:06:00.000Z",
    });
    const marker = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const { ctx, ui } = createSessionContext([customEntry(marker)]);

    await pi.events.get("session_start")![0]!({ reason: "reload" }, ctx);

    expect(pi.appendedEntries).toEqual([
      {
        customType: RUNTIME_RELOAD_MARKER_CUSTOM_TYPE,
        data: createConsumedRuntimeReloadMarker(marker, () => "2026-06-24T00:06:00.000Z"),
      },
    ]);
    expect(pi.sentMessages).toEqual([]);
    expect(ui.notifications).toEqual([]);
  });

  test("does not resume on startup or after a consumed marker", async () => {
    const pi = createPi();
    registerRuntimeReloadContinuation(pi as never);
    const marker = createArmedRuntimeReloadMarker({
      invocationId: "reload-1",
      stopAfterReload: false,
      now: () => "2026-06-24T00:00:00.000Z",
    });
    const consumed = createConsumedRuntimeReloadMarker(marker, () => "2026-06-24T00:00:01.000Z");
    const { ctx } = createSessionContext([customEntry(marker), customEntry(consumed)]);

    await pi.events.get("session_start")![0]!({ reason: "startup" }, ctx);
    await pi.events.get("session_start")![0]!({ reason: "reload" }, ctx);

    expect(pi.appendedEntries).toEqual([]);
    expect(pi.sentMessages).toEqual([]);
  });
});
