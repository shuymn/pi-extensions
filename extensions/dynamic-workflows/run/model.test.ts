import { describe, expect, test } from "bun:test";
import { createTaskId, createWorkflowRunId } from "./ids";
import { createInitialWorkflowRunState, serializeWorkflowRunState } from "./model";

describe("workflow run model", () => {
  test("generates run and task ids with stable prefixes and injected entropy", () => {
    expect(
      createWorkflowRunId({ now: () => 1_789_123_456_000, random: () => "abcdef123456" }),
    ).toBe("wf_20260911T104416_abcdef12");
    expect(createTaskId({ random: () => "1234567890ab" })).toBe("task_12345678");
  });

  test("creates a default initial WorkflowRunState manifest", () => {
    const state = createInitialWorkflowRunState({
      runId: "wf_20260907T133736_abcdef12",
      taskId: "task_12345678",
      sessionId: "session-1",
      cwd: "/repo",
      workflowName: "repo_review",
      description: "Review the repository",
      phases: [{ title: "Review" }, { title: "Synthesize", description: "Summarize" }],
      scriptPath: ".pi/workflows/wf/script.js",
      startTime: "2026-09-07T13:37:36.000Z",
    });

    expect(state).toEqual({
      schemaVersion: 1,
      runId: "wf_20260907T133736_abcdef12",
      taskId: "task_12345678",
      sessionId: "session-1",
      cwd: "/repo",
      workflowName: "repo_review",
      description: "Review the repository",
      status: "queued",
      scriptPath: ".pi/workflows/wf/script.js",
      phases: [
        { title: "Review", status: "pending" },
        { title: "Synthesize", description: "Summarize", status: "pending" },
      ],
      logs: [],
      agents: [],
      workflowProgress: {
        currentPhase: undefined,
        queuedAgents: 0,
        completedAgents: 0,
        failedAgents: 0,
        runningAgents: 0,
      },
      agentCount: 0,
      totalTokens: 0,
      totalToolCalls: 0,
      startTime: "2026-09-07T13:37:36.000Z",
      updatedAt: "2026-09-07T13:37:36.000Z",
      durationMs: undefined,
      outputPath: undefined,
      resultPreview: undefined,
      failures: [],
    });
  });

  test("serializes WorkflowRunState as stable pretty JSON", () => {
    const state = createInitialWorkflowRunState({
      runId: "wf_1_a",
      taskId: "task_1",
      cwd: "/repo",
      workflowName: "tiny",
      phases: [{ title: "Run" }],
      startTime: "2026-09-07T13:37:36.000Z",
    });

    expect(serializeWorkflowRunState(state)).toBe(`${JSON.stringify(state, null, 2)}\n`);
  });
});
