import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createInitialWorkflowRunState, type WorkflowRunState } from "../run/model";
import {
  createWorkflowsAgentDetailComponent,
  type WorkflowsAgentDetailResult,
} from "./workflows-agent-detail";
import { createDisabledWorkflowMonitorControlSeams } from "./workflows-controls";
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

function workflowRun(): WorkflowRunState {
  const state = createInitialWorkflowRunState({
    runId: "wf_agent_detail_12345678",
    taskId: "task_agent_detail_12345678",
    cwd: "/repo",
    workflowName: "agent_detail_smoke",
    phases: [{ title: "調査" }],
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = "running";
  state.workflowProgress.currentPhase = "調査";
  state.agents = [
    {
      id: "agent_1",
      label: "inventory",
      phase: "調査",
      status: "completed",
      promptPreview: "重要ファイルを調べて、リスクのある箇所を列挙する",
      resultPreview: "src/main.ts と tests/main.test.ts を確認済み",
      queuedAt: "2026-06-19T00:00:01.000Z",
      startedAt: "2026-06-19T00:00:02.000Z",
      completedAt: "2026-06-19T00:00:05.000Z",
    },
    {
      id: "agent_2",
      label: "risk scan",
      phase: "調査",
      status: "failed",
      promptPreview: "失敗する調査",
      error: "boom",
      queuedAt: "2026-06-19T00:00:06.000Z",
      startedAt: "2026-06-19T00:00:07.000Z",
      completedAt: "2026-06-19T00:00:08.000Z",
    },
  ];
  return state;
}

function createComponent(agentId?: string) {
  let doneValue: WorkflowsAgentDetailResult | undefined;
  const component = createWorkflowsAgentDetailComponent(
    createWorkflowsProjection("/repo/.pi/workflows", [workflowRun()], { agentId }),
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

describe("workflows agent detail component", () => {
  test("renders status/model line, metrics, prompt preview, activity, and outcome", () => {
    const { component } = createComponent("agent_1");

    const lines = component.render(72);
    const text = lines.join("\n");

    expect(text).toContain("inventory [完了]");
    expect(text).toContain("状態: 完了 · フェーズ: 調査 · model: 未記録");
    expect(text).toContain("メトリクス: duration 3000ms · tokens 未記録 · tools 未記録");
    expect(text).toContain("Prompt preview");
    expect(text).toContain("重要ファイルを調べて");
    expect(text).toContain("Recent activity");
    expect(text).toContain("queued: 2026-06-19T00:00:01.000Z");
    expect(text).toContain("Outcome preview");
    expect(text).toContain("result: src/main.ts");
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });

  test("renders error outcome and remains width-safe", () => {
    const { component } = createComponent("agent_2");

    const lines = component.render(32);
    const text = lines.join("\n");

    expect(text).toContain("risk scan [失敗]");
    expect(text).toContain("error: boom");
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
  });

  test("opens full prompt reader on confirm and closes on cancel", () => {
    const picker = createComponent("agent_1");

    picker.component.handleInput!("enter");
    expect(picker.doneValue).toEqual({ type: "openPromptReader", agentId: "agent_1" });

    picker.component.handleInput!("escape");
    expect(picker.doneValue).toBeNull();
  });

  test("renders disabled monitor controls and returns agent-scoped actions", () => {
    let doneValue: WorkflowsAgentDetailResult | undefined;
    const component = createWorkflowsAgentDetailComponent(
      createWorkflowsProjection(
        "/repo/.pi/workflows",
        [workflowRun()],
        { agentId: "agent_1" },
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
    expect(text).toContain("[k] agent停止 (未接続)");
    expect(lines.every((line) => visibleWidth(line) <= 88)).toBe(true);

    component.handleInput!("k");
    expect(doneValue).toEqual({
      type: "controlAction",
      action: {
        type: "stopAgent",
        runId: "wf_agent_detail_12345678",
        agentId: "agent_1",
      },
    });
  });

  test("renders empty detail safely", () => {
    let doneValue: WorkflowsAgentDetailResult | undefined;
    const component = createWorkflowsAgentDetailComponent(
      createWorkflowsProjection("/repo/.pi/workflows", []),
      theme,
      keybindings(),
      (value) => {
        doneValue = value;
      },
    );

    const lines = component.render(24);
    component.handleInput!("escape");

    expect(lines.join("\n")).toContain("表示できる");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(doneValue).toBeNull();
  });
});
