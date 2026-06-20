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
  WorkflowAgentItemViewModel,
  WorkflowPhaseItemViewModel,
  WorkflowRunOverviewViewModel,
  WorkflowsProjectionViewModel,
} from "./workflows-projection";

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

type KeybindingsLike = {
  matches(data: string, id: string): boolean;
};

export type WorkflowsOverviewResult =
  | { type: "openAgentDetail"; agentId: string }
  | { type: "controlAction"; action: WorkflowMonitorControlAction }
  | null;

type Done = (result: WorkflowsOverviewResult) => void;

const MAX_PHASE_ROWS = 8;
const MAX_AGENT_ROWS = 8;

export function createWorkflowsOverviewComponent(
  projection: WorkflowsProjectionViewModel,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: Done,
): Component {
  return new WorkflowsOverviewComponent(projection, theme, keybindings, done);
}

class WorkflowsOverviewComponent implements Component {
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
      if (agentId) this.done({ type: "openAgentDetail", agentId });
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    const add = (line = "") => lines.push(truncateToWidth(line, safeWidth));

    add(accentBorder(this.theme, safeWidth));
    if (this.projection.overview === undefined) {
      add(this.theme.fg("warning", "表示できるワークフローはありません"));
      add(this.theme.fg("dim", "Escで閉じる"));
      add(accentBorder(this.theme, safeWidth));
      return lines;
    }

    this.renderHeader(lines, safeWidth, this.projection.overview);
    add("");
    this.renderMetrics(lines, safeWidth, this.projection.overview);
    add("");
    this.renderPhases(lines, safeWidth, this.projection.phase?.phases ?? []);
    add("");
    this.renderAgents(lines, safeWidth, this.projection.phase?.agents ?? []);
    add("");
    this.renderControls(lines, safeWidth);
    add("");
    add(this.theme.fg("dim", "Enterで選択中エージェント詳細 · 操作キーで実行 · Escで閉じる"));
    add(accentBorder(this.theme, safeWidth));
    return lines;
  }

  private renderHeader(
    lines: string[],
    width: number,
    overview: WorkflowRunOverviewViewModel,
  ): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    const addWrapped = (line: string, prefix = "") => {
      const contentWidth = Math.max(1, width - visibleWidth(prefix));
      for (const wrapped of wrapTextWithAnsi(line, contentWidth)) add(`${prefix}${wrapped}`);
    };

    add(
      this.theme.fg(
        "accent",
        this.theme.bold(
          `${overview.statusIcon} ${overview.workflowName} [${overview.statusLabel}]`,
        ),
      ),
    );
    if (overview.description) addWrapped(this.theme.fg("muted", overview.description), "説明: ");
    addWrapped(this.theme.fg("dim", overview.runId), "runId: ");
    addWrapped(this.theme.fg("dim", overview.artifactDir), "成果物: ");
    if (overview.outputPath) addWrapped(this.theme.fg("dim", overview.outputPath), "output: ");
    add(this.theme.fg("dim", `開始: ${overview.startTime} · 更新: ${overview.updatedAt}`));
  }

  private renderMetrics(
    lines: string[],
    width: number,
    overview: WorkflowRunOverviewViewModel,
  ): void {
    const metrics = overview.metrics;
    const duration = metrics.durationMs === undefined ? "" : ` · 時間 ${metrics.durationMs}ms`;
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "muted",
          `メトリクス: エージェント ${metrics.agentCount} (待機${metrics.queuedAgents}/実行${metrics.runningAgents}/完了${metrics.completedAgents}/失敗${metrics.failedAgents}) · tokens ${metrics.totalTokens} · tools ${metrics.totalToolCalls}${duration}`,
        ),
        width,
      ),
    );
  }

  private renderPhases(lines: string[], width: number, phases: WorkflowPhaseItemViewModel[]): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    add(this.theme.fg("accent", this.theme.bold("フェーズ")));
    if (phases.length === 0) {
      add(this.theme.fg("dim", "  フェーズはありません"));
      return;
    }

    const selectedTitle = this.projection.phase?.selectedPhaseTitle;
    for (const phase of phases.slice(0, MAX_PHASE_ROWS)) {
      const selected = phase.title === selectedTitle;
      const pointer = selected ? "› " : "  ";
      const row = `${pointer}${phase.statusIcon} ${phase.title} [${phase.statusLabel}] · agents ${phase.agentCount}`;
      add(selected ? this.theme.fg("accent", this.theme.bold(row)) : row);
    }
    if (phases.length > MAX_PHASE_ROWS) {
      add(this.theme.fg("dim", `  …他 ${phases.length - MAX_PHASE_ROWS} フェーズ`));
    }
  }

  private renderAgents(lines: string[], width: number, agents: WorkflowAgentItemViewModel[]): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    const addWrapped = (line: string, prefix = "") => {
      const contentWidth = Math.max(1, width - visibleWidth(prefix));
      for (const wrapped of wrapTextWithAnsi(line, contentWidth)) add(`${prefix}${wrapped}`);
    };
    const title = this.projection.phase?.selectedPhaseTitle ?? "全体";
    add(this.theme.fg("accent", this.theme.bold(`選択中フェーズのエージェント: ${title}`)));
    if (agents.length === 0) {
      add(this.theme.fg("dim", "  エージェントはまだありません"));
      return;
    }

    for (const agent of agents.slice(0, MAX_AGENT_ROWS)) {
      const row = `- ${agent.statusIcon} ${agent.label} [${agent.statusLabel}]`;
      add(colorAgentRow(this.theme, agent, row));
      addWrapped(this.theme.fg("dim", agent.promptPreview), "    prompt: ");
      if (agent.resultPreview)
        addWrapped(this.theme.fg("muted", agent.resultPreview), "    result: ");
      if (agent.error) addWrapped(this.theme.fg("warning", agent.error), "    error: ");
    }
    if (agents.length > MAX_AGENT_ROWS) {
      add(this.theme.fg("dim", `  …他 ${agents.length - MAX_AGENT_ROWS} エージェント`));
    }
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

function colorAgentRow(theme: ThemeLike, agent: WorkflowAgentItemViewModel, row: string): string {
  switch (agent.status) {
    case "running":
      return theme.fg("accent", row);
    case "completed":
      return theme.fg("success", row);
    case "failed":
      return theme.fg("warning", row);
    case "cancelled":
      return theme.fg("dim", row);
    case "queued":
      return row;
  }
}
