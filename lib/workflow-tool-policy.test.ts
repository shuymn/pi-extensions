import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  createWorkflowToolPolicyState,
  evaluateWorkflowToolCall,
  type WorkflowShellReviewer,
} from "./workflow-tool-policy";

const WORKFLOW_BODY_FILE = join(tmpdir(), "pi-workflow-test", "body.md");

function reviewerReturning(decision: "allow" | "deny", rationale = "reviewed") {
  const calls: Parameters<WorkflowShellReviewer>[0][] = [];
  const reviewer: WorkflowShellReviewer = async (request) => {
    calls.push(request);
    return { status: decision, rationale };
  };
  return { reviewer, calls };
}

describe("evaluateWorkflowToolCall", () => {
  test("uses reviewer fallback for statically unknown workflow shell commands", async () => {
    const { reviewer, calls } = reviewerReturning("allow", "gh status inspection is safe");

    await expect(
      evaluateWorkflowToolCall(
        "create-pr",
        { toolName: "bash", input: { command: "gh pr status" } },
        { reviewer },
      ),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workflow: "create-pr",
      command: "gh pr status",
      staticDecision: "unknown",
    });
    expect(calls[0]?.staticRationale).toContain("gh is not covered");
  });

  test("fails closed when a statically unknown shell command has no reviewer available", async () => {
    await expect(
      evaluateWorkflowToolCall("commit", {
        toolName: "bash",
        input: { command: "awk '{print $1}' file" },
      }),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("automatic shell command review is unavailable"),
    });
  });

  test("blocks reviewer-denied shell commands with anti-circumvention guidance", async () => {
    const { reviewer } = reviewerReturning("deny", "verification commands are outside /create-pr");

    await expect(
      evaluateWorkflowToolCall(
        "create-pr",
        { toolName: "bash", input: { command: "gh pr checkout 1" } },
        { reviewer },
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("verification commands are outside /create-pr"),
    });
    await expect(
      evaluateWorkflowToolCall(
        "create-pr",
        { toolName: "bash", input: { command: "gh pr checkout 1" } },
        { reviewer },
      ),
    ).resolves.toMatchObject({
      reason: expect.stringContaining("Do not try to work around"),
    });
  });

  test("blocks clearly destructive shell commands without consulting reviewer", async () => {
    const { reviewer, calls } = reviewerReturning("allow");

    for (const command of ["git reset --hard", "git status\ngit reset --hard"]) {
      await expect(
        evaluateWorkflowToolCall("commit", { toolName: "bash", input: { command } }, { reviewer }),
      ).resolves.toMatchObject({ block: true });
    }

    expect(calls).toEqual([]);
  });

  test("blocks broad commit staging bypasses", async () => {
    const { reviewer, calls } = reviewerReturning("allow");

    for (const command of [
      "git add -- .",
      "git commit -i . -m change",
      "git commit --include . -m change",
    ]) {
      await expect(
        evaluateWorkflowToolCall("commit", { toolName: "bash", input: { command } }, { reviewer }),
      ).resolves.toMatchObject({ block: true });
    }

    expect(calls).toEqual([]);
  });

  test("blocks unsafe create-pr gh side-effect forms", async () => {
    const { reviewer, calls } = reviewerReturning("allow");

    for (const command of [
      "gh pr create --title test",
      "gh pr create --title test --body-file /etc/passwd",
      "gh pr create --title test --body-file=-",
      "gh pr edit https://github.com/owner/repo/pull/1 --title test --body-file " +
        WORKFLOW_BODY_FILE,
    ]) {
      await expect(
        evaluateWorkflowToolCall(
          "create-pr",
          { toolName: "bash", input: { command } },
          { reviewer },
        ),
      ).resolves.toMatchObject({ block: true });
    }

    await expect(
      evaluateWorkflowToolCall(
        "create-pr",
        {
          toolName: "bash",
          input: { command: `gh pr create --title test --body-file ${WORKFLOW_BODY_FILE}` },
        },
        { reviewer },
      ),
    ).resolves.toBeUndefined();
    await expect(
      evaluateWorkflowToolCall(
        "create-pr",
        {
          toolName: "bash",
          input: { command: `gh pr edit 1 --title test --body-file ${WORKFLOW_BODY_FILE}` },
        },
        { reviewer },
      ),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([]);
  });

  test("fails closed when reviewer throws", async () => {
    const reviewer: WorkflowShellReviewer = async () => {
      throw new Error("review unavailable");
    };

    await expect(
      evaluateWorkflowToolCall(
        "create-pr",
        { toolName: "bash", input: { command: "gh pr status" } },
        { reviewer },
      ),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("automatic shell command review failed: review unavailable"),
    });
  });

  test("stops repeated reviewer denials during a workflow session", async () => {
    const { reviewer, calls } = reviewerReturning("deny", "not allowed in this workflow");
    const state = createWorkflowToolPolicyState();
    const event = { toolName: "bash", input: { command: "gh pr checkout 1" } };

    for (let index = 0; index < 3; index += 1) {
      await expect(
        evaluateWorkflowToolCall("create-pr", event, { reviewer, state }),
      ).resolves.toMatchObject({ block: true });
    }

    await expect(
      evaluateWorkflowToolCall("create-pr", event, { reviewer, state }),
    ).resolves.toMatchObject({
      block: true,
      reason: expect.stringContaining("repeated automatic shell command review denials"),
    });
    expect(calls).toHaveLength(3);
  });
});
