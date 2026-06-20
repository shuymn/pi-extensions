import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { accentBorder } from "../../../lib/tui";
import {
  formatWorkflowMonitorControls,
  type WorkflowMonitorControlAction,
  workflowMonitorControlActionForInput,
} from "./workflows-controls";
import type {
  WorkflowAgentDetailViewModel,
  WorkflowsProjectionViewModel,
} from "./workflows-projection";

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

type KeybindingsLike = {
  matches(data: string, id: string): boolean;
};

export type WorkflowsAgentDetailResult =
  | { type: "openPromptReader"; agentId: string }
  | { type: "controlAction"; action: WorkflowMonitorControlAction }
  | null;

type Done = (result: WorkflowsAgentDetailResult) => void;

export function createWorkflowsAgentDetailComponent(
  projection: WorkflowsProjectionViewModel,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: Done,
): Component {
  return new WorkflowsAgentDetailComponent(projection, theme, keybindings, done);
}

class WorkflowsAgentDetailComponent implements Component {
  constructor(
    private readonly projection: WorkflowsProjectionViewModel,
    private readonly theme: ThemeLike,
    private readonly keybindings: KeybindingsLike,
    private readonly done: Done,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.matchesSelect(data, "tui.select.cancel", Key.escape)) {
      this.done(null);
      return;
    }
    const controlAction = workflowMonitorControlActionForInput(this.projection.controls, data);
    if (controlAction !== undefined) {
      this.done({ type: "controlAction", action: controlAction });
      return;
    }
    if (this.matchesSelect(data, "tui.select.confirm", Key.enter)) {
      const agentId = this.projection.agentDetail?.id;
      if (agentId) this.done({ type: "openPromptReader", agentId });
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    const add = (line = "") => lines.push(truncateToWidth(line, safeWidth));

    add(accentBorder(this.theme, safeWidth));
    if (this.projection.agentDetail === undefined) {
      add(this.theme.fg("warning", "表示できるエージェント詳細はありません"));
      add(this.theme.fg("dim", "Escで閉じる"));
      add(accentBorder(this.theme, safeWidth));
      return lines;
    }

    this.renderHeader(lines, safeWidth, this.projection.agentDetail);
    add("");
    this.renderPrompt(lines, safeWidth, this.projection.agentDetail);
    add("");
    this.renderActivity(lines, safeWidth, this.projection.agentDetail);
    add("");
    this.renderOutcome(lines, safeWidth, this.projection.agentDetail);
    add("");
    this.renderControls(lines, safeWidth);
    add("");
    add(this.theme.fg("dim", "Enterでfull prompt表示 · 操作キーで実行 · Escで閉じる"));
    add(accentBorder(this.theme, safeWidth));
    return lines;
  }

  private renderHeader(lines: string[], width: number, agent: WorkflowAgentDetailViewModel): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    add(
      this.theme.fg(
        statusColor(agent.status),
        this.theme.bold(`${agent.statusIcon} ${agent.label} [${agent.statusLabel}]`),
      ),
    );
    add(
      this.theme.fg(
        "muted",
        `状態: ${agent.statusLabel} · フェーズ: ${agent.phase ?? "未記録"} · model: 未記録`,
      ),
    );
    add(
      this.theme.fg(
        "dim",
        `メトリクス: duration ${formatDuration(agent)} · tokens 未記録 · tools 未記録`,
      ),
    );
  }

  private renderPrompt(lines: string[], width: number, agent: WorkflowAgentDetailViewModel): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    add(this.theme.fg("accent", this.theme.bold("Prompt preview")));
    addWrapped(lines, width, this.theme.fg("text", agent.promptPreview), "  ");
  }

  private renderActivity(
    lines: string[],
    width: number,
    agent: WorkflowAgentDetailViewModel,
  ): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    add(this.theme.fg("accent", this.theme.bold("Recent activity")));
    for (const line of activityDigest(agent)) add(this.theme.fg("dim", `  ${line}`));
  }

  private renderOutcome(lines: string[], width: number, agent: WorkflowAgentDetailViewModel): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    add(this.theme.fg("accent", this.theme.bold("Outcome preview")));
    if (agent.error) {
      addWrapped(lines, width, this.theme.fg("warning", agent.error), "  error: ");
      return;
    }
    if (agent.resultPreview) {
      addWrapped(lines, width, this.theme.fg("muted", agent.resultPreview), "  result: ");
      return;
    }
    add(this.theme.fg("dim", `  ${pendingOutcome(agent.status)}`));
  }

  private renderControls(lines: string[], width: number): void {
    const controls = formatWorkflowMonitorControls(this.projection.controls);
    if (controls.length === 0) return;
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    add(this.theme.fg("accent", this.theme.bold("操作")));
    for (const line of controls) add(this.theme.fg("dim", `  ${line}`));
  }

  private matchesSelect(
    data: string,
    id: string,
    fallback: Parameters<typeof matchesKey>[1],
  ): boolean {
    return this.keybindings.matches(data, id) || matchesKey(data, fallback);
  }
}

function addWrapped(lines: string[], width: number, text: string, prefix = ""): void {
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  for (const wrapped of wrapTextWithAnsi(text, contentWidth)) {
    lines.push(truncateToWidth(`${prefix}${wrapped}`, width));
  }
}

function activityDigest(agent: WorkflowAgentDetailViewModel): string[] {
  const lines = [`queued: ${agent.timing.queuedAt}`];
  lines.push(agent.timing.startedAt ? `started: ${agent.timing.startedAt}` : "started: 未開始");
  if (agent.timing.completedAt) lines.push(`completed: ${agent.timing.completedAt}`);
  if (agent.error) lines.push(`error: ${agent.error}`);
  if (agent.status === "running") lines.push("現在実行中");
  if (agent.status === "queued") lines.push("待機中");
  return lines;
}

function formatDuration(agent: WorkflowAgentDetailViewModel): string {
  const start = agent.startedAt ?? agent.queuedAt;
  const end = agent.completedAt;
  if (end === undefined) return "未確定";
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) ? `${Math.max(0, duration)}ms` : "未記録";
}

function pendingOutcome(status: WorkflowAgentDetailViewModel["status"]): string {
  switch (status) {
    case "queued":
      return "まだ開始していません";
    case "running":
      return "実行中です";
    case "completed":
      return "結果previewは記録されていません";
    case "failed":
      return "エラーpreviewは記録されていません";
    case "cancelled":
      return "キャンセルされました";
  }
}

function statusColor(status: WorkflowAgentDetailViewModel["status"]): string {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "warning";
    case "running":
      return "accent";
    case "cancelled":
      return "dim";
    case "queued":
      return "text";
  }
}
