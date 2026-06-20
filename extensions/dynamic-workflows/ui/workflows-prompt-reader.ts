import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { accentBorder } from "../../../lib/tui";
import type { WorkflowPromptReaderViewModel } from "./workflows-projection";

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

type Done = (result: null) => void;

const MAX_VISIBLE_PROMPT_LINES = 18;

export function createWorkflowsPromptReaderComponent(
  reader: WorkflowPromptReaderViewModel | undefined,
  tui: TuiLike,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: Done,
): Component {
  return new WorkflowsPromptReaderComponent(reader, tui, theme, keybindings, done);
}

class WorkflowsPromptReaderComponent implements Component {
  private scrollOffset = 0;
  private lastContentLineCount = 0;

  constructor(
    private readonly reader: WorkflowPromptReaderViewModel | undefined,
    private readonly tui: TuiLike,
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
    if (this.matchesSelect(data, "tui.select.up", Key.up)) {
      this.moveScroll(-1);
      return;
    }
    if (this.matchesSelect(data, "tui.select.down", Key.down)) {
      this.moveScroll(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveScroll(-MAX_VISIBLE_PROMPT_LINES);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveScroll(MAX_VISIBLE_PROMPT_LINES);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.setScroll(0);
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.setScroll(Number.MAX_SAFE_INTEGER);
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    const add = (line = "") => lines.push(truncateToWidth(line, safeWidth));

    add(accentBorder(this.theme, safeWidth));
    if (this.reader === undefined) {
      add(this.theme.fg("warning", "表示できるプロンプトはありません"));
      add(this.theme.fg("dim", "Escで閉じる"));
      add(accentBorder(this.theme, safeWidth));
      return lines;
    }

    const promptLines = promptContentLines(this.reader.prompt, safeWidth);
    this.lastContentLineCount = promptLines.length;
    const maxOffset = Math.max(0, promptLines.length - MAX_VISIBLE_PROMPT_LINES);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
    const end = Math.min(this.scrollOffset + MAX_VISIBLE_PROMPT_LINES, promptLines.length);

    add(this.theme.fg("accent", this.theme.bold(`元プロンプト: ${this.reader.title}`)));
    add(this.theme.fg("muted", sourceLine(this.reader)));
    if (this.reader.transcriptPath) {
      addWrapped(
        lines,
        safeWidth,
        this.theme.fg("dim", this.reader.transcriptPath),
        "transcript: ",
      );
    }
    add(
      this.theme.fg(
        "dim",
        `行 ${promptLines.length === 0 ? 0 : this.scrollOffset + 1}-${end}/${promptLines.length}`,
      ),
    );
    add("");

    for (const line of promptLines.slice(this.scrollOffset, end)) add(line);
    if (promptLines.length === 0) add(this.theme.fg("dim", "  空のプロンプトです"));

    add("");
    add(this.theme.fg("dim", "↑↓/PageUp/PageDownでスクロール · Home/Endで先頭/末尾 · Escで閉じる"));
    add(accentBorder(this.theme, safeWidth));
    return lines;
  }

  private moveScroll(delta: number): void {
    this.setScroll(this.scrollOffset + delta);
  }

  private setScroll(nextOffset: number): void {
    const maxOffset = Math.max(0, this.lastContentLineCount - MAX_VISIBLE_PROMPT_LINES);
    this.scrollOffset = Math.max(0, Math.min(nextOffset, maxOffset));
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

function promptContentLines(prompt: string, width: number): string[] {
  const prefix = "  ";
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  const lines: string[] = [];
  for (const paragraph of prompt.split("\n")) {
    if (paragraph === "") {
      lines.push(prefix);
      continue;
    }
    for (const wrapped of wrapTextWithAnsi(paragraph, contentWidth)) {
      lines.push(truncateToWidth(`${prefix}${wrapped}`, width));
    }
  }
  return lines;
}

function addWrapped(lines: string[], width: number, text: string, prefix = ""): void {
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  for (const wrapped of wrapTextWithAnsi(text, contentWidth)) {
    lines.push(truncateToWidth(`${prefix}${wrapped}`, width));
  }
}

function sourceLine(reader: WorkflowPromptReaderViewModel): string {
  const source = (() => {
    switch (reader.source) {
      case "transcriptPrompt":
        return "transcript metadata.prompt";
      case "transcriptSessionPrompt":
        return "transcript metadata.sessionPrompt";
      case "manifestPromptPreview":
        return "manifest prompt preview";
    }
  })();
  return `取得元: ${source} · ${reader.isFullPrompt ? "全量" : "preview fallback"}`;
}
