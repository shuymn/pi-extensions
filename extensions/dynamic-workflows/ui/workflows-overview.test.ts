import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createInitialWorkflowRunState, type WorkflowRunState } from "../run/model";
import { createDisabledWorkflowMonitorControlSeams } from "./workflows-controls";
import {
  createWorkflowsOverviewComponent,
  type WorkflowsOverviewResult,
} from "./workflows-overview";
import { createWorkflowsProjection } from "./workflows-projection";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function keybindings() {
  return {
    matches(data: string, id: string) {
      return (
        (id === "tui.select.cancel" && data === "escape") ||
        (id === "tui.select.confirm" && data === "enter")
      );
    },
  };
}

function workflowRun(overrides: Partial<WorkflowRunState> = {}): WorkflowRunState {
  const state = createInitialWorkflowRunState({
    runId: "wf_overview_12345678",
    taskId: "task_overview_12345678",
    sessionId: "session-1",
    cwd: "/repo",
    workflowName: "overview_smoke",
    description: "選択したワークフローの概要を表示する",
    phases: [{ title: "調査" }, { title: "統合" }],
    scriptPath: "/repo/.pi/workflows/wf_overview_12345678/script.js",
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = "running";
  state.updatedAt = "2026-06-19T00:00:10.000Z";
  state.workflowProgress.currentPhase = "調査";
  state.workflowProgress.queuedAgents = 1;
  state.workflowProgress.runningAgents = 1;
  state.workflowProgress.completedAgents = 1;
  state.workflowProgress.failedAgents = 0;
  state.agentCount = 3;
  state.totalTokens = 1234;
  state.totalToolCalls = 5;
  state.phases[0] = {
    title: "調査",
    status: "running",
    startedAt: "2026-06-19T00:00:01.000Z",
  };
  state.phases[1] = { title: "統合", status: "pending" };
  state.agents = [
    {
      id: "agent_1",
      label: "inventory",
      phase: "調査",
      status: "completed",
      promptPreview: "重要ファイルを調べる",
      resultPreview: "ファイル一覧を確認",
      queuedAt: "2026-06-19T00:00:01.000Z",
      startedAt: "2026-06-19T00:00:02.000Z",
      completedAt: "2026-06-19T00:00:03.000Z",
    },
    {
      id: "agent_2",
      label: "runner",
      phase: "調査",
      status: "running",
      promptPreview: "実行中の調査プロンプト",
      queuedAt: "2026-06-19T00:00:04.000Z",
      startedAt: "2026-06-19T00:00:05.000Z",
    },
    {
      id: "agent_3",
      label: "summary",
      phase: "統合",
      status: "queued",
      promptPreview: "結果を統合する",
      queuedAt: "2026-06-19T00:00:06.000Z",
    },
  ];
  return { ...state, ...overrides };
}

function createComponent(runs: WorkflowRunState[]) {
  let doneValue: WorkflowsOverviewResult | undefined;
  const component = createWorkflowsOverviewComponent(
    createWorkflowsProjection("/repo/.pi/workflows", runs),
    theme,
    keybindings(),
    (value) => {
      doneValue = value;
    },
  );
  return {
    component,
    get doneValue() {
      return doneValue;
    },
  };
}

describe("workflows overview component", () => {
  test("renders workflow header, artifacts, phases, selected phase agents, metrics, and footer", () => {
    const { component } = createComponent([workflowRun()]);

    const lines = component.render(72);
    const text = lines.join("\n");

    expect(text).toContain("overview_smoke [実行中]");
    expect(text).toContain("成果物: /repo/.pi/workflows/wf_overview_12345678");
    expect(text).toContain("メトリクス: エージェント 3");
    expect(text).toContain("フェーズ");
    expect(text).toContain("調査 [実行中]");
    expect(text).toContain("選択中フェーズのエージェント: 調査");
    expect(text).toContain("runner [実行中]");
    expect(text).toContain("prompt: 実行中の調査プロンプト");
    expect(text).toContain("Escで閉じる");
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });

  test("truncates and wraps safely for narrow widths", () => {
    const { component } = createComponent([workflowRun()]);

    const lines = component.render(28);

    expect(lines.length).toBeGreaterThan(8);
    expect(lines.every((line) => visibleWidth(line) <= 28)).toBe(true);
  });

  test("opens selected agent detail on confirm and closes on cancel", () => {
    const picker = createComponent([workflowRun()]);

    picker.component.handleInput!("enter");
    expect(picker.doneValue).toEqual({ type: "openAgentDetail", agentId: "agent_2" });

    picker.component.handleInput!("escape");
    expect(picker.doneValue).toBeNull();
  });

  test("renders disabled monitor controls and returns control actions", () => {
    let doneValue: WorkflowsOverviewResult | undefined;
    const component = createWorkflowsOverviewComponent(
      createWorkflowsProjection(
        "/repo/.pi/workflows",
        [workflowRun()],
        {},
        { controls: createDisabledWorkflowMonitorControlSeams() },
      ),
      theme,
      keybindings(),
      (value) => {
        doneValue = value;
      },
    );

    const lines = component.render(88);
    const text = lines.join("\n");
    expect(text).toContain("操作");
    expect(text).toContain("[x] run停止 (未接続)");
    expect(text).toContain("[k] agent停止 (未接続)");
    expect(lines.every((line) => visibleWidth(line) <= 88)).toBe(true);

    component.handleInput!("x");
    expect(doneValue).toEqual({
      type: "controlAction",
      action: { type: "stopRun", runId: "wf_overview_12345678" },
    });
  });

  test("renders an empty overview safely", () => {
    const { component } = createComponent([]);

    const lines = component.render(24);

    expect(lines.join("\n")).toContain("表示できる");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
});
