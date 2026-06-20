import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { accentBorder } from "../../../lib/tui";
import type {
  WorkflowChooserItemViewModel,
  WorkflowsProjectionViewModel,
} from "./workflows-projection";

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

type KeybindingsLike = {
  matches(data: string, id: string): boolean;
};

type TuiLike = {
  requestRender(): void;
};

type Done = (runId: string | null) => void;

const MAX_VISIBLE_RUNS = 8;

export function createWorkflowsChooserComponent(
  projection: WorkflowsProjectionViewModel,
  tui: TuiLike,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: Done,
): Component {
  return new WorkflowsChooserComponent(projection, tui, theme, keybindings, done);
}

class WorkflowsChooserComponent implements Component {
  private selectedIndex: number;

  constructor(
    private readonly projection: WorkflowsProjectionViewModel,
    private readonly tui: TuiLike,
    private readonly theme: ThemeLike,
    private readonly keybindings: KeybindingsLike,
    private readonly done: Done,
  ) {
    this.selectedIndex = Math.max(
      0,
      this.projection.chooser.findIndex((item) => item.runId === this.projection.selectedRunId),
    );
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.matchesSelect(data, "tui.select.cancel", Key.escape)) {
      this.done(null);
      return;
    }

    if (this.matchesSelect(data, "tui.select.up", Key.up)) {
      this.moveSelection(-1);
      return;
    }

    if (this.matchesSelect(data, "tui.select.down", Key.down)) {
      this.moveSelection(1);
      return;
    }

    if (this.matchesSelect(data, "tui.select.confirm", Key.enter)) {
      this.done(this.projection.chooser[this.selectedIndex]?.runId ?? null);
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    const add = (line = "") => lines.push(truncateToWidth(line, safeWidth));
    add(accentBorder(this.theme, safeWidth));
    add(
      `${this.theme.fg("accent", this.theme.bold("/workflows"))} ${this.theme.fg("muted", `${this.projection.chooser.length} 件`)}`,
    );
    add(this.theme.fg("dim", "表示するワークフローを選択してください"));
    add("");

    if (this.projection.chooser.length === 0) {
      add(this.theme.fg("warning", "表示できるワークフローはありません"));
    } else {
      const { start, end } = this.visibleWindow();
      for (let index = start; index < end; index++) {
        const item = this.projection.chooser[index];
        if (!item) continue;
        this.renderRun(lines, safeWidth, item, index === this.selectedIndex);
      }

      if (start > 0 || end < this.projection.chooser.length) {
        add(
          this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.projection.chooser.length})`),
        );
      }
    }

    add("");
    add(this.theme.fg("dim", "↑↓で移動 · Enterで選択 · Escで閉じる"));
    add(accentBorder(this.theme, safeWidth));
    return lines;
  }

  private renderRun(
    lines: string[],
    width: number,
    item: WorkflowChooserItemViewModel,
    selected: boolean,
  ): void {
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    const addWrapped = (line: string, prefix = "") => {
      const contentWidth = Math.max(1, width - visibleWidth(prefix));
      for (const wrapped of wrapTextWithAnsi(line, contentWidth)) add(`${prefix}${wrapped}`);
    };
    const pointer = selected ? "› " : "  ";
    const phase = item.currentPhase ? ` · フェーズ: ${item.currentPhase}` : "";
    const primary = `${pointer}${item.statusIcon} ${item.workflowName} [${item.statusLabel}]${phase}`;
    add(selected ? this.theme.fg("accent", this.theme.bold(primary)) : primary);

    const secondary = `${item.runId} · ${item.agentSummary} · 更新: ${item.updatedAt}`;
    add(this.theme.fg(selected ? "muted" : "dim", `    ${secondary}`));

    if (!selected) return;
    if (item.description) addWrapped(this.theme.fg("muted", item.description), "    説明: ");
    addWrapped(this.theme.fg("dim", item.artifactDir), "    成果物: ");
  }

  private visibleWindow(): { start: number; end: number } {
    const itemCount = this.projection.chooser.length;
    const maxVisible = Math.max(1, Math.min(MAX_VISIBLE_RUNS, itemCount));
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(maxVisible / 2), itemCount - maxVisible),
    );
    return { start, end: Math.min(start + maxVisible, itemCount) };
  }

  private moveSelection(delta: number): void {
    if (this.projection.chooser.length === 0) return;
    const next = this.selectedIndex + delta;
    this.selectedIndex =
      next < 0
        ? this.projection.chooser.length - 1
        : next >= this.projection.chooser.length
          ? 0
          : next;
    this.tui.requestRender();
  }

  private matchesSelect(
    data: string,
    id: string,
    fallback: Parameters<typeof matchesKey>[1],
  ): boolean {
    return this.keybindings.matches(data, id) || matchesKey(data, fallback);
  }
}
