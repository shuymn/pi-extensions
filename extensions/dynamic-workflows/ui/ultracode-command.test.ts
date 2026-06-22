import { describe, expect, test } from "bun:test";
import { createFakeUi } from "../../../tests/support/fake-ui";
import {
  parseUltracodePolicyCommandArgs,
  registerUltracodePolicyCommand,
} from "./ultracode-command";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

type EventHandler = (event: unknown, ctx: unknown) => unknown;

function createCommandPi() {
  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, EventHandler[]>();
  return {
    commands,
    events,
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    on(name: string, handler: EventHandler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
  };
}

function beforeAgentStart(pi: ReturnType<typeof createCommandPi>, systemPrompt = "base prompt") {
  return pi.events.get("before_agent_start")![0]!({ systemPrompt }, { ui: createFakeUi() });
}

describe("/ultracode policy command", () => {
  test("parses on, off, and status actions", () => {
    expect(parseUltracodePolicyCommandArgs("")).toBe("status");
    expect(parseUltracodePolicyCommandArgs("status")).toBe("status");
    expect(parseUltracodePolicyCommandArgs("on")).toBe("on");
    expect(parseUltracodePolicyCommandArgs("enable")).toBe("on");
    expect(parseUltracodePolicyCommandArgs("off")).toBe("off");
    expect(parseUltracodePolicyCommandArgs("disable")).toBe("off");
    expect(parseUltracodePolicyCommandArgs("maybe")).toBeUndefined();
  });

  test("is disabled by default and injects policy only after explicit enable", async () => {
    const pi = createCommandPi();
    const ui = createFakeUi();
    registerUltracodePolicyCommand(pi as never);

    expect([...pi.commands.keys()]).toEqual(["ultracode"]);
    expect(beforeAgentStart(pi)).toBeUndefined();

    await pi.commands.get("ultracode")!.handler("on", { ui });
    const result = beforeAgentStart(pi) as { systemPrompt: string };

    expect(ui.notifications).toEqual([
      {
        level: "info",
        message: "/ultracode: policy mode を有効化しました。",
      },
    ]);
    expect(result.systemPrompt).toContain("base prompt");
    expect(result.systemPrompt).toContain("ultracode policy mode is ON");
    expect(result.systemPrompt).toContain("workflow tool");
    expect(result.systemPrompt).toContain("not automatically selected");
    expect(result.systemPrompt).toContain("architect/conductor");
    expect(result.systemPrompt).toContain("two axes");
    expect(result.systemPrompt).toContain("multi-stage, data-dependent orchestration");
    expect(result.systemPrompt).toContain("independent lenses");
    expect(result.systemPrompt).toContain("tens of agents");
  });

  test("reports status, rejects invalid args, disables mode, and resets on session start", async () => {
    const pi = createCommandPi();
    const ui = createFakeUi();
    registerUltracodePolicyCommand(pi as never);
    const command = pi.commands.get("ultracode")!;

    await command.handler("", { ui });
    await command.handler("nope", { ui });
    await command.handler("enable", { ui });
    await command.handler("status", { ui });
    await command.handler("disable", { ui });
    expect(beforeAgentStart(pi)).toBeUndefined();

    await command.handler("on", { ui });
    expect(beforeAgentStart(pi)).toBeDefined();
    pi.events.get("session_start")![0]!({ type: "session_start" }, { ui });
    expect(beforeAgentStart(pi)).toBeUndefined();

    expect(ui.notifications).toEqual([
      {
        level: "info",
        message: "/ultracode: policy mode は無効です。",
      },
      {
        level: "error",
        message: "使い方: /ultracode <on|off|status>",
      },
      {
        level: "info",
        message: "/ultracode: policy mode を有効化しました。",
      },
      {
        level: "info",
        message: "/ultracode: policy mode は有効です。",
      },
      {
        level: "info",
        message: "/ultracode: policy mode を無効化しました。",
      },
      {
        level: "info",
        message: "/ultracode: policy mode を有効化しました。",
      },
    ]);
  });
});
