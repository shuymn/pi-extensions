import { describe, expect, test } from "bun:test";

import {
  applyWorkflowActiveTools,
  evaluateWorkflowToolCall,
  getWorkflowActiveTools,
  WORKFLOW_TEMP_FILE_TOOL_NAME,
} from "./workflow-tool-policy";

describe("getWorkflowActiveTools", () => {
  test("commit tool list", () => {
    expect(getWorkflowActiveTools("commit")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "spawn_subagent",
      WORKFLOW_TEMP_FILE_TOOL_NAME,
    ]);
  });

  test("create-pr tool list includes ask_user_question", () => {
    expect(getWorkflowActiveTools("create-pr")).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "spawn_subagent",
      WORKFLOW_TEMP_FILE_TOOL_NAME,
      "ask_user_question",
    ]);
  });
});

describe("applyWorkflowActiveTools", () => {
  test("applies the workflow tool list via setActiveTools", () => {
    const calls: string[][] = [];
    applyWorkflowActiveTools(
      { setActiveTools: (tools: string[]) => calls.push(tools) } as never,
      "commit",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("bash");
    expect(calls[0]).toContain(WORKFLOW_TEMP_FILE_TOOL_NAME);
  });
});

describe("evaluateWorkflowToolCall", () => {
  test("blocks tools that are not in the workflow allowlist", () => {
    expect(evaluateWorkflowToolCall("commit", { toolName: "edit", input: {} })).toMatchObject({
      block: true,
    });
    expect(evaluateWorkflowToolCall("commit", { toolName: "write", input: {} })).toMatchObject({
      block: true,
    });
  });

  test("allows tools that are in the workflow allowlist", () => {
    expect(
      evaluateWorkflowToolCall("commit", { toolName: "read", input: { path: "f" } }),
    ).toBeUndefined();
  });

  test("forces spawn_subagent into read-only mode", () => {
    const event: { toolName: string; input: { readOnly?: boolean; other?: string } } = {
      toolName: "spawn_subagent",
      input: { other: "value" },
    };
    expect(evaluateWorkflowToolCall("create-pr", event)).toBeUndefined();
    expect(event.input).toEqual({ other: "value", readOnly: true });
  });

  test("delegates bash command checks to forbidden-flags", () => {
    expect(
      evaluateWorkflowToolCall("commit", {
        toolName: "bash",
        input: { command: "git add file" },
      }),
    ).toBeUndefined();

    expect(
      evaluateWorkflowToolCall("commit", {
        toolName: "bash",
        input: { command: "git add -A" },
      }),
    ).toMatchObject({ block: true });
  });

  test("blocks bash with missing or non-string command", () => {
    expect(evaluateWorkflowToolCall("commit", { toolName: "bash", input: {} })).toMatchObject({
      block: true,
    });
    expect(
      evaluateWorkflowToolCall("commit", { toolName: "bash", input: { command: 123 } as never }),
    ).toMatchObject({ block: true });
  });

  test("blocks when tool name is missing", () => {
    expect(evaluateWorkflowToolCall("commit", { input: {} })).toMatchObject({ block: true });
  });

  test("prefixes block reasons with the workflow name", () => {
    const result = evaluateWorkflowToolCall("create-pr", {
      toolName: "bash",
      input: { command: "git push --force" },
    });
    expect(result).toMatchObject({ block: true });
    if (result?.block) {
      expect(result.reason).toContain("/create-pr extension によりブロックしました");
    }
  });
});
