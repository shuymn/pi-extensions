import type { WorkflowAgentStatus, WorkflowPhaseStatus, WorkflowRunStatus } from "../run/model";

export type WorkflowStatusViewModel<TStatus extends string> = {
  status: TStatus;
  statusLabel: string;
  statusIcon: string;
};

export function runStatusView(
  status: WorkflowRunStatus,
): WorkflowStatusViewModel<WorkflowRunStatus> {
  return { status, statusLabel: runStatusLabel(status), statusIcon: runStatusIcon(status) };
}

export function phaseStatusView(
  status: WorkflowPhaseStatus,
): WorkflowStatusViewModel<WorkflowPhaseStatus> {
  return { status, statusLabel: phaseStatusLabel(status), statusIcon: phaseStatusIcon(status) };
}

export function agentStatusView(
  status: WorkflowAgentStatus,
): WorkflowStatusViewModel<WorkflowAgentStatus> {
  return { status, statusLabel: agentStatusLabel(status), statusIcon: agentStatusIcon(status) };
}

export function runStatusLabel(status: WorkflowRunStatus): string {
  switch (status) {
    case "queued":
      return "待機中";
    case "running":
      return "実行中";
    case "completed":
      return "完了";
    case "failed":
      return "失敗";
    case "cancelled":
      return "キャンセル";
  }
}

export function phaseStatusLabel(status: WorkflowPhaseStatus): string {
  switch (status) {
    case "pending":
      return "未開始";
    case "running":
      return "実行中";
    case "completed":
      return "完了";
    case "failed":
      return "失敗";
    case "cancelled":
      return "キャンセル";
    case "skipped":
      return "スキップ";
  }
}

export function agentStatusLabel(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "待機中";
    case "running":
      return "実行中";
    case "completed":
      return "完了";
    case "failed":
      return "失敗";
    case "cancelled":
      return "キャンセル";
  }
}

export function runStatusIcon(status: WorkflowRunStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "◐";
    case "completed":
      return "✓";
    case "failed":
      return "!";
    case "cancelled":
      return "×";
  }
}

export function phaseStatusIcon(status: WorkflowPhaseStatus): string {
  return status === "pending" || status === "skipped" ? "○" : runStatusIcon(status);
}

export function agentStatusIcon(status: WorkflowAgentStatus): string {
  return runStatusIcon(status);
}
