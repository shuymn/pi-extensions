import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createInitialWorkflowRunState, type WorkflowRunState } from "../run/model";
import { createWorkflowResultComponent } from "./render-tool";
import { createWorkflowsAgentDetailComponent } from "./workflows-agent-detail";
import { createWorkflowsChooserComponent } from "./workflows-chooser";
import { createDisabledWorkflowMonitorControlSeams } from "./workflows-controls";
import { createWorkflowsOverviewComponent } from "./workflows-overview";
import {
  createWorkflowsProjection,
  type WorkflowPromptReaderViewModel,
} from "./workflows-projection";
import { createWorkflowsPromptReaderComponent } from "./workflows-prompt-reader";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

const keybindings = {
  matches: () => false,
};

const tui = {
  requestRender() {},
};

const WORKFLOW_ROOT = "/repo/.pi/workflows";
const WIDTHS = [16, 28, 52, 96];

function longText(label: string): string {
  return `${label}: かなり長い日本語の説明とASCII_identifier_that_should_wrap_safely_without_overflowを含む文章`;
}

function workflowRun(
  runId: string,
  workflowName: string,
  status: WorkflowRunState["status"] = "running",
): WorkflowRunState {
  const state = createInitialWorkflowRunState({
    runId,
    taskId: `task_${runId}`,
    sessionId: "session-1",
    cwd: "/repo/subdir/with/a/very/long/path/that/should/not/overflow",
    workflowName,
    description: longText("workflow description"),
    phases: [
      { title: "調査フェーズ_with_long_suffix", description: longText("phase one") },
      { title: "統合フェーズ_with_long_suffix", description: longText("phase two") },
    ],
    scriptPath: `/repo/.pi/workflows/${runId}/script-with-very-long-name.js`,
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = status;
  state.updatedAt = "2026-06-19T00:00:10.000Z";
  state.workflowProgress.currentPhase = "調査フェーズ_with_long_suffix";
  state.workflowProgress.queuedAgents = 1;
  state.workflowProgress.runningAgents = 1;
  state.workflowProgress.completedAgents = 1;
  state.workflowProgress.failedAgents = 1;
  state.agentCount = 4;
  state.estimatedResultTokens = 123_456;
  state.outputPath = `/repo/.pi/workflows/${runId}/output-with-long-name.json`;
  state.resultPreview = longText("result preview");
  state.logs = [longText("first log"), longText("latest log")];
  state.failures = [
    {
      message: longText("failure message"),
      timestamp: "2026-06-19T00:00:07.000Z",
      phase: "調査フェーズ_with_long_suffix",
      agentLabel: "risk scan agent with long label",
    },
  ];
  state.phases[0] = {
    title: "調査フェーズ_with_long_suffix",
    description: longText("phase one"),
    status: "running",
    startedAt: "2026-06-19T00:00:01.000Z",
  };
  state.phases[1] = {
    title: "統合フェーズ_with_long_suffix",
    description: longText("phase two"),
    status: "pending",
  };
  state.agents = [
    {
      id: "agent_1",
      label: "inventory agent with long label",
      phase: "調査フェーズ_with_long_suffix",
      status: "completed",
      promptPreview: longText("completed prompt"),
      resultPreview: longText("completed result"),
      queuedAt: "2026-06-19T00:00:01.000Z",
      startedAt: "2026-06-19T00:00:02.000Z",
      completedAt: "2026-06-19T00:00:03.000Z",
    },
    {
      id: "agent_2",
      label: "running agent with long label",
      phase: "調査フェーズ_with_long_suffix",
      status: "running",
      promptPreview: longText("running prompt"),
      queuedAt: "2026-06-19T00:00:04.000Z",
      startedAt: "2026-06-19T00:00:05.000Z",
    },
    {
      id: "agent_3",
      label: "failed agent with long label",
      phase: "調査フェーズ_with_long_suffix",
      status: "failed",
      promptPreview: longText("failed prompt"),
      error: longText("failed error"),
      queuedAt: "2026-06-19T00:00:06.000Z",
      startedAt: "2026-06-19T00:00:07.000Z",
      completedAt: "2026-06-19T00:00:08.000Z",
    },
  ];
  return state;
}

function promptReader(): WorkflowPromptReaderViewModel {
  return {
    title: "risk scan agent with long label",
    prompt: Array.from({ length: 28 }, (_, index) => longText(`prompt line ${index + 1}`)).join(
      "\n",
    ),
    source: "transcriptPrompt",
    isFullPrompt: true,
    transcriptPath:
      "/repo/.pi/workflows/wf_render_width_12345678/transcripts/0002-risk-scan-agent-with-long-label.json",
  };
}

function renderCases() {
  const runs = [
    workflowRun("wf_render_width_12345678", "render_width_workflow_with_long_name"),
    workflowRun("wf_render_width_other_12345678", "other_render_width_workflow", "completed"),
  ];
  const controls = createDisabledWorkflowMonitorControlSeams();
  return [
    {
      name: "chooser",
      render: (width: number) =>
        createWorkflowsChooserComponent(
          createWorkflowsProjection(WORKFLOW_ROOT, runs),
          tui,
          theme,
          keybindings,
          () => {},
        ).render(width),
    },
    {
      name: "overview",
      render: (width: number) =>
        createWorkflowsOverviewComponent(
          createWorkflowsProjection(WORKFLOW_ROOT, runs, {}, { controls }),
          theme,
          keybindings,
          () => {},
        ).render(width),
    },
    {
      name: "agent detail",
      render: (width: number) =>
        createWorkflowsAgentDetailComponent(
          createWorkflowsProjection(WORKFLOW_ROOT, runs, { agentId: "agent_2" }, { controls }),
          theme,
          keybindings,
          () => {},
        ).render(width),
    },
    {
      name: "prompt reader",
      render: (width: number) =>
        createWorkflowsPromptReaderComponent(
          promptReader(),
          tui,
          theme,
          keybindings,
          () => {},
        ).render(width),
    },
    {
      name: "tool result",
      render: (width: number) =>
        createWorkflowResultComponent(
          {
            content: [],
            details: {
              status: "completed" as const,
              workflowName: "render_width_workflow_with_long_name",
              phases: ["調査フェーズ_with_long_suffix", "統合フェーズ_with_long_suffix"],
              logs: [longText("tool log")],
              agents: [
                {
                  label: "tool renderer agent with long label",
                  phase: "調査フェーズ_with_long_suffix",
                  prompt: longText("tool prompt"),
                  status: "done" as const,
                },
              ],
              agentCount: 1,
              durationMs: 12345,
            },
          },
          theme,
        ).render(width),
    },
  ];
}

function expectWidthSafe(name: string, width: number, lines: string[]): void {
  expect(lines.length, `${name} should render at least one line`).toBeGreaterThan(0);
  const overflowing = lines.filter((line) => visibleWidth(line) > width);
  expect(overflowing, `${name} overflowed width ${width}`).toEqual([]);
}

describe("dynamic workflow renderer width goldens", () => {
  for (const renderer of renderCases()) {
    for (const width of WIDTHS) {
      test(`${renderer.name} stays within width ${width}`, () => {
        expectWidthSafe(renderer.name, width, renderer.render(width));
      });
    }
  }
});
