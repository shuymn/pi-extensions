import { describe, expect, test } from "bun:test";
import { createFakeUi } from "../../tests/support/fake-ui";
import { registerInvokeCommand } from "./index";
import type { InvokeOperation } from "./operations";

type CommandDefinition = {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => unknown[] | null;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
};

type FakeCommandContext = {
  isIdle: () => boolean;
  ui: ReturnType<typeof createFakeUi>;
};

function createPi() {
  const commands = new Map<string, CommandDefinition>();
  return {
    commands,
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
  };
}

function createContext(options: { idle?: boolean } = {}): FakeCommandContext {
  return {
    isIdle: () => options.idle ?? true,
    ui: createFakeUi(),
  };
}

describe("invoke extension", () => {
  test("registers only the /invoke command for runtime invocation", () => {
    const pi = createPi();

    registerInvokeCommand(pi as never);

    expect([...pi.commands.keys()]).toEqual(["invoke"]);
    expect(pi.commands.has("reload-runtime")).toBe(false);
    expect(pi.commands.has("reload_runtime")).toBe(false);
    expect(pi.commands.get("invoke")?.description).toContain("allowlisted runtime operation");
  });

  test("dispatches allowlisted operations with parsed JSON args", async () => {
    const calls: unknown[] = [];
    const operation: InvokeOperation = {
      name: "runtime.example",
      description: "Example operation",
      handler: (args) => {
        calls.push(args);
      },
    };
    const pi = createPi();
    registerInvokeCommand(pi as never, { operations: [operation] });
    const ctx = createContext();

    await pi.commands.get("invoke")!.handler('/runtime.example {"value":42}', ctx);

    expect(calls).toEqual([{ value: 42 }]);
    expect(ctx.ui.notifications).toEqual([]);
  });

  test("rejects unknown operations without executing arbitrary slash commands", async () => {
    const calls: unknown[] = [];
    const pi = createPi();
    registerInvokeCommand(pi as never, {
      operations: [
        {
          name: "runtime.example",
          handler: () => {
            calls.push("called");
          },
        },
      ],
    });
    const ctx = createContext();

    await pi.commands.get("invoke")!.handler("/reload", ctx);

    expect(calls).toEqual([]);
    expect(ctx.ui.notifications).toEqual([
      { level: "error", message: "未対応の invoke operation です: reload" },
    ]);
  });

  test("reports usage, invalid JSON, and busy state in Japanese", async () => {
    const calls: unknown[] = [];
    const pi = createPi();
    registerInvokeCommand(pi as never, {
      operations: [
        {
          name: "runtime.example",
          handler: () => {
            calls.push("called");
          },
        },
      ],
    });
    const command = pi.commands.get("invoke")!;
    const ctx = createContext();
    const busyCtx = createContext({ idle: false });

    await command.handler("", ctx);
    await command.handler("runtime.example {bad", ctx);
    await command.handler("runtime.example", busyCtx);

    expect(calls).toEqual([]);
    expect(ctx.ui.notifications).toEqual([
      { level: "error", message: "使い方: /invoke <operation> [JSON args]" },
      {
        level: "error",
        message: expect.stringContaining("args は JSON として指定してください") as never,
      },
    ]);
    expect(busyCtx.ui.notifications).toEqual([
      { level: "warning", message: "エージェントが処理中です。完了後に再実行してください。" },
    ]);
  });

  test("completes only allowlisted operation names before args", () => {
    const pi = createPi();
    registerInvokeCommand(pi as never, {
      operations: [
        { name: "runtime.reload", description: "Reload runtime", handler: () => undefined },
        { name: "runtime.example", handler: () => undefined },
      ],
    });
    const complete = pi.commands.get("invoke")!.getArgumentCompletions!;

    expect(complete("/runtime.r")).toEqual([
      { value: "runtime.reload", label: "runtime.reload", description: "Reload runtime" },
    ]);
    expect(complete("runtime.reload {")).toBeNull();
  });
});
