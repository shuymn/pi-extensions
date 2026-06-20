import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createInitialWorkflowRunState, type WorkflowRunState } from "../run/model";
import { createDisabledWorkflowMonitorControlSeams } from "./workflows-controls";
import { createWorkflowsProjection } from "./workflows-projection";

function runState(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  const state = createInitialWorkflowRunState({
    runId: "wf_projection_12345678",
    taskId: "task_projection_12345678",
    sessionId: "session-1",
    cwd: "/repo",
    workflowName: "projection_smoke",
    description: "Project manifest to views",
    phases: [{ title: "Inspect" }, { title: "Synthesize" }],
    scriptPath: "/repo/.pi/workflows/wf_projection_12345678/script.js",
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = "running";
  state.updatedAt = "2026-06-19T00:00:10.000Z";
  state.workflowProgress.currentPhase = "Inspect";
  state.workflowProgress.queuedAgents = 1;
  state.workflowProgress.runningAgents = 1;
  state.workflowProgress.completedAgents = 1;
  state.agentCount = 3;
  state.totalTokens = 1234;
  state.totalToolCalls = 5;
  state.phases[0] = {
    title: "Inspect",
    description: "Inspect sources",
    status: "running",
    startedAt: "2026-06-19T00:00:01.000Z",
  };
  state.phases[1] = { title: "Synthesize", status: "pending" };
  state.agents = [
    {
      id: "agent_1",
      label: "inventory",
      phase: "Inspect",
      status: "completed",
      promptPreview: "List important files",
      resultPreview: "found files",
      queuedAt: "2026-06-19T00:00:01.000Z",
      startedAt: "2026-06-19T00:00:02.000Z",
      completedAt: "2026-06-19T00:00:03.000Z",
    },
    {
      id: "agent_2",
      label: "risk scan",
      phase: "Inspect",
      status: "running",
      promptPreview: "Scan risky code",
      queuedAt: "2026-06-19T00:00:04.000Z",
      startedAt: "2026-06-19T00:00:05.000Z",
    },
    {
      id: "agent_3",
      label: "summary",
      phase: "Synthesize",
      status: "queued",
      promptPreview: "Summarize findings",
      queuedAt: "2026-06-19T00:00:06.000Z",
    },
  ];
  state.logs = ["one", "two", "three", "four", "five", "six"];
  state.failures = [
    {
      message: "minor issue",
      timestamp: "2026-06-19T00:00:07.000Z",
      phase: "Inspect",
      agentLabel: "risk scan",
    },
  ];
  return { ...state, ...overrides };
}

describe("workflows projection", () => {
  test("projects manifest state into chooser, overview, phase, agent detail, and prompt reader views", () => {
    const workflowRoot = "/repo/.pi/workflows";
    const projection = createWorkflowsProjection(workflowRoot, [runState()]);

    expect(projection.chooser).toEqual([
      expect.objectContaining({
        runId: "wf_projection_12345678",
        workflowName: "projection_smoke",
        status: "running",
        statusLabel: "実行中",
        statusIcon: "◐",
        currentPhase: "Inspect",
        artifactDir: join(workflowRoot, "wf_projection_12345678"),
        agentSummary: "待機1/実行1/完了1/失敗0",
      }),
    ]);
    expect(projection.overview).toMatchObject({
      runId: "wf_projection_12345678",
      workflowName: "projection_smoke",
      statusLabel: "実行中",
      cwd: "/repo",
      artifactDir: join(workflowRoot, "wf_projection_12345678"),
      scriptPath: "/repo/.pi/workflows/wf_projection_12345678/script.js",
      metrics: {
        agentCount: 3,
        queuedAgents: 1,
        runningAgents: 1,
        completedAgents: 1,
        failedAgents: 0,
        totalTokens: 1234,
        totalToolCalls: 5,
      },
      recentLogs: ["two", "three", "four", "five", "six"],
      failures: [{ message: "minor issue" }],
    });
    expect(projection.phase).toMatchObject({
      selectedPhaseTitle: "Inspect",
      selectedPhase: { title: "Inspect", statusLabel: "実行中", agentCount: 2 },
      phases: [
        { title: "Inspect", status: "running", statusLabel: "実行中", agentCount: 2 },
        { title: "Synthesize", status: "pending", statusLabel: "未開始", agentCount: 1 },
      ],
      agents: [
        { id: "agent_1", label: "inventory", statusLabel: "完了" },
        { id: "agent_2", label: "risk scan", statusLabel: "実行中" },
      ],
    });
    expect(projection.agentDetail).toMatchObject({
      id: "agent_2",
      label: "risk scan",
      status: "running",
      timing: {
        queuedAt: "2026-06-19T00:00:04.000Z",
        startedAt: "2026-06-19T00:00:05.000Z",
      },
    });
    expect(projection.promptReader).toEqual({
      title: "risk scan",
      prompt: "Scan risky code",
      source: "manifestPromptPreview",
      isFullPrompt: false,
    });
  });

  test("honors explicit selection and falls back safely", () => {
    const workflowRoot = "/repo/.pi/workflows";
    const older = runState({
      runId: "wf_older_12345678",
      taskId: "task_older_12345678",
      workflowName: "older",
    });
    const newer = runState({
      runId: "wf_newer_12345678",
      taskId: "task_newer_12345678",
      workflowName: "newer",
      workflowProgress: {
        currentPhase: "Synthesize",
        queuedAgents: 1,
        runningAgents: 1,
        completedAgents: 1,
        failedAgents: 0,
      },
    });

    const explicit = createWorkflowsProjection(workflowRoot, [newer, older], {
      runId: "wf_older_12345678",
      phaseTitle: "Synthesize",
      agentId: "agent_3",
    });
    expect(explicit.selectedRunId).toBe("wf_older_12345678");
    expect(explicit.phase?.selectedPhaseTitle).toBe("Synthesize");
    expect(explicit.agentDetail).toMatchObject({ id: "agent_3", label: "summary" });

    const fallback = createWorkflowsProjection(workflowRoot, [newer, older], {
      runId: "missing",
      phaseTitle: "missing",
      agentId: "missing",
    });
    expect(fallback.selectedRunId).toBe("wf_newer_12345678");
    expect(fallback.phase?.selectedPhaseTitle).toBe("Synthesize");
    expect(fallback.agentDetail).toMatchObject({ id: "agent_3", label: "summary" });
  });

  test("projects monitor control seams when provided", () => {
    const workflowRoot = "/repo/.pi/workflows";
    const projection = createWorkflowsProjection(
      workflowRoot,
      [runState()],
      { agentId: "agent_2" },
      { controls: createDisabledWorkflowMonitorControlSeams() },
    );

    expect(projection.controls).toMatchObject({
      runId: "wf_projection_12345678",
      agentId: "agent_2",
      items: [
        { type: "stopRun", label: "run停止", shortcut: "x", enabled: false },
        { type: "stopAgent", label: "agent停止", shortcut: "k", enabled: false },
      ],
    });
  });

  test("returns only an empty chooser when no runs are available", () => {
    expect(createWorkflowsProjection("/repo/.pi/workflows", [])).toEqual({
      workflowRoot: "/repo/.pi/workflows",
      chooser: [],
    });
  });
});
