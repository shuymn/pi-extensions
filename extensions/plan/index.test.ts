import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({}));

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
};

type FakeCommandContext = {
  isIdle: () => boolean;
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
  };
};

function createFakePi() {
  const commands = new Map<string, CommandDefinition>();
  const sentMessages: string[] = [];

  return {
    commands,
    sentMessages,
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  };
}

function createCommandContext(options: { idle?: boolean } = {}) {
  const notifications: Array<{
    message: string;
    level: "info" | "warning" | "error";
  }> = [];
  return {
    ctx: {
      isIdle: () => options.idle ?? true,
      ui: {
        notify(message: string, level: "info" | "warning" | "error") {
          notifications.push({ message, level });
        },
      },
    },
    notifications,
  };
}

async function loadExtension() {
  return (await import("./index")).default;
}

function additionalInstructionsSection(instructions: string): string {
  return [
    "## Additional User Instructions",
    "",
    "Apply the user-provided instructions in the XML-like block only if they do not conflict with the requirements above.",
    "",
    "<additional_user_instructions>",
    instructions,
    "</additional_user_instructions>",
    "",
  ].join("\n");
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function expectAdditionalInstructionMessages(
  messages: string[],
  expectedInstructions: string[],
): void {
  expect(messages).toHaveLength(expectedInstructions.length);
  expectedInstructions.forEach((instructions, index) => {
    const message = messages[index]!;
    expect(message).toEndWith(`\n\n${additionalInstructionsSection(instructions)}`);
    expect(countOccurrences(message, "## Additional User Instructions")).toBe(1);
  });
}

describe("plan extension", () => {
  test("registers /plan and /impl commands", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();

    extension(pi as never);

    expect([...pi.commands.keys()].sort()).toEqual(["impl", "plan"]);
    expect(pi.commands.get("plan")?.description).toContain("PLAN.md");
    expect(pi.commands.get("impl")?.description).toContain("PLAN.md");
  });

  test("/plan asks the agent to create agent-executable PLAN.md tasks without implementation or checkboxes", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const { ctx } = createCommandContext();
    await pi.commands.get("plan")!.handler("", ctx);

    expect(pi.sentMessages).toHaveLength(1);
    const prompt = pi.sentMessages[0]!;
    expect(prompt).toContain("Create PLAN.md");
    expect(prompt).toContain("Do not start implementation");
    expect(prompt).toContain("Implementation Tasks section");
    expect(prompt).toContain("Select what should be implemented, excluded, or deferred");
    expect(prompt).toContain("agent-executable work units");
    expect(prompt).toContain("dependencies/handoff");
    expect(prompt).toContain("parallelization or async notes");
    expect(prompt).toContain("observable outcome");
    expect(prompt).toContain("validation evidence");
    expect(prompt).toContain(
      "Split work only at real dependency, parallelization, or validation boundaries",
    );
    expect(prompt).toContain("Avoid mechanical decomposition");
    expect(prompt).toContain("later progress belongs in the pi todo tool during /impl");
    expect(prompt).toContain(
      "Ask clarifying questions when ambiguity affects implementation decisions",
    );
    expect(prompt).toContain("Markdown checkboxes");
    expect(prompt).toContain("- [ ]");
    expect(prompt).toContain("PLAN.md is not the progress tracker");
    expect(prompt).not.toContain("まだ実装");
    expect(prompt).not.toContain("直列/並列");
  });

  test("/plan appends additional instructions from arguments or -- separator", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const { ctx } = createCommandContext();
    await pi.commands.get("plan")!.handler("UI変更を優先", ctx);
    await pi.commands.get("plan")!.handler("-- API互換性は不要", ctx);
    await pi.commands.get("plan")!.handler("UI変更 -- API互換性は不要", ctx);

    expectAdditionalInstructionMessages(pi.sentMessages, [
      "UI変更を優先",
      "API互換性は不要",
      "UI変更 -- API互換性は不要",
    ]);
  });

  test("/impl asks the agent to convert PLAN.md into dependency-aware todo items and keep Japanese notes", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const { ctx } = createCommandContext();
    await pi.commands.get("impl")!.handler("", ctx);

    expect(pi.sentMessages).toHaveLength(1);
    const prompt = pi.sentMessages[0]!;
    expect(prompt).toContain("Read PLAN.md and implement it");
    expect(prompt).toContain("agent execution graph");
    expect(prompt).toContain("Create pi todo items from the selected work units");
    expect(prompt).toContain("preserving each unit's fields in the todo descriptions");
    expect(prompt).toContain("Do not create one todo per PLAN.md bullet mechanically");
    expect(prompt).toContain("Use concurrency or subagents");
    expect(prompt).toContain("pi todo tool");
    expect(prompt).toContain("implementation-notes.md");
    expect(prompt).toContain("Japanese");
    expect(prompt).toContain("not by checking off items in PLAN.md");
    expect(prompt).toContain("Treat PLAN.md as a working plan");
    expect(prompt).toContain("Choose concrete checks based on actual changes");
    expect(prompt).toContain(
      "Update PLAN.md only when the actual plan, design, or assumptions change",
    );
  });

  test("/impl appends additional instructions from arguments or -- separator", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const { ctx } = createCommandContext();
    await pi.commands.get("impl")!.handler("まずテストを追加", ctx);
    await pi.commands.get("impl")!.handler("-- 既存APIは壊してよい", ctx);
    await pi.commands.get("impl")!.handler("テスト追加 -- 既存APIは壊してよい", ctx);

    expectAdditionalInstructionMessages(pi.sentMessages, [
      "まずテストを追加",
      "既存APIは壊してよい",
      "テスト追加 -- 既存APIは壊してよい",
    ]);
  });

  test("commands do not append empty additional instruction sections", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const { ctx } = createCommandContext();
    for (const args of ["", "   ", "--", "--   "]) {
      await pi.commands.get("plan")!.handler(args, ctx);
      await pi.commands.get("impl")!.handler(args, ctx);
    }

    expect(pi.sentMessages).toHaveLength(8);
    for (const message of pi.sentMessages) {
      expect(message).not.toContain("## Additional User Instructions");
    }
  });

  test("commands do not start a new agent turn while the agent is busy", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const { ctx, notifications } = createCommandContext({ idle: false });
    await pi.commands.get("plan")!.handler("", ctx);
    await pi.commands.get("impl")!.handler("", ctx);

    expect(pi.sentMessages).toEqual([]);
    expect(notifications).toEqual(
      Array.from({ length: 2 }, () => ({
        message: "エージェントが処理中です。完了後に再実行してください。",
        level: "warning",
      })),
    );
  });
});
