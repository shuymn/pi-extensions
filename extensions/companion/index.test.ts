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
  isIdle: () => boolean;
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

function createDeferredConnections() {
  const connections: Array<{ socket: FakeSocket; listener: () => void }> = [];
  return {
    connections,
    connect: ((_: string, listener: () => void) => {
      const socket = new FakeSocket();
      connections.push({ socket, listener });
      return socket;
    }) as never,
  };
}

function createContext(idle = true) {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx: FakeContext = {
    hasUI: true,
    cwd: "/work/project",
    getContextUsage: () => undefined,
    model: {},
    isIdle: () => idle,
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
    expect(pi.getEventHandlers("agent_settled")).toHaveLength(1);
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

  test("/companion on retains enabled intent after startup failure and recovers at agent_start", async () => {
    let available = false;
    const sockets: FakeSocket[] = [];
    const pi = createFakePi();
    companionExtension(pi as never, {
      connect: ((_: string, listener: () => void) => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => {
          if (available) listener();
          else socket.emit("error", new Error("missing socket"));
        });
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
    expect(statuses.get("companion")).toBe("G ·");
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      companion: { enabled: true },
    });

    available = true;
    await pi.getEventHandlers("agent_start")[0]!({}, ctx);
    expect(JSON.parse(sockets.at(-1)!.writes.at(-1)!).status).toBe("starting");
    await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
  });

  test.each([
    "agent_start",
    "session_start",
  ])("persisted enable survives bounded socket startup failure and recovers at %s", async (recoveryEvent) => {
    const settings = { companion: { enabled: true, keep: "value" } };
    writeFileSync(join(tempAgentDir, "settings.json"), JSON.stringify(settings));
    let available = false;
    let connectCount = 0;
    let spawnCount = 0;
    let sleepCount = 0;
    const recoveredSocket = new FakeSocket();
    const pi = createFakePi();
    companionExtension(pi as never, {
      connect: ((_: string, listener: () => void) => {
        connectCount++;
        const socket = available ? recoveredSocket : new FakeSocket();
        queueMicrotask(() => {
          if (available) listener();
          else socket.emit("error", new Error("transient socket failure"));
        });
        return socket;
      }) as never,
      spawn: (() => {
        spawnCount++;
        return new FakeChild();
      }) as never,
      sleep: async () => {
        sleepCount++;
      },
    });
    const { ctx, statuses } = createContext();

    await pi.getEventHandlers("session_start")[0]!({}, ctx);
    expect(connectCount).toBe(21);
    expect(spawnCount).toBe(1);
    expect(sleepCount).toBe(20);
    expect(statuses.get("companion")).toBe("G ·");
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual(settings);

    available = true;
    await pi.getEventHandlers(recoveryEvent)[0]!({}, ctx);
    await pi.getEventHandlers("tool_execution_start")[0]!(
      { toolName: "read", args: { path: "/tmp/recovered.ts" } },
      ctx,
    );
    expect(connectCount).toBe(22);
    expect(spawnCount).toBe(1);
    expect(JSON.parse(recoveredSocket.writes.at(-1)!).status).toBe("reading");
    await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
  });

  test("/companion off invalidates a late connection and keeps lifecycle events disabled", async () => {
    const pi = createFakePi();
    const runtime = createDeferredConnections();
    companionExtension(pi as never, runtime);
    const { ctx, statuses, notifications } = createContext();
    const enabling = pi.getCommand("companion")!.handler("on", ctx);

    await pi.getCommand("companion")!.handler("off", ctx);
    runtime.connections[0]!.listener();
    await enabling;
    await pi.getEventHandlers("agent_start")[0]!({}, ctx);
    await pi.getEventHandlers("session_start")[0]!({}, ctx);

    expect(runtime.connections).toHaveLength(1);
    expect(runtime.connections[0]!.socket.destroyed).toBe(true);
    expect(runtime.connections[0]!.socket.writes).toEqual([]);
    expect(statuses.get("companion")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      companion: { enabled: false },
    });
    expect(notifications.some(({ message }) => message === "Companion を有効化しました。")).toBe(
      false,
    );
  });

  test("shutdown invalidates late startup without losing persisted intent for the next session", async () => {
    writeFileSync(
      join(tempAgentDir, "settings.json"),
      JSON.stringify({ companion: { enabled: true } }),
    );
    const pi = createFakePi();
    const runtime = createDeferredConnections();
    companionExtension(pi as never, runtime);
    const { ctx, statuses } = createContext();
    const starting = pi.getEventHandlers("session_start")[0]!({}, ctx);

    await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
    runtime.connections[0]!.listener();
    await starting;
    await pi.getEventHandlers("agent_start")[0]!({}, ctx);
    expect(runtime.connections).toHaveLength(1);
    expect(runtime.connections[0]!.socket.destroyed).toBe(true);
    expect(runtime.connections[0]!.socket.writes).toEqual([]);
    expect(statuses.get("companion")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      companion: { enabled: true },
    });

    const nextSession = pi.getEventHandlers("session_start")[0]!({}, ctx);
    runtime.connections[1]!.listener();
    await nextSession;
    await pi.getEventHandlers("agent_start")[0]!({}, ctx);
    expect(statuses.get("companion")).toBe("G ·");
    expect(JSON.parse(runtime.connections[1]!.socket.writes.at(-1)!).status).toBe("starting");
    await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
  });

  test.each(["off", "shutdown"])("%s stops pending bounded startup retries", async (action) => {
    const sleeping = Promise.withResolvers<void>();
    const wake = Promise.withResolvers<void>();
    let connectCount = 0;
    let spawnCount = 0;
    const pi = createFakePi();
    companionExtension(pi as never, {
      connect: (() => {
        connectCount++;
        const socket = new FakeSocket();
        queueMicrotask(() => socket.emit("error", new Error("missing socket")));
        return socket;
      }) as never,
      spawn: (() => {
        spawnCount++;
        return new FakeChild();
      }) as never,
      sleep: async () => {
        sleeping.resolve();
        await wake.promise;
      },
    });
    const { ctx, statuses } = createContext();
    const enabling = pi.getCommand("companion")!.handler("on", ctx);
    await sleeping.promise;

    if (action === "off") await pi.getCommand("companion")!.handler("off", ctx);
    else await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
    wake.resolve();
    await enabling;

    expect(connectCount).toBe(1);
    expect(spawnCount).toBe(1);
    expect(statuses.get("companion")).toBeUndefined();
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      companion: { enabled: action !== "off" },
    });
  });

  test("a stale enable completion cannot replace or clear a newer shared connection attempt", async () => {
    const pi = createFakePi();
    const runtime = createDeferredConnections();
    companionExtension(pi as never, runtime);
    const { ctx, statuses } = createContext();
    const oldEnable = pi.getCommand("companion")!.handler("on", ctx);
    await pi.getCommand("companion")!.handler("off", ctx);
    const newEnable = pi.getCommand("companion")!.handler("on", ctx);

    runtime.connections[0]!.listener();
    await oldEnable;
    const agentStart = pi.getEventHandlers("agent_start")[0]!({}, ctx);
    expect(runtime.connections).toHaveLength(2);
    runtime.connections[1]!.listener();
    await newEnable;
    await agentStart;

    expect(runtime.connections[0]!.socket.destroyed).toBe(true);
    expect(runtime.connections[1]!.socket.destroyed).toBe(false);
    expect(statuses.get("companion")).toBe("G ·");
    expect(JSON.parse(runtime.connections[1]!.socket.writes.at(-1)!).status).toBe("starting");
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      companion: { enabled: true },
    });
    await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
  });

  test("reconnects at agent_start after an established socket closes", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    let connectCount = 0;
    const pi = createFakePi();
    companionExtension(pi as never, {
      connect: ((_: string, listener: () => void) => {
        queueMicrotask(listener);
        return sockets[connectCount++];
      }) as never,
    });
    const { ctx } = createContext();
    await pi.getCommand("companion")!.handler("on", ctx);
    sockets[0]!.end();
    sockets[0]!.emit("close");

    await pi.getEventHandlers("agent_start")[0]!({}, ctx);

    expect(connectCount).toBe(2);
    expect(JSON.parse(sockets[1]!.writes.at(-1)!).status).toBe("starting");
    await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
  });

  test("sends done status only after the agent settles", async () => {
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
    await pi.getEventHandlers("agent_start")[0]!({}, ctx);
    expect(JSON.parse(socket.writes.at(-1) ?? "{}").status).toBe("starting");

    await pi.getEventHandlers("agent_settled")[0]!({}, createContext(false).ctx);
    expect(JSON.parse(socket.writes.at(-1) ?? "{}").status).toBe("starting");

    await pi.getEventHandlers("agent_settled")[0]!({}, ctx);
    expect(JSON.parse(socket.writes.at(-1) ?? "{}").status).toBe("done");
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
