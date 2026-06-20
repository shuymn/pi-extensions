import { writeSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listWorkflowRunManifests } from "../run/list";
import type { WorkflowRunState, WorkflowRunStatus } from "../run/model";
import { resolveWorkflowRoot } from "../run/root";
import { runStatusIcon, runStatusLabel } from "./status-view";
import {
  createWorkflowsAgentDetailComponent,
  type WorkflowsAgentDetailResult,
} from "./workflows-agent-detail";
import { createWorkflowsChooserComponent } from "./workflows-chooser";
import {
  createDisabledWorkflowMonitorControlSeams,
  type WorkflowMonitorControlAction,
  type WorkflowMonitorControlContext,
  type WorkflowMonitorControlSeams,
} from "./workflows-controls";
import {
  createWorkflowsOverviewComponent,
  type WorkflowsOverviewResult,
} from "./workflows-overview";
import { createWorkflowsProjection } from "./workflows-projection";
import { createWorkflowsPromptReaderComponent } from "./workflows-prompt-reader";
import { loadWorkflowPromptReaderViewModel } from "./workflows-prompt-reader-source";

export type WorkflowsCommandOutput = (text: string) => void;

export type WorkflowsCommandOptions = {
  output?: WorkflowsCommandOutput;
  controls?: WorkflowMonitorControlSeams;
};

export type WorkflowRunSummary = {
  runId: string;
  taskId: string;
  workflowName: string;
  description?: string;
  status: WorkflowRunStatus;
  statusLabel: string;
  sessionId?: string;
  cwd: string;
  artifactDir: string;
  currentPhase?: string;
  agentCount: number;
  queuedAgents: number;
  runningAgents: number;
  completedAgents: number;
  failedAgents: number;
  totalTokens: number;
  totalToolCalls: number;
  startTime: string;
  updatedAt: string;
  durationMs?: number;
  outputPath?: string;
  resultPreview?: string;
  failureCount: number;
};

export type WorkflowRunListPayload = {
  workflowRoot: string;
  sessionId?: string;
  count: number;
  workflows: WorkflowRunSummary[];
};

export function registerWorkflowsCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  options: WorkflowsCommandOptions = {},
): void {
  const output = options.output ?? defaultCommandOutput;
  const controls = options.controls ?? createDisabledWorkflowMonitorControlSeams();

  pi.registerCommand("workflows", {
    description: "List dynamic workflow runs visible to the current session",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const workflowRoot = resolveWorkflowRoot(ctx.cwd);
      const sessionId = getSessionId(ctx);
      const workflows = await listWorkflowRunManifests(workflowRoot, { sessionId });
      const payload = createWorkflowRunListPayload(workflowRoot, workflows, sessionId);

      if (ctx.hasUI === false) {
        output(formatNonInteractiveWorkflowsOutput(ctx.mode, payload));
        return;
      }

      if (ctx.mode === "tui" && workflows.length > 0) {
        const selectedRunId = await selectWorkflowRunId(ctx, workflowRoot, workflows);
        if (selectedRunId !== null)
          await showWorkflowOverview(ctx, workflowRoot, workflows, selectedRunId, controls);
        return;
      }

      ctx.ui.notify(formatWorkflowRunListText(payload), "info");
    },
  });
}

export function createWorkflowRunListPayload(
  workflowRoot: string,
  workflows: WorkflowRunState[],
  sessionId?: string,
): WorkflowRunListPayload {
  return {
    workflowRoot,
    ...(sessionId === undefined ? {} : { sessionId }),
    count: workflows.length,
    workflows: workflows.map((state) => workflowRunSummary(workflowRoot, state)),
  };
}

export function formatWorkflowRunListText(payload: WorkflowRunListPayload): string {
  if (payload.workflows.length === 0) {
    return `/workflows: 表示できるワークフローはありません。\nroot: ${payload.workflowRoot}`;
  }

  return [
    `/workflows: ${payload.workflows.length} 件のワークフロー`,
    `root: ${payload.workflowRoot}`,
    ...payload.workflows.flatMap(formatWorkflowRunSummaryLines),
  ].join("\n");
}

export function formatNonInteractiveWorkflowsOutput(
  mode: ExtensionCommandContext["mode"],
  payload: WorkflowRunListPayload,
): string {
  if (mode === "json") return `${JSON.stringify(payload, null, 2)}\n`;
  return `${formatWorkflowRunListText(payload)}\n`;
}

export function formatWorkflowRunSelectionText(summary: WorkflowRunSummary): string {
  return [
    `/workflows: ワークフロー「${summary.workflowName}」を選択しました。`,
    `runId: ${summary.runId}`,
    `artifacts: ${summary.artifactDir}`,
    ...(summary.outputPath === undefined ? [] : [`output: ${summary.outputPath}`]),
    ...(summary.resultPreview === undefined
      ? []
      : [`result: ${truncateInline(summary.resultPreview, 160)}`]),
  ].join("\n");
}

async function selectWorkflowRunId(
  ctx: ExtensionCommandContext,
  workflowRoot: string,
  workflows: WorkflowRunState[],
): Promise<string | null> {
  const onlyWorkflow = workflows.length === 1 ? workflows[0] : undefined;
  if (onlyWorkflow) return onlyWorkflow.runId;
  return await showWorkflowChooser(ctx, workflowRoot, workflows);
}

async function showWorkflowChooser(
  ctx: ExtensionCommandContext,
  workflowRoot: string,
  workflows: WorkflowRunState[],
): Promise<string | null> {
  return await ctx.ui.custom<string | null>(
    (tui, theme, keybindings, done) =>
      createWorkflowsChooserComponent(
        createWorkflowsProjection(workflowRoot, workflows),
        { requestRender: () => tui.requestRender() },
        theme,
        keybindings,
        done,
      ),
    {
      overlay: true,
      overlayOptions: workflowMonitorOverlayOptions(),
    },
  );
}

async function showWorkflowOverview(
  ctx: ExtensionCommandContext,
  workflowRoot: string,
  workflows: WorkflowRunState[],
  runId: string,
  controls: WorkflowMonitorControlSeams,
): Promise<void> {
  const result = await ctx.ui.custom<WorkflowsOverviewResult>(
    (_tui, theme, keybindings, done) =>
      createWorkflowsOverviewComponent(
        createWorkflowsProjection(workflowRoot, workflows, { runId }, { controls }),
        theme,
        keybindings,
        done,
      ),
    {
      overlay: true,
      overlayOptions: workflowMonitorOverlayOptions(),
    },
  );

  if (result?.type === "openAgentDetail") {
    await showWorkflowAgentDetail(ctx, workflowRoot, workflows, runId, result.agentId, controls);
    return;
  }
  if (result?.type === "controlAction") {
    await executeWorkflowMonitorControl(ctx, workflowRoot, workflows, result.action, controls);
  }
}

async function showWorkflowAgentDetail(
  ctx: ExtensionCommandContext,
  workflowRoot: string,
  workflows: WorkflowRunState[],
  runId: string,
  agentId: string,
  controls: WorkflowMonitorControlSeams,
): Promise<void> {
  const result = await ctx.ui.custom<WorkflowsAgentDetailResult>(
    (_tui, theme, keybindings, done) =>
      createWorkflowsAgentDetailComponent(
        createWorkflowsProjection(workflowRoot, workflows, { runId, agentId }, { controls }),
        theme,
        keybindings,
        done,
      ),
    {
      overlay: true,
      overlayOptions: workflowMonitorOverlayOptions(),
    },
  );

  if (result?.type === "openPromptReader") {
    await showWorkflowPromptReader(ctx, workflowRoot, workflows, runId, result.agentId);
    return;
  }
  if (result?.type === "controlAction") {
    await executeWorkflowMonitorControl(ctx, workflowRoot, workflows, result.action, controls);
  }
}

async function showWorkflowPromptReader(
  ctx: ExtensionCommandContext,
  workflowRoot: string,
  workflows: WorkflowRunState[],
  runId: string,
  agentId: string,
): Promise<void> {
  const fallback = createWorkflowsProjection(workflowRoot, workflows, {
    runId,
    agentId,
  }).promptReader;
  const reader =
    fallback === undefined
      ? undefined
      : await loadWorkflowPromptReaderViewModel({ workflowRoot, runId, agentId, fallback });

  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      createWorkflowsPromptReaderComponent(
        reader,
        { requestRender: () => tui.requestRender() },
        theme,
        keybindings,
        done,
      ),
    {
      overlay: true,
      overlayOptions: workflowMonitorOverlayOptions(),
    },
  );
}

async function executeWorkflowMonitorControl(
  ctx: ExtensionCommandContext,
  workflowRoot: string,
  workflows: WorkflowRunState[],
  action: WorkflowMonitorControlAction,
  controls: WorkflowMonitorControlSeams,
): Promise<void> {
  const context = workflowMonitorControlContext(workflowRoot, workflows, action);
  try {
    const result = await controls.execute(action, context);
    ctx.ui.notify(result.message, workflowMonitorControlNotificationLevel(result.status));
  } catch (error) {
    ctx.ui.notify(`/workflows: 操作に失敗しました: ${errorMessage(error)}`, "error");
  }
}

function workflowMonitorControlContext(
  workflowRoot: string,
  workflows: WorkflowRunState[],
  action: WorkflowMonitorControlAction,
): WorkflowMonitorControlContext {
  const run = workflows.find((candidate) => candidate.runId === action.runId);
  const agent =
    action.agentId === undefined
      ? undefined
      : run?.agents.find((candidate) => candidate.id === action.agentId);
  return {
    workflowRoot,
    runId: action.runId,
    ...(action.agentId === undefined ? {} : { agentId: action.agentId }),
    ...(run === undefined ? {} : { runStatus: run.status }),
    ...(agent === undefined ? {} : { agentStatus: agent.status }),
  };
}

function workflowMonitorControlNotificationLevel(
  status: "completed" | "disabled" | "failed",
): "info" | "warning" | "error" {
  switch (status) {
    case "completed":
      return "info";
    case "disabled":
      return "warning";
    case "failed":
      return "error";
  }
}

function workflowMonitorOverlayOptions() {
  return { width: "90%" as const, maxHeight: "80%" as const, anchor: "center" as const };
}

function workflowRunSummary(workflowRoot: string, state: WorkflowRunState): WorkflowRunSummary {
  return {
    runId: state.runId,
    taskId: state.taskId,
    workflowName: state.workflowName,
    ...(state.description === undefined ? {} : { description: state.description }),
    status: state.status,
    statusLabel: runStatusLabel(state.status),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    cwd: state.cwd,
    artifactDir: join(workflowRoot, state.runId),
    ...(state.workflowProgress.currentPhase === undefined
      ? {}
      : { currentPhase: state.workflowProgress.currentPhase }),
    agentCount: state.agentCount,
    queuedAgents: state.workflowProgress.queuedAgents,
    runningAgents: state.workflowProgress.runningAgents,
    completedAgents: state.workflowProgress.completedAgents,
    failedAgents: state.workflowProgress.failedAgents,
    totalTokens: state.totalTokens,
    totalToolCalls: state.totalToolCalls,
    startTime: state.startTime,
    updatedAt: state.updatedAt,
    ...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
    ...(state.outputPath === undefined ? {} : { outputPath: state.outputPath }),
    ...(state.resultPreview === undefined ? {} : { resultPreview: state.resultPreview }),
    failureCount: state.failures.length,
  };
}

function formatWorkflowRunSummaryLines(summary: WorkflowRunSummary): string[] {
  const phase = summary.currentPhase ? ` / フェーズ: ${summary.currentPhase}` : "";
  const duration = summary.durationMs === undefined ? "" : ` / ${summary.durationMs}ms`;
  const lines = [
    `- ${runStatusIcon(summary.status)} ${summary.workflowName} [${summary.statusLabel}] ${summary.runId}${phase}${duration}`,
    `  エージェント=${summary.agentCount} (待機${summary.queuedAgents}/実行${summary.runningAgents}/完了${summary.completedAgents}/失敗${summary.failedAgents}) tokens=${summary.totalTokens} tools=${summary.totalToolCalls}`,
  ];
  if (summary.outputPath) lines.push(`  output: ${summary.outputPath}`);
  if (summary.resultPreview) lines.push(`  result: ${truncateInline(summary.resultPreview, 160)}`);
  return lines;
}

function truncateInline(text: string, maxChars: number): string {
  const singleLine = text.replaceAll("\n", " ");
  return singleLine.length <= maxChars ? singleLine : `${singleLine.slice(0, maxChars)}…`;
}

function getSessionId(ctx: ExtensionCommandContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId();
  } catch {
    return undefined;
  }
}

function defaultCommandOutput(text: string): void {
  try {
    writeSync(process.stdout.fd, text);
  } catch {
    // Ignore EPIPE or closed stdout in short-lived non-interactive processes.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
