import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolateEnvVars } from "../../tests/support/env";
import { createFakePi as createSharedFakePi } from "../../tests/support/fake-pi";
import companionExtension, { companionStatusForTool } from "./index";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: FakeContext) => Promise<void> | void;
};

type FakeContext = {
  hasUI: boolean;
  cwd: string;
  getContextUsage: () => undefined;
  model: Record<string, never>;
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
};

function createFakePi() {
  return createSharedFakePi<never, CommandDefinition>();
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: string[] = [];

  write(data: string) {
    this.writes.push(data);
    return true;
  }

  end() {
    this.destroyed = true;
  }
}

class FakeChild extends EventEmitter {
  unref() {}
}

function createContext() {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx: FakeContext = {
    hasUI: true,
    cwd: "/work/project",
    getContextUsage: () => undefined,
    model: {},
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.set(key, value);
      },
    },
  };

  return { ctx, notifications, statuses };
}

describe("companion extension", () => {
  let tempAgentDir: string;

  isolateEnvVars(["PI_CODING_AGENT_DIR"]);

  beforeEach(() => {
    tempAgentDir = mkdtempSync(join(tmpdir(), "companion-agent-test-"));
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  });

  afterEach(() => {
    rmSync(tempAgentDir, { recursive: true, force: true });
  });

  test("registers /companion and lifecycle listeners", () => {
    const pi = createFakePi();

    companionExtension(pi as never);

    expect(pi.getCommand("companion")?.description).toBe(
      "Control the Glimpse cursor companion overlay",
    );
    expect(pi.getEventHandlers("agent_start")).toHaveLength(1);
    expect(pi.getEventHandlers("tool_execution_start")).toHaveLength(1);
    expect(pi.getEventHandlers("session_shutdown")).toHaveLength(1);
  });

  test("/companion status reports persisted disabled state without spawning companion", async () => {
    const pi = createFakePi();
    companionExtension(pi as never);
    const { ctx, notifications, statuses } = createContext();

    await pi.getCommand("companion")!.handler("status", ctx);

    expect(notifications).toEqual([{ message: "Companion は無効です。", level: "info" }]);
    expect(statuses.get("companion")).toBeUndefined();
  });

  test("/companion off persists disabled state and clears status", async () => {
    writeFileSync(
      join(tempAgentDir, "settings.json"),
      JSON.stringify({ companion: { enabled: true, keep: "value" } }),
    );
    const pi = createFakePi();
    companionExtension(pi as never);
    const { ctx, notifications, statuses } = createContext();

    await pi.getCommand("companion")!.handler("off", ctx);

    expect(notifications).toEqual([{ message: "Companion を無効化しました。", level: "info" }]);
    expect(statuses.get("companion")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      companion: { enabled: false, keep: "value" },
    });
  });

  test("rejects unknown arguments", async () => {
    const pi = createFakePi();
    companionExtension(pi as never);
    const { ctx, notifications } = createContext();

    await pi.getCommand("companion")!.handler("maybe", ctx);

    expect(notifications).toEqual([
      { message: "使い方: /companion [on|off|toggle|status]", level: "error" },
    ]);
  });

  test("/companion on does not persist enabled when startup fails", async () => {
    const pi = createFakePi();
    companionExtension(pi as never, {
      connect: (() => {
        const socket = new FakeSocket();
        queueMicrotask(() => socket.emit("error", new Error("missing socket")));
        return socket;
      }) as never,
      spawn: (() => {
        const child = new FakeChild();
        queueMicrotask(() => child.emit("error", new Error("missing bun")));
        return child;
      }) as never,
      sleep: async () => {},
    });
    const { ctx, notifications, statuses } = createContext();

    await pi.getCommand("companion")!.handler("on", ctx);

    expect(notifications).toEqual([
      { message: "Companion の起動に失敗しました。", level: "error" },
    ]);
    expect(statuses.get("companion")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      companion: { enabled: false },
    });
  });

  test("sends truncated tool details to companion", async () => {
    const socket = new FakeSocket();
    const pi = createFakePi();
    companionExtension(pi as never, {
      connect: ((_: string, listener: () => void) => {
        queueMicrotask(listener);
        return socket;
      }) as never,
    });
    const { ctx } = createContext();

    await pi.getCommand("companion")!.handler("on", ctx);
    await pi.getEventHandlers("tool_execution_start")[0]!(
      { toolName: "bash", args: { command: "x".repeat(100) } },
      ctx,
    );

    const payload = JSON.parse(socket.writes.at(-1) ?? "{}");
    expect(payload.detail).toBe(`${"x".repeat(59)}…`);
  });

  test("maps tool execution to companion status", () => {
    expect(companionStatusForTool("read", { path: "/tmp/file.ts" })).toEqual({
      status: "reading",
      detail: "file.ts",
    });
    expect(companionStatusForTool("edit", { path: "/tmp/file.ts" })).toEqual({
      status: "editing",
      detail: "file.ts",
    });
    expect(companionStatusForTool("bash", { command: "bun test" })).toEqual({
      status: "running",
      detail: "bun test",
    });
    expect(companionStatusForTool("grep", { pattern: "TODO" })).toEqual({
      status: "searching",
      detail: "TODO",
    });
    expect(companionStatusForTool("review", {})).toEqual({ status: "running", detail: "review" });
  });
});
