import { describe, expect, test } from "bun:test";
import { WorkflowManifestUpdater } from "./manifest";
import { createInitialWorkflowRunState } from "./model";

describe("workflow manifest updater", () => {
  test("updates state for runtime events and terminal completion", async () => {
    const writes: unknown[] = [];
    const timestamps = [
      "2026-09-11T10:44:17.000Z",
      "2026-09-11T10:44:18.000Z",
      "2026-09-11T10:44:19.000Z",
      "2026-09-11T10:44:20.000Z",
      "2026-09-11T10:44:21.000Z",
      "2026-09-11T10:44:22.000Z",
      "2026-09-11T10:44:23.000Z",
    ];
    const state = createInitialWorkflowRunState({
      runId: "wf_manifest_12345678",
      taskId: "task_manifest_12345678",
      cwd: "/repo",
      workflowName: "manifest_smoke",
      phases: [{ title: "Inspect" }, { title: "Synthesize" }],
      startTime: "2026-09-11T10:44:16.000Z",
    });
    const updater = new WorkflowManifestUpdater(
      state,
      (nextState) => {
        writes.push(nextState);
      },
      { now: () => timestamps.shift() ?? "2026-09-11T10:44:30.000Z" },
    );

    updater.markRunning();
    updater.phase("Inspect");
    updater.log("started");
    updater.agentQueued({
      runAgentId: "agent_1",
      label: "inspect src",
      phase: "Inspect",
      prompt: "Inspect src",
    });
    updater.agentStarted({
      runAgentId: "agent_1",
      label: "inspect src",
      phase: "Inspect",
      prompt: "Inspect src",
    });
    updater.agentCompleted({
      runAgentId: "agent_1",
      label: "inspect src",
      phase: "Inspect",
      prompt: "Inspect src",
      result: { ok: true },
    });
    updater.complete({
      outputPath: "/repo/.pi/workflows/wf_manifest_12345678/output.json",
      result: { report: "done" },
      durationMs: 7000,
    });
    await updater.flush();

    expect(writes.length).toBe(7);
    expect(updater.state).toMatchObject({
      status: "completed",
      logs: ["started"],
      agentCount: 1,
      workflowProgress: {
        currentPhase: "Inspect",
        queuedAgents: 0,
        runningAgents: 0,
        completedAgents: 1,
        failedAgents: 0,
      },
      phases: [
        { title: "Inspect", status: "completed" },
        { title: "Synthesize", status: "skipped" },
      ],
      agents: [
        {
          id: "agent_1",
          label: "inspect src",
          phase: "Inspect",
          status: "completed",
          promptPreview: "Inspect src",
          resultPreview: '{"ok":true}',
        },
      ],
      outputPath: "/repo/.pi/workflows/wf_manifest_12345678/output.json",
      resultPreview: '{"report":"done"}',
      durationMs: 7000,
    });
  });

  test("updates state for agent failure and terminal failure", async () => {
    const state = createInitialWorkflowRunState({
      runId: "wf_manifest_12345678",
      taskId: "task_manifest_12345678",
      cwd: "/repo",
      workflowName: "manifest_smoke",
      phases: [{ title: "Run" }],
      startTime: "2026-09-11T10:44:16.000Z",
    });
    const updater = new WorkflowManifestUpdater(state, () => {}, {
      now: () => "2026-09-11T10:44:17.000Z",
    });

    updater.markRunning();
    updater.phase("Run");
    updater.agentQueued({
      runAgentId: "agent_1",
      label: "bad branch",
      phase: "Run",
      prompt: "fail",
    });
    updater.agentStarted({
      runAgentId: "agent_1",
      label: "bad branch",
      phase: "Run",
      prompt: "fail",
    });
    updater.agentFailed({
      runAgentId: "agent_1",
      label: "bad branch",
      phase: "Run",
      prompt: "fail",
      error: "boom",
    });
    updater.fail(new Error("terminal boom"));
    await updater.flush();

    expect(updater.state).toMatchObject({
      status: "failed",
      workflowProgress: {
        queuedAgents: 0,
        runningAgents: 0,
        completedAgents: 0,
        failedAgents: 1,
      },
      phases: [{ title: "Run", status: "failed" }],
      agents: [{ label: "bad branch", status: "failed", error: "boom" }],
      failures: [{ message: "terminal boom" }],
    });
  });
});
