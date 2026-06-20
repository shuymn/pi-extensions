import { describe, expect, test } from "bun:test";
import { createFakeUi } from "../../../tests/support/fake-ui";
import { createInitialWorkflowRunState, type WorkflowRunState } from "../run/model";
import {
  DYNAMIC_WORKFLOW_WIDGET_KEY,
  refreshWorkflowWidget,
  renderActiveWorkflowWidgetText,
} from "./workflow-widget";

function createState(status: WorkflowRunState["status"] = "running"): WorkflowRunState {
  const state = createInitialWorkflowRunState({
    runId: "wf_widget_12345678",
    taskId: "task_widget_12345678",
    cwd: "/repo",
    workflowName: "repo_review",
    phases: [{ title: "調査" }, { title: "統合" }],
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = status;
  state.workflowProgress.currentPhase = "調査";
  state.workflowProgress.queuedAgents = 1;
  state.workflowProgress.runningAgents = 1;
  state.workflowProgress.completedAgents = 2;
  state.workflowProgress.failedAgents = 1;
  state.agents = [
    {
      id: "agent_1",
      label: "queued",
      status: "queued",
      promptPreview: "queued work",
      queuedAt: "2026-06-19T00:00:01.000Z",
    },
    {
      id: "agent_2",
      label: "active",
      phase: "調査",
      status: "running",
      promptPreview: "active work",
      queuedAt: "2026-06-19T00:00:02.000Z",
    },
    {
      id: "agent_3",
      label: "bad",
      status: "failed",
      promptPreview: "bad work",
      queuedAt: "2026-06-19T00:00:03.000Z",
      error: "boom",
    },
  ];
  state.logs = ["最後のログ"];
  return state;
}

describe("dynamic workflow active widget", () => {
  test("renders active workflow state with Japanese status text", () => {
    const lines = renderActiveWorkflowWidgetText(createState())!;

    expect(lines[0]).toContain("● ワークフロー「repo_review」 実行中");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("フェーズ: 調査"),
        expect.stringContaining("エージェント: 待機1 実行1 完了2 失敗1"),
        expect.stringContaining("◐ active [調査]"),
        expect.stringContaining("! bad — boom"),
        expect.stringContaining("ログ: 最後のログ"),
      ]),
    );
  });

  test("returns undefined for terminal workflow states", () => {
    expect(renderActiveWorkflowWidgetText(createState("completed"))).toBeUndefined();
    expect(renderActiveWorkflowWidgetText(createState("failed"))).toBeUndefined();
    expect(renderActiveWorkflowWidgetText(createState("cancelled"))).toBeUndefined();
  });

  test("sets aboveEditor widget for active state and clears it for terminal state", () => {
    const ui = createFakeUi();
    const ctx = { ui };

    refreshWorkflowWidget(ctx, createState("queued"));
    expect(ui.widgets.at(-1)).toMatchObject({
      key: DYNAMIC_WORKFLOW_WIDGET_KEY,
      lines: expect.arrayContaining([expect.stringContaining("待機中")]),
      options: { placement: "aboveEditor" },
    });

    refreshWorkflowWidget(ctx, createState("completed"));
    expect(ui.widgets.at(-1)).toMatchObject({
      key: DYNAMIC_WORKFLOW_WIDGET_KEY,
      lines: undefined,
    });
  });
});
