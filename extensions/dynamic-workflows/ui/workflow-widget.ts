import {
  clearWidget,
  setAboveEditorWidget,
  type WidgetContext as TuiWidgetContext,
} from "../../../lib/tui";
import {
  treeBranch,
  truncateWidgetLines,
  type WidgetLine,
  widgetLinesToText,
  widgetStatusIcon,
} from "../../../lib/widget-view";
import type { WorkflowAgentStatus, WorkflowRunState, WorkflowRunStatus } from "../run/model";
import { runStatusLabel } from "./status-view";

export const DYNAMIC_WORKFLOW_WIDGET_KEY = "dynamic-workflow";

export type WorkflowWidgetContext = TuiWidgetContext & { hasUI?: boolean };

type ActiveWorkflowRunStatus = Extract<WorkflowRunStatus, "queued" | "running">;

export function refreshWorkflowWidget(ctx: unknown, state: WorkflowRunState): void {
  if (!isWorkflowWidgetContext(ctx) || ctx.hasUI === false) return;

  const lines = renderActiveWorkflowWidgetText(state, { maxLines: 12 });
  if (!lines) {
    clearWidget(ctx, DYNAMIC_WORKFLOW_WIDGET_KEY);
    return;
  }

  setAboveEditorWidget(ctx, DYNAMIC_WORKFLOW_WIDGET_KEY, lines);
}

export function clearWorkflowWidget(ctx: unknown): void {
  if (!isWorkflowWidgetContext(ctx) || ctx.hasUI === false) return;
  clearWidget(ctx, DYNAMIC_WORKFLOW_WIDGET_KEY);
}

export function renderActiveWorkflowWidgetText(
  state: WorkflowRunState,
  options: { width?: number; maxLines?: number } = {},
): string[] | undefined {
  const lines = renderActiveWorkflowWidgetLines(state, options);
  return lines ? widgetLinesToText(lines) : undefined;
}

export function renderActiveWorkflowWidgetLines(
  state: WorkflowRunState,
  options: { width?: number; maxLines?: number } = {},
): WidgetLine[] | undefined {
  if (!isActiveStatus(state.status)) return undefined;

  const width = options.width ?? 80;
  const maxLines = options.maxLines ?? 12;
  if (maxLines <= 0) return [];

  const lines: WidgetLine[] = [
    {
      text: `● ワークフロー「${state.workflowName}」 ${runStatusLabel(state.status)}`,
      color: state.status === "running" ? "accent" : "dim",
    },
  ];
  if (maxLines === 1) return truncateWidgetLines(lines, width);

  const rows = buildRows(state);
  const rowCapacity = maxLines - 1;
  const shownCount = rows.length > rowCapacity ? Math.max(0, rowCapacity - 1) : rowCapacity;
  const shown = rows.slice(0, shownCount);
  const hidden = rows.length - shown.length;
  const renderedRows = shown.length + (hidden > 0 ? 1 : 0);

  for (const [index, row] of shown.entries()) {
    lines.push({ ...row, text: `${treeBranch(index, renderedRows)} ${row.text}` });
  }
  appendJapaneseOverflowLine(lines, hidden, maxLines);

  return truncateWidgetLines(lines, width);
}

function appendJapaneseOverflowLine(lines: WidgetLine[], hidden: number, maxLines: number): void {
  if (hidden <= 0 || maxLines <= 0 || lines.length >= maxLines) return;
  lines.push({ text: `└─ 他${hidden}件`, color: "dim", dim: true });
}

function buildRows(state: WorkflowRunState): WidgetLine[] {
  const rows: WidgetLine[] = [];
  const currentPhase = state.workflowProgress.currentPhase;
  if (currentPhase) {
    rows.push({
      text: `${widgetStatusIcon("running")} フェーズ: ${currentPhase}`,
      color: "accent",
    });
  }

  rows.push({
    text: `エージェント: 待機${state.workflowProgress.queuedAgents} 実行${state.workflowProgress.runningAgents} 完了${state.workflowProgress.completedAgents} 失敗${state.workflowProgress.failedAgents}`,
    color: state.workflowProgress.failedAgents > 0 ? "warning" : "dim",
  });

  const activeAgents = state.agents.filter(
    (agent) => agent.status === "queued" || agent.status === "running" || agent.status === "failed",
  );
  const recentAgents = activeAgents.length > 0 ? activeAgents : state.agents.slice(-3);
  for (const agent of recentAgents) {
    rows.push({
      text: `${widgetStatusIcon(agentStatusToWidgetStatus(agent.status))} ${agent.label}${agent.phase ? ` [${agent.phase}]` : ""}${agent.error ? ` — ${agent.error}` : ""}`,
      ...colorForAgentStatus(agent.status),
    });
  }

  const latestLog = state.logs.at(-1);
  if (latestLog) rows.push({ text: `ログ: ${latestLog}`, color: "dim" });

  return rows;
}

function isActiveStatus(status: WorkflowRunStatus): status is ActiveWorkflowRunStatus {
  return status === "queued" || status === "running";
}

function agentStatusToWidgetStatus(status: WorkflowAgentStatus) {
  return status === "cancelled"
    ? "cancelled"
    : status === "failed"
      ? "failed"
      : status === "completed"
        ? "completed"
        : status;
}

function colorForAgentStatus(status: WorkflowAgentStatus): Pick<WidgetLine, "color" | "dim"> {
  switch (status) {
    case "running":
      return { color: "accent" };
    case "completed":
      return { color: "success", dim: true };
    case "failed":
      return { color: "warning" };
    case "cancelled":
      return { color: "warning", dim: true };
    case "queued":
      return { color: "dim" };
  }
}

function isWorkflowWidgetContext(ctx: unknown): ctx is WorkflowWidgetContext {
  return (
    typeof ctx === "object" &&
    ctx !== null &&
    "ui" in ctx &&
    typeof (ctx as { ui?: { setWidget?: unknown } }).ui?.setWidget === "function"
  );
}
