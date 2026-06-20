import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createInitialWorkflowRunState, type WorkflowRunState } from "../run/model";
import { createWorkflowsChooserComponent } from "./workflows-chooser";
import { createWorkflowsProjection } from "./workflows-projection";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function keybindings() {
  return {
    matches(data: string, id: string) {
      return (
        (id === "tui.select.up" && data === "up") ||
        (id === "tui.select.down" && data === "down") ||
        (id === "tui.select.confirm" && data === "enter") ||
        (id === "tui.select.cancel" && data === "escape")
      );
    },
  };
}

function workflowRun(
  runId: string,
  workflowName: string,
  overrides: Partial<WorkflowRunState> = {},
): WorkflowRunState {
  const state = createInitialWorkflowRunState({
    runId,
    taskId: `task_${runId}`,
    cwd: "/repo",
    workflowName,
    description: `${workflowName} の説明がかなり長くても選択中の行は折り返して表示する`,
    phases: [{ title: "調査" }],
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = "running";
  state.workflowProgress.currentPhase = "調査";
  state.workflowProgress.queuedAgents = 1;
  state.workflowProgress.runningAgents = 2;
  state.workflowProgress.completedAgents = 3;
  state.workflowProgress.failedAgents = 0;
  state.agentCount = 6;
  state.updatedAt = "2026-06-19T00:00:02.000Z";
  return { ...state, ...overrides };
}

function createComponent(runs: WorkflowRunState[], selectedRunId?: string) {
  let renderRequests = 0;
  let doneValue: string | null | undefined;
  const component = createWorkflowsChooserComponent(
    createWorkflowsProjection("/repo/.pi/workflows", runs, { runId: selectedRunId }),
    { requestRender: () => renderRequests++ },
    theme,
    keybindings(),
    (value) => {
      doneValue = value;
    },
  );
  return {
    component,
    get renderRequests() {
      return renderRequests;
    },
    get doneValue() {
      return doneValue;
    },
  };
}

describe("workflows chooser component", () => {
  test("renders a width-safe chooser with selected workflow details", () => {
    const { component } = createComponent([
      workflowRun("wf_first_12345678", "first_workflow"),
      workflowRun("wf_second_12345678", "second_workflow"),
    ]);

    const lines = component.render(38);

    expect(lines.join("\n")).toContain("/workflows");
    expect(lines.join("\n")).toContain("表示するワークフローを選択");
    expect(lines.join("\n")).toContain("first_workflow [実行中]");
    expect(lines.join("\n")).toContain("成果物:");
    expect(lines.every((line) => visibleWidth(line) <= 38)).toBe(true);
  });

  test("moves selection, requests render, and returns selected run id", () => {
    const picker = createComponent([
      workflowRun("wf_first_12345678", "first_workflow"),
      workflowRun("wf_second_12345678", "second_workflow"),
    ]);

    picker.component.handleInput!("down");
    picker.component.handleInput!("enter");

    expect(picker.renderRequests).toBe(1);
    expect(picker.doneValue).toBe("wf_second_12345678");
  });

  test("wraps selection and supports cancellation", () => {
    const picker = createComponent([
      workflowRun("wf_first_12345678", "first_workflow"),
      workflowRun("wf_second_12345678", "second_workflow"),
    ]);

    picker.component.handleInput!("up");
    picker.component.handleInput!("escape");

    expect(picker.renderRequests).toBe(1);
    expect(picker.doneValue).toBeNull();
  });

  test("renders an empty chooser safely", () => {
    const picker = createComponent([]);

    const lines = picker.component.render(24);
    picker.component.handleInput!("enter");

    expect(lines.join("\n")).toContain("表示できる");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(picker.doneValue).toBeNull();
  });
});
