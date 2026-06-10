import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolateEnvVars } from "../../tests/support/env";
import agmsgPiExtension, { agmsgPiTestInternals } from "./index";

const ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;

type FakeTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
};

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function createFakePi(fakeOptions: { failSendUserMessage?: boolean } = {}) {
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const handlers = new Map<string, Handler[]>();
  const sentUserMessages: Array<{ content: string; options?: unknown }> = [];

  return {
    tools,
    commands,
    handlers,
    sentUserMessages,
    registerTool(tool: FakeTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, command);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendUserMessage(content: string, options?: unknown) {
      if (fakeOptions.failSendUserMessage) throw new Error("send failed");
      sentUserMessages.push({ content, options });
    },
  };
}

function createContext(cwd: string, sessionFile?: string, idle = true) {
  const notifications: Array<{ message: string; level?: string }> = [];
  return {
    cwd,
    notifications,
    hasUI: true,
    isIdle() {
      return idle;
    },
    sessionManager: {
      getSessionFile() {
        return sessionFile;
      },
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };
}

describe("agmsg-pi extension", () => {
  isolateEnvVars(ENV_KEYS);

  let tempDir: string;
  let agentDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-agmsg-extension-"));
    agentDir = join(tempDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("sends a message between two pi sessions and marks inbox messages read", async () => {
    const alice = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "alice.jsonl") };
    const bob = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "bob.jsonl") };

    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "join",
      team: "dev",
      agent: "alice",
    });
    await agmsgPiTestInternals.runAgmsgPi(bob, { action: "join", team: "dev", agent: "bob" });
    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "send",
      to: "bob",
      message: "review this patch",
    });

    const inbox = await agmsgPiTestInternals.runAgmsgPi(bob, { action: "inbox" });
    expect(textOf(inbox)).toContain("alice -> bob: review this patch");
    expect(textOf(inbox)).not.toContain("(unread)");

    const secondInbox = await agmsgPiTestInternals.runAgmsgPi(bob, { action: "inbox" });
    expect(textOf(secondInbox)).toBe("Inbox:\nNo messages.");
  });

  test("uses the pi session file to distinguish identities in the same project", async () => {
    const cwd = join(tempDir, "project");
    const alice = { cwd, sessionFile: join(tempDir, "alice.jsonl") };
    const bob = { cwd, sessionFile: join(tempDir, "bob.jsonl") };

    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "join",
      team: "same-project",
      agent: "alice",
    });
    await agmsgPiTestInternals.runAgmsgPi(bob, {
      action: "join",
      team: "same-project",
      agent: "bob",
    });

    const team = await agmsgPiTestInternals.runAgmsgPi(alice, { action: "team" });

    expect(textOf(team)).toContain("- alice:");
    expect(textOf(team)).toContain("- bob:");
  });

  test("auto-delivers unread messages by injecting a user message", async () => {
    const alice = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "alice.jsonl") };
    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "join",
      team: "dev",
      agent: "alice",
    });
    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "send",
      to: "bob",
      message: "please review",
    });
    const pi = createFakePi();
    const bob = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "bob.jsonl") };
    await agmsgPiTestInternals.runAgmsgPi(bob, { action: "join", team: "dev", agent: "bob" });

    const delivered = await agmsgPiTestInternals.deliverUnreadMessages(pi, bob);

    expect(delivered).toHaveLength(1);
    expect(pi.sentUserMessages).toEqual([
      {
        content:
          "agmsg-pi received message(s). Act on them now, then reply or send agmsg_pi messages as needed.\n\nFrom alice at " +
          delivered[0]?.createdAt +
          ":\nplease review",
        options: { deliverAs: "followUp" },
      },
    ]);
    const inbox = await agmsgPiTestInternals.runAgmsgPi(bob, { action: "inbox" });
    expect(textOf(inbox)).toBe("Inbox:\nNo messages.");
  });

  test("auto-delivery does not mark messages read when guarded or send fails", async () => {
    const alice = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "alice.jsonl") };
    const bob = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "bob.jsonl") };
    await agmsgPiTestInternals.runAgmsgPi(alice, { action: "join", team: "dev", agent: "alice" });
    await agmsgPiTestInternals.runAgmsgPi(bob, { action: "join", team: "dev", agent: "bob" });
    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "send",
      to: "bob",
      message: "do not lose this",
    });

    const guarded = await agmsgPiTestInternals.deliverUnreadMessages(
      createFakePi(),
      bob,
      () => false,
    );
    expect(guarded).toEqual([]);
    let inbox = await agmsgPiTestInternals.runAgmsgPi(bob, { action: "inbox" });
    expect(textOf(inbox)).toContain("do not lose this");

    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "send",
      to: "bob",
      message: "send can fail",
    });
    await expect(
      agmsgPiTestInternals.deliverUnreadMessages(createFakePi({ failSendUserMessage: true }), bob),
    ).rejects.toThrow("send failed");
    inbox = await agmsgPiTestInternals.runAgmsgPi(bob, { action: "inbox" });
    expect(textOf(inbox)).toContain("send can fail");
  });

  test("auto-poll does not deliver while the agent is busy", async () => {
    const alice = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "alice.jsonl") };
    const bob = { cwd: join(tempDir, "project"), sessionFile: join(tempDir, "bob.jsonl") };
    await agmsgPiTestInternals.runAgmsgPi(alice, { action: "join", team: "dev", agent: "alice" });
    await agmsgPiTestInternals.runAgmsgPi(bob, { action: "join", team: "dev", agent: "bob" });
    await agmsgPiTestInternals.runAgmsgPi(alice, {
      action: "send",
      to: "bob",
      message: "wait until idle",
    });
    const pi = createFakePi();
    agmsgPiExtension(pi as never);
    const busyCtx = createContext(bob.cwd, bob.sessionFile, false);

    await pi.handlers.get("session_start")?.[0]?.({}, busyCtx);
    await Promise.resolve();
    await pi.handlers.get("session_shutdown")?.[0]?.({}, busyCtx);

    expect(pi.sentUserMessages).toEqual([]);
    const inbox = await agmsgPiTestInternals.runAgmsgPi(bob, { action: "inbox" });
    expect(textOf(inbox)).toContain("wait until idle");
  });

  test("session lifecycle starts and stops auto-delivery polling", async () => {
    const pi = createFakePi();
    agmsgPiExtension(pi as never);
    const tool = pi.tools.get("agmsg_pi");
    const ctx = createContext(join(tempDir, "project"), join(tempDir, "session.jsonl"));

    await tool?.execute(
      "tool-call",
      { action: "join", team: "ops", agent: "watcher" },
      undefined,
      undefined,
      ctx,
    );
    await pi.handlers.get("session_shutdown")?.[0]?.({}, ctx);

    expect(pi.handlers.get("session_start")).toHaveLength(1);
    expect(pi.handlers.get("session_shutdown")).toHaveLength(1);
  });

  test("registers an LLM tool and slash command", async () => {
    const pi = createFakePi();
    agmsgPiExtension(pi as never);
    const tool = pi.tools.get("agmsg_pi");
    const command = pi.commands.get("agmsg");
    const ctx = createContext(join(tempDir, "project"), join(tempDir, "session.jsonl"));

    expect(tool).toBeDefined();
    expect(command).toBeDefined();

    await tool?.execute(
      "tool-call",
      { action: "join", team: "ops", agent: "watcher" },
      undefined,
      undefined,
      ctx,
    );
    const whoami = await tool?.execute(
      "tool-call",
      { action: "whoami" },
      undefined,
      undefined,
      ctx,
    );
    expect(whoami && textOf(whoami)).toBe("You are watcher in team ops.");

    await command?.handler("whoami", ctx);
    expect(ctx.notifications).toEqual([{ message: "You are watcher in team ops.", level: "info" }]);
  });
});
