import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readGlobalExtensionSettings, updateGlobalExtensionSettings } from "../../lib/settings";
import { notifyIfUI } from "../../lib/tui";
import { getCompanionSocketPath } from "./socket-path";

const COMPANION_SETTINGS_KEY = "companion";
const COMPANION_STATUS_KEY = "companion";
const COMPANION_STATUS_ON = "G ·";
const SESSION_ID = randomUUID().slice(0, 8);
const SOCKET_PATH = getCompanionSocketPath();
const COMPANION_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "companion.ts");
const COMPANION_COMMAND = process.env.PI_COMPANION_BUN_COMMAND ?? "bun";
const USAGE = "使い方: /companion [on|off|toggle|status]";
const DETAIL_MAX = 60;

type CompanionStatus =
  | "starting"
  | "thinking"
  | "reading"
  | "editing"
  | "running"
  | "searching"
  | "done"
  | "error";

interface CompanionSettings {
  enabled?: boolean;
}

type ContextUsageLike = {
  percent?: unknown;
  tokens?: unknown;
};

type ModelLike = {
  contextWindow?: unknown;
};

type StatusContext = Pick<ExtensionContext, "hasUI" | "ui">;

type ContextUsageContext = Pick<ExtensionContext, "getContextUsage" | "model">;

type CompanionRuntime = {
  connect?: typeof connect;
  spawn?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
  socketPath?: string;
  command?: string;
};

function readPersistedEnabled(): boolean {
  return readGlobalExtensionSettings<CompanionSettings>(COMPANION_SETTINGS_KEY).enabled === true;
}

function persistEnabled(enabled: boolean): void {
  updateGlobalExtensionSettings<CompanionSettings>(COMPANION_SETTINGS_KEY, (current) => ({
    ...current,
    enabled,
  }));
}

function setStatus(ctx: StatusContext, enabled: boolean): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(COMPANION_STATUS_KEY, enabled ? COMPANION_STATUS_ON : undefined);
}

function notifyEnableResult(ctx: StatusContext, connected: boolean): void {
  notifyIfUI(
    ctx,
    connected ? "Companion を有効化しました。" : "Companion の起動に失敗しました。",
    connected ? "info" : "error",
  );
}

function contextPercent(ctx: ContextUsageContext): number | undefined {
  const usage = ctx.getContextUsage() as ContextUsageLike | undefined;
  if (!usage) return undefined;

  if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
    return Math.round(usage.percent);
  }

  const window = (ctx.model as ModelLike | undefined)?.contextWindow;
  if (
    typeof usage.tokens === "number" &&
    Number.isFinite(usage.tokens) &&
    typeof window === "number" &&
    Number.isFinite(window) &&
    window > 0
  ) {
    return Math.round((usage.tokens / window) * 100);
  }

  return undefined;
}

function projectName(cwd: string): string {
  return basename(cwd.replace(/\/+$/, "")) || cwd || "pi";
}

function truncateDetail(value: string | undefined, max = DETAIL_MAX): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function detailFromArgs(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function companionStatusForTool(
  toolName: string,
  args: unknown,
): { status: CompanionStatus; detail?: string } {
  switch (toolName) {
    case "read":
      return { status: "reading", detail: basename(detailFromArgs(args, ["path"]) ?? "") };
    case "edit":
    case "write":
      return { status: "editing", detail: basename(detailFromArgs(args, ["path"]) ?? "") };
    case "bash":
      return { status: "running", detail: detailFromArgs(args, ["command"]) };
    case "grep":
    case "find":
    case "ls":
      return { status: "searching", detail: detailFromArgs(args, ["pattern", "path"]) };
    default:
      return { status: "running", detail: toolName };
  }
}

export default function companionExtension(pi: ExtensionAPI, runtime: CompanionRuntime = {}): void {
  const connectSocket = runtime.connect ?? connect;
  const spawnProcess = runtime.spawn ?? spawn;
  const sleep =
    runtime.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const socketPath = runtime.socketPath ?? SOCKET_PATH;
  const command = runtime.command ?? COMPANION_COMMAND;
  let enabled = readPersistedEnabled();
  let sock: Socket | undefined;
  let startupPromise: Promise<boolean> | undefined;
  let removeTimer: ReturnType<typeof setTimeout> | undefined;
  let statusVersion = 0;
  let lastStatus = "";
  let lastCtx: ContextUsageContext | undefined;
  let project = projectName(process.cwd());

  function send(status: CompanionStatus, detail?: string): void {
    statusVersion++;
    lastStatus = status;
    if (!sock || sock.destroyed) return;

    const message: Record<string, unknown> = {
      id: SESSION_ID,
      project,
      status,
      detail: truncateDetail(detail),
    };
    if (lastCtx) {
      const percent = contextPercent(lastCtx);
      if (percent !== undefined) message.contextPercent = percent;
    }
    sock.write(`${JSON.stringify(message)}\n`);
  }

  function sendRemove(): void {
    statusVersion++;
    if (!sock || sock.destroyed) return;
    sock.write(`${JSON.stringify({ id: SESSION_ID, type: "remove" })}\n`);
    lastStatus = "";
  }

  function connectToCompanion(): Promise<boolean> {
    return new Promise((resolve) => {
      const nextSocket = connectSocket(socketPath, () => {
        if (sock && sock !== nextSocket && !sock.destroyed) sock.end();
        sock = nextSocket;
        resolve(true);
      });
      nextSocket.once("error", () => {
        if (sock === nextSocket) sock = undefined;
        resolve(false);
      });
      nextSocket.on("close", () => {
        if (sock === nextSocket) sock = undefined;
      });
    });
  }

  function startCompanionProcess(): ChildProcess {
    const child = spawnProcess(command, [COMPANION_PATH], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return child;
  }

  async function startAndConnect(): Promise<boolean> {
    let spawnFailed = false;
    const child = startCompanionProcess();
    child.once("error", () => {
      spawnFailed = true;
    });

    for (let attempt = 0; attempt < 20; attempt++) {
      if (spawnFailed) return false;
      await sleep(100);
      if (await connectToCompanion()) return true;
    }
    return false;
  }

  async function ensureConnected(): Promise<boolean> {
    if (sock && !sock.destroyed) return true;
    if (await connectToCompanion()) return true;
    startupPromise ??= startAndConnect().finally(() => {
      startupPromise = undefined;
    });
    return startupPromise;
  }

  function disconnect(): void {
    sendRemove();
    if (sock && !sock.destroyed) sock.end();
    sock = undefined;
    lastStatus = "";
    if (removeTimer) clearTimeout(removeTimer);
    removeTimer = undefined;
  }

  async function enable(ctx: StatusContext): Promise<boolean> {
    const connected = await ensureConnected();
    if (!connected) {
      enabled = false;
      persistEnabled(false);
      setStatus(ctx, false);
      return false;
    }
    enabled = true;
    persistEnabled(true);
    setStatus(ctx, true);
    return true;
  }

  function disable(ctx: StatusContext): void {
    enabled = false;
    persistEnabled(false);
    disconnect();
    setStatus(ctx, false);
  }

  pi.registerCommand("companion", {
    description: "Control the Glimpse cursor companion overlay",
    handler: async (args, ctx) => {
      const command = args.trim() || "toggle";

      if (command === "on") {
        notifyEnableResult(ctx, await enable(ctx));
        return;
      }

      if (command === "off") {
        disable(ctx);
        notifyIfUI(ctx, "Companion を無効化しました。", "info");
        return;
      }

      if (command === "toggle") {
        if (enabled) {
          disable(ctx);
          notifyIfUI(ctx, "Companion を無効化しました。", "info");
        } else {
          notifyEnableResult(ctx, await enable(ctx));
        }
        return;
      }

      if (command === "status") {
        setStatus(ctx, enabled);
        notifyIfUI(ctx, enabled ? "Companion は有効です。" : "Companion は無効です。", "info");
        return;
      }

      notifyIfUI(ctx, USAGE, "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = readPersistedEnabled();
    project = projectName(ctx.cwd);
    if (enabled) await enable(ctx);
    else setStatus(ctx, false);
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    await ensureConnected();
    send("starting");
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    send("done");
    const removeVersion = statusVersion;
    if (removeTimer) clearTimeout(removeTimer);
    removeTimer = setTimeout(() => {
      if (lastStatus === "done" && statusVersion === removeVersion) sendRemove();
    }, 3000);
  });

  pi.on("message_update", async (_event, ctx) => {
    if (!enabled || lastStatus === "thinking") return;
    lastCtx = ctx;
    send("thinking");
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!enabled) return;
    lastCtx = ctx;
    const { status, detail } = companionStatusForTool(event.toolName, event.args);
    send(status, detail);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!enabled || !event.isError) return;
    lastCtx = ctx;
    send("error", event.toolName);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disconnect();
    setStatus(ctx, false);
  });
}
