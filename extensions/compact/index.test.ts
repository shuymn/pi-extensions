import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakePi } from "../../tests/support/fake-pi";
import { createFakeUi } from "../../tests/support/fake-ui";
import compactExtension from "./index";
import { COMPACT_TOOL_NAME } from "./policy";

type Theme = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

type RenderComponent = {
  render(width: number): string[];
};

type ToolDefinition = {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: any;
  executionMode?: string;
  renderCall?: (args: unknown, theme: Theme) => RenderComponent;
  renderResult?: (result: unknown, options: unknown, theme: Theme) => RenderComponent;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: any,
  ) => Promise<any>;
};

const theme: Theme = {
  fg: (_name, text) => text,
  bold: (text) => text,
};

type CompactOptions = {
  customInstructions?: string;
  onComplete?: (result: unknown) => void;
  onError?: (error: Error) => void;
};

function writeProjectSettings(cwd: string, reserveTokens = 32_768): void {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ compaction: { reserveTokens } }),
  );
}

function createCtx({
  cwd,
  usage = { tokens: 163_136, contextWindow: 200_000 },
  compactImpl,
  hasUI = true,
}: {
  cwd: string;
  usage?: { tokens: number | null; contextWindow: number } | undefined;
  compactImpl?: (options?: CompactOptions) => void;
  hasUI?: boolean;
}) {
  const ui = createFakeUi();
  const compactCalls: CompactOptions[] = [];
  return {
    ctx: {
      cwd,
      hasUI,
      ui,
      getContextUsage: () => usage,
      compact(options?: CompactOptions) {
        compactCalls.push(options ?? {});
        compactImpl?.(options);
      },
    },
    ui,
    compactCalls,
  };
}

async function expectWarningInjectedOnce(contextHandler: any, ctx: any): Promise<void> {
  expect(await contextHandler({ messages: [] }, ctx)).toMatchObject({
    messages: expect.any(Array),
  });
  expect(await contextHandler({ messages: [] }, ctx)).toBeUndefined();
}

function renderedText(component: RenderComponent): string {
  return component
    .render(400)
    .map((line) => line.trimEnd())
    .join("\n");
}

describe("compact extension", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-compact-runtime-test-"));
    writeProjectSettings(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("registers compact_context tool and lifecycle hooks", () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);

    expect([...pi.tools.keys()]).toEqual([COMPACT_TOOL_NAME]);
    expect([...pi.commands.keys()]).toEqual([]);
    expect(pi.getEventHandlers("context")).toHaveLength(1);
    expect(pi.getEventHandlers("turn_end")).toHaveLength(1);

    const tool = pi.tools.get(COMPACT_TOOL_NAME)!;
    expect(tool.label).toBe("Compact Context");
    expect(tool.description).toContain("semantic checkpoint");
    expect(tool.promptSnippet).toContain("semantic checkpoint");
    const guidelines = tool.promptGuidelines!.join("\n");
    expect(guidelines).toContain("as the only tool");
    expect(guidelines).toContain("unfinished user-requested work remains");
    expect(guidelines).toContain("final response or completion report remains");
    expect(guidelines).toContain("stopAfterCompaction");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters.properties.customInstructions).toBeDefined();
    expect(tool.parameters.properties.continuationPrompt).toBeDefined();
    expect(tool.parameters.properties.stopAfterCompaction).toBeDefined();
    expect(tool.parameters.properties.stopAfterCompaction.description).toContain(
      "not a substitute for a final response",
    );
    expect(tool.renderCall).toBeDefined();
    expect(tool.renderResult).toBeDefined();
  });

  test("renders compact_context parameters in tool call without duplicating result details", () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    const tool = pi.tools.get(COMPACT_TOOL_NAME)!;
    const params = {
      customInstructions: "  Focus on changed\nfiles.  ",
      continuationPrompt: "  Resume verification.  ",
      stopAfterCompaction: true,
    };
    const scheduledResult = {
      content: [],
      details: {
        accepted: true,
        status: "scheduled",
        customInstructions: "Focus on changed files.",
        continuationPrompt: "Resume verification.",
        stopAfterCompaction: true,
      },
    };
    const taggedTheme: Theme = {
      fg: (name, text) => `<${name}>${text}</${name}>`,
      bold: (text) => text,
    };

    expect(renderedText(tool.renderCall!({}, theme))).toBe("compact_context");

    const callText = renderedText(tool.renderCall!(params, theme));
    expect(callText).toBe("compact_context\nFocus on changed files.");

    const taggedCallText = renderedText(tool.renderCall!(params, taggedTheme));
    expect(taggedCallText).toBe(
      "<toolTitle>compact_context</toolTitle>\n<dim>Focus on changed files.</dim>",
    );
    expect(taggedCallText).not.toContain("<muted>");

    const resultText = renderedText(tool.renderResult!(scheduledResult, undefined, theme));
    expect(resultText).toBe("");
    expect(renderedText(tool.renderResult!(scheduledResult, undefined, taggedTheme))).toBe("");

    expect(
      renderedText(
        tool.renderResult!({ content: [{ type: "text", text: "raw fallback" }] }, undefined, theme),
      ),
    ).toContain("raw fallback");
    expect(
      renderedText(
        tool.renderResult!(
          { content: [], details: { accepted: false, status: "pending" } },
          undefined,
          theme,
        ),
      ),
    ).toContain("already scheduled");
  });

  test("context hook appends a transient warning once per high-usage cycle", async () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    let usage = { tokens: 150_000, contextWindow: 200_000 };
    const { ctx } = createCtx({
      cwd: tempDir,
      usage: undefined,
    });
    ctx.getContextUsage = () => usage;
    const event = {
      messages: [{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 }],
    };
    const contextHandler = pi.getEventHandlers("context")[0]!;

    const first = await contextHandler(event, ctx);

    expect(first).toBeDefined();
    const messages = (first as any).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(event.messages[0]);
    expect(event.messages).toHaveLength(1);
    const warningText = messages[1].content[0].text;
    expect(messages[1]).toMatchObject({
      role: "user",
      content: [
        {
          type: "text",
          text: expect.stringContaining(COMPACT_TOOL_NAME),
        },
      ],
    });
    expect(warningText).toContain("Pi's built-in auto-compaction threshold");

    expect(await contextHandler(event, ctx)).toBeUndefined();

    usage = { tokens: 149_999, contextWindow: 200_000 };
    expect(await contextHandler(event, ctx)).toBeUndefined();

    usage = { tokens: 150_000, contextWindow: 200_000 };
    expect(await contextHandler(event, ctx)).toMatchObject({ messages: expect.any(Array) });
    expect(pi.sentMessages).toEqual([]);
    expect(pi.appendedEntries).toEqual([]);
  });

  test("context hook skips warning when usage is unknown or compaction is already pending", async () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    const tool = pi.tools.get(COMPACT_TOOL_NAME)!;
    const contextHandler = pi.getEventHandlers("context")[0]!;
    const event = { messages: [] };

    const unknown = createCtx({ cwd: tempDir, usage: { tokens: null, contextWindow: 200_000 } });
    expect(await contextHandler(event, unknown.ctx)).toBeUndefined();

    const pending = createCtx({ cwd: tempDir });
    await tool.execute("call", {}, undefined, undefined, pending.ctx);
    expect(await contextHandler(event, pending.ctx)).toBeUndefined();
  });

  test("compact_context schedules compaction for turn_end and suppresses duplicate requests", async () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    const tool = pi.tools.get(COMPACT_TOOL_NAME)!;
    const turnEnd = pi.getEventHandlers("turn_end")[0]!;
    const contextHandler = pi.getEventHandlers("context")[0]!;
    const { ctx, ui, compactCalls } = createCtx({ cwd: tempDir });

    await expectWarningInjectedOnce(contextHandler, ctx);

    const scheduled = await tool.execute(
      "call",
      { customInstructions: "  Focus on active implementation state.  " },
      undefined,
      undefined,
      ctx,
    );
    expect(scheduled).toMatchObject({
      terminate: true,
      details: {
        accepted: true,
        status: "scheduled",
        customInstructions: "Focus on active implementation state.",
        stopAfterCompaction: false,
      },
    });
    expect(compactCalls).toHaveLength(0);
    expect(pi.sentMessages).toEqual([]);
    expect(ui.notifications.at(-1)).toEqual({
      message: "コンテキスト圧縮を予約しました。ターン終了時に実行します。",
      level: "info",
    });

    const duplicate = await tool.execute("call", {}, undefined, undefined, ctx);
    expect(duplicate).toMatchObject({
      terminate: true,
      details: { accepted: false, status: "pending" },
    });
    expect(duplicate.content[0].text).toContain("already scheduled");
    expect(pi.sentMessages).toEqual([]);

    await turnEnd({ turnIndex: 0 }, ctx);
    expect(compactCalls).toHaveLength(1);
    expect(compactCalls[0]!.customInstructions).toBe("Focus on active implementation state.");
    expect(ui.notifications.at(-1)).toEqual({
      message: "コンテキスト圧縮を開始しました。",
      level: "info",
    });
    expect(pi.sentMessages).toEqual([]);

    await turnEnd({ turnIndex: 1 }, ctx);
    expect(compactCalls).toHaveLength(1);
    expect(await contextHandler({ messages: [] }, ctx)).toBeUndefined();

    const compactingDuplicate = await tool.execute("call", {}, undefined, undefined, ctx);
    expect(compactingDuplicate).toMatchObject({
      details: { accepted: false, status: "compacting" },
    });
    expect(compactingDuplicate.content[0].text).toContain("already in progress");

    compactCalls[0]!.onComplete?.({ ok: true });
    expect(ui.notifications.at(-1)).toEqual({
      message: "コンテキスト圧縮が完了しました。",
      level: "info",
    });
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0]!.message).toMatchObject({
      customType: "compact-continuation",
      display: false,
      details: { source: COMPACT_TOOL_NAME },
    });
    expect(pi.sentMessages[0]!.message.content).toContain("Context compaction completed.");
    expect(pi.sentMessages[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    await expectWarningInjectedOnce(contextHandler, ctx);
  });

  test("compact_context uses custom continuation prompt and supports stopAfterCompaction", async () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    const tool = pi.tools.get(COMPACT_TOOL_NAME)!;
    const turnEnd = pi.getEventHandlers("turn_end")[0]!;
    const { ctx, compactCalls } = createCtx({ cwd: tempDir });

    const scheduled = await tool.execute(
      "call",
      { continuationPrompt: "  Resume verification from the compacted summary.  " },
      undefined,
      undefined,
      ctx,
    );
    expect(scheduled).toMatchObject({
      details: {
        accepted: true,
        status: "scheduled",
        continuationPrompt: "Resume verification from the compacted summary.",
        stopAfterCompaction: false,
      },
    });

    await turnEnd({ turnIndex: 0 }, ctx);
    compactCalls[0]!.onComplete?.({ ok: true });

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0]!.message.content).toBe(
      "Resume verification from the compacted summary.",
    );
    pi.sentMessages.length = 0;

    const stopped = await tool.execute(
      "call",
      { stopAfterCompaction: true },
      undefined,
      undefined,
      ctx,
    );
    expect(stopped).toMatchObject({
      details: { accepted: true, status: "scheduled", stopAfterCompaction: true },
    });

    await turnEnd({ turnIndex: 1 }, ctx);
    compactCalls[1]!.onComplete?.({ ok: true });

    expect(pi.sentMessages).toEqual([]);
  });

  test("turn_end without a pending request does not compact", async () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    const { ctx, compactCalls } = createCtx({ cwd: tempDir });

    await pi.getEventHandlers("turn_end")[0]!({ turnIndex: 0 }, ctx);

    expect(compactCalls).toEqual([]);
  });

  test("compaction error callbacks reset state and notify in Japanese", async () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    const tool = pi.tools.get(COMPACT_TOOL_NAME)!;
    const turnEnd = pi.getEventHandlers("turn_end")[0]!;
    const contextHandler = pi.getEventHandlers("context")[0]!;
    const { ctx, ui, compactCalls } = createCtx({ cwd: tempDir });

    await expectWarningInjectedOnce(contextHandler, ctx);

    await tool.execute("call", {}, undefined, undefined, ctx);
    await turnEnd({ turnIndex: 0 }, ctx);
    compactCalls[0]!.onError?.(new Error("summary model failed"));

    expect(ui.notifications.at(-1)).toEqual({
      message: "コンテキスト圧縮に失敗しました: summary model failed",
      level: "error",
    });
    expect(pi.sentMessages).toEqual([]);
    await expectWarningInjectedOnce(contextHandler, ctx);

    const rescheduled = await tool.execute("call", {}, undefined, undefined, ctx);
    expect(rescheduled).toMatchObject({ details: { accepted: true, status: "scheduled" } });
  });

  test("synchronous ctx.compact failures also reset state", async () => {
    const pi = createFakePi<ToolDefinition>();
    compactExtension(pi as never);
    const tool = pi.tools.get(COMPACT_TOOL_NAME)!;
    const turnEnd = pi.getEventHandlers("turn_end")[0]!;
    const contextHandler = pi.getEventHandlers("context")[0]!;
    const { ctx, ui } = createCtx({
      cwd: tempDir,
      compactImpl: () => {
        throw new Error("compact unavailable");
      },
    });

    await expectWarningInjectedOnce(contextHandler, ctx);

    await tool.execute("call", {}, undefined, undefined, ctx);
    await turnEnd({ turnIndex: 0 }, ctx);

    expect(ui.notifications.at(-1)).toEqual({
      message: "コンテキスト圧縮に失敗しました: compact unavailable",
      level: "error",
    });
    expect(pi.sentMessages).toEqual([]);
    await expectWarningInjectedOnce(contextHandler, ctx);
    const rescheduled = await tool.execute("call", {}, undefined, undefined, ctx);
    expect(rescheduled).toMatchObject({ details: { accepted: true, status: "scheduled" } });
  });
});
