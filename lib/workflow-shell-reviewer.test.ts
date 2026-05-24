import { describe, expect, mock, test } from "bun:test";

let completeImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  content: [
    {
      type: "toolCall",
      id: "call-1",
      name: "workflow_shell_review_decision",
      arguments: { decision: "allow", rationale: "safe inspection" },
    },
  ],
});

mock.module("@earendil-works/pi-ai", () => ({
  complete: (...args: unknown[]) => completeImpl(...args),
}));

function createCtx(
  options: {
    findModel?: boolean;
    auth?:
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string };
    signal?: AbortSignal;
  } = {},
) {
  const completeCalls: unknown[][] = [];
  const findModel = options.findModel ?? true;
  const auth = options.auth ?? { ok: true, apiKey: "test-key", headers: { "x-test": "1" } };
  return {
    completeCalls,
    ctx: {
      cwd: "/repo",
      signal: options.signal,
      modelRegistry: {
        find: (provider: string, modelId: string) =>
          findModel ? { provider, id: modelId, model: modelId } : undefined,
        getApiKeyAndHeaders: async () => auth,
      },
    },
  };
}

async function loadReviewer() {
  return await import("./workflow-shell-reviewer");
}

describe("reviewWorkflowShellCommand", () => {
  test("calls the configured reviewer model with medium reasoning and strict tool output", async () => {
    const completeCalls: unknown[][] = [];
    completeImpl = async (...args: unknown[]) => {
      completeCalls.push(args);
      return {
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "workflow_shell_review_decision",
            arguments: { decision: "allow", rationale: "gh pr status only reads PR state" },
          },
        ],
      };
    };
    const { ctx } = createCtx();
    const { reviewWorkflowShellCommand } = await loadReviewer();

    await expect(
      reviewWorkflowShellCommand({
        workflow: "create-pr",
        command: "gh pr status",
        staticDecision: "unknown",
        staticRationale: "gh is not covered by static read-only shell rules.",
        ctx: ctx as never,
      }),
    ).resolves.toEqual({ status: "allow", rationale: "gh pr status only reads PR state" });

    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]?.[0]).toMatchObject({ provider: "openai-codex" });
    const context = completeCalls[0]?.[1] as {
      systemPrompt?: string;
      messages: Array<{ content: Array<{ type: string; text: string }> }>;
      tools?: Array<{ name: string }>;
    };
    expect(context.systemPrompt).toContain("untrusted evidence");
    expect(context.tools?.map((tool) => tool.name)).toEqual(["workflow_shell_review_decision"]);
    expect(context.messages[0]?.content[0]?.text).toContain('"command": "gh pr status"');
    expect(context.messages[0]?.content[0]?.text).toContain('"workflow": "create-pr"');
    expect(context.messages[0]?.content[0]?.text).toContain('"cwd": "/repo"');
    expect(completeCalls[0]?.[2]).toMatchObject({
      apiKey: "test-key",
      headers: { "x-test": "1" },
      reasoningEffort: "medium",
      timeoutMs: 15_000,
    });
  });

  test("returns deny from reviewer tool call", async () => {
    completeImpl = async () => ({
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "workflow_shell_review_decision",
          arguments: { decision: "deny", rationale: "verification is out of scope" },
        },
      ],
    });
    const { ctx } = createCtx();
    const { reviewWorkflowShellCommand } = await loadReviewer();

    await expect(
      reviewWorkflowShellCommand({
        workflow: "create-pr",
        command: "bun run test",
        staticDecision: "unknown",
        staticRationale: "needs review",
        ctx: ctx as never,
      }),
    ).resolves.toEqual({ status: "deny", rationale: "verification is out of scope" });
  });

  test("fails closed when reviewer output is invalid", async () => {
    const { ctx } = createCtx();
    const { reviewWorkflowShellCommand } = await loadReviewer();

    completeImpl = async () => ({ content: [{ type: "text", text: "allow" }] });
    await expect(
      reviewWorkflowShellCommand({
        workflow: "commit",
        command: "awk '{print $1}' file",
        staticDecision: "unknown",
        staticRationale: "awk needs review",
        ctx: ctx as never,
      }),
    ).resolves.toMatchObject({ status: "invalid" });

    completeImpl = async () => ({
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "workflow_shell_review_decision",
          arguments: { decision: "allow", rationale: "safe" },
        },
        {
          type: "toolCall",
          id: "call-2",
          name: "workflow_shell_review_decision",
          arguments: { decision: "deny", rationale: "unsafe" },
        },
      ],
    });
    await expect(
      reviewWorkflowShellCommand({
        workflow: "commit",
        command: "awk '{print $1}' file",
        staticDecision: "unknown",
        staticRationale: "awk needs review",
        ctx: ctx as never,
      }),
    ).resolves.toMatchObject({ status: "invalid" });

    completeImpl = async () => ({ content: "allow" });
    await expect(
      reviewWorkflowShellCommand({
        workflow: "commit",
        command: "awk '{print $1}' file",
        staticDecision: "unknown",
        staticRationale: "awk needs review",
        ctx: ctx as never,
      }),
    ).resolves.toMatchObject({ status: "invalid" });
  });

  test("fails closed when reviewer model or auth is unavailable", async () => {
    const { reviewWorkflowShellCommand } = await loadReviewer();
    const missingModel = createCtx({ findModel: false });
    await expect(
      reviewWorkflowShellCommand({
        workflow: "commit",
        command: "awk '{print $1}' file",
        staticDecision: "unknown",
        staticRationale: "awk needs review",
        ctx: missingModel.ctx as never,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });

    const missingKey = createCtx({ auth: { ok: true } });
    await expect(
      reviewWorkflowShellCommand({
        workflow: "commit",
        command: "awk '{print $1}' file",
        staticDecision: "unknown",
        staticRationale: "awk needs review",
        ctx: missingKey.ctx as never,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});
