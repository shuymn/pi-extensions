import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { accentBorder, printableInput } from "../../lib/tui";
import {
  type AskUiResult,
  createQuestionnaireState,
  type QuestionnaireAction,
  type QuestionnaireSnapshot,
  questionnaireActionLabel,
  questionnaireSnapshot,
  updateQuestionnaireState,
} from "./state";
import type { AskUserQuestionParams } from "./types";
import { CHAT_ABOUT_THIS_LABEL, NEXT_QUESTION_LABEL, TYPE_SOMETHING_LABEL } from "./types";

export type { AskUiResult } from "./state";

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

type KeybindingsLike = {
  matches(data: string, id: string): boolean;
};

type TuiLike = { requestRender: () => void };

type Done = (result: AskUiResult | null) => void;

export function createQuestionnaireComponent(
  params: AskUserQuestionParams,
  tui: TuiLike,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: Done,
) {
  // Honor the user's tui.select.* keybindings for navigation, falling back to
  // the default arrow/enter/escape keys when no custom binding matches.
  const matchesSelect = (
    data: string,
    id: string,
    fallback: Parameters<typeof matchesKey>[1],
  ): boolean => (keybindings.matches?.(data, id) ?? false) || matchesKey(data, fallback);
  const state = createQuestionnaireState(params);

  function refresh() {
    tui.requestRender();
  }

  function apply(action: QuestionnaireAction) {
    const result = updateQuestionnaireState(state, action);
    if (result.terminal) {
      done(result.terminal);
      return;
    }
    if (result.changed) refresh();
  }

  function handleInput(data: string) {
    const snapshot = questionnaireSnapshot(state);

    if (snapshot.mode === "summary") {
      if (matchesSelect(data, "tui.select.confirm", Key.enter)) apply({ type: "confirm" });
      else if (matchesSelect(data, "tui.select.cancel", Key.escape)) apply({ type: "cancel" });
      return;
    }

    if (snapshot.mode === "custom" || snapshot.mode === "chat") {
      if (matchesKey(data, Key.enter)) {
        apply({ type: "confirm" });
        return;
      }
      if (matchesKey(data, Key.escape)) {
        apply({ type: "cancel" });
        return;
      }
      if (matchesKey(data, Key.backspace) || matchesKey(data, Key.ctrl("h"))) {
        apply({ type: "backspace" });
        return;
      }
      const printable = printableInput(data);
      if (printable) apply({ type: "appendInput", text: printable });
      return;
    }

    if (matchesSelect(data, "tui.select.cancel", Key.escape)) {
      apply({ type: "cancel" });
      return;
    }
    if (matchesSelect(data, "tui.select.up", Key.up)) {
      apply({ type: "move", delta: -1 });
      return;
    }
    if (matchesSelect(data, "tui.select.down", Key.down)) {
      apply({ type: "move", delta: 1 });
      return;
    }
    if (
      matchesKey(data, Key.space) &&
      snapshot.currentQuestion?.multiSelect === true &&
      snapshot.selectedIndex < snapshot.currentQuestion.options.length
    ) {
      apply({ type: "toggle" });
      return;
    }
    if (matchesSelect(data, "tui.select.confirm", Key.enter)) apply({ type: "confirm" });
  }

  function renderOptionLine(
    snapshot: QuestionnaireSnapshot,
    width: number,
    index: number,
    label: string,
    description?: string,
    checked?: boolean,
  ): string[] {
    const selected = index === snapshot.selectedIndex;
    const pointerText = selected ? "> " : "  ";
    const checkboxText = checked === undefined ? "" : checked ? "[✓] " : "[ ] ";
    const indexPrefix = `${index + 1}. `;
    const prefixWidth = visibleWidth(pointerText + checkboxText + indexPrefix);
    const pointer = selected ? theme.fg("accent", pointerText) : pointerText;
    const checkbox =
      checked === undefined
        ? ""
        : checked
          ? theme.fg("success", checkboxText)
          : theme.fg("dim", checkboxText);
    const title = selected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
    const titlePrefix = `${pointer}${checkbox}${indexPrefix}`;
    if (width <= prefixWidth) return [truncateToWidth(`${titlePrefix}${title}`, width)];

    const contentWidth = width - prefixWidth;
    const padding = " ".repeat(prefixWidth);
    const titleLines = wrapTextWithAnsi(title, contentWidth);
    const lines = titleLines.map((line, lineIndex) =>
      truncateToWidth(`${lineIndex === 0 ? titlePrefix : padding}${line}`, width),
    );
    if (description) {
      for (const line of wrapTextWithAnsi(theme.fg("muted", description), contentWidth)) {
        lines.push(truncateToWidth(`${padding}${line}`, width));
      }
    }
    return lines;
  }

  function render(width: number): string[] {
    const snapshot = questionnaireSnapshot(state);
    const q = snapshot.currentQuestion;
    const lines: string[] = [];
    const add = (line = "") => lines.push(truncateToWidth(line, width));
    const addWrapped = (line = "", prefix = "") => {
      if (!line) {
        add("");
        return;
      }
      const wrapped = wrapTextWithAnsi(line, Math.max(1, width - visibleWidth(prefix)));
      for (const wrappedLine of wrapped) add(`${prefix}${wrappedLine}`);
    };

    add(accentBorder(theme, width));
    add(
      `${theme.fg("toolTitle", theme.bold("ask_user_question"))} ${theme.fg("muted", `${snapshot.questionIndex + 1}/${snapshot.questionCount}`)}`,
    );
    add("");

    if (snapshot.mode === "summary") {
      add(theme.fg("success", theme.bold("Ready to submit")));
      add("");
      for (const answer of snapshot.answers) {
        const value =
          answer.kind === "multi" ? answer.selected.join(", ") : (answer.answer ?? "(no response)");
        addWrapped(value, `Q${answer.questionIndex + 1}: `);
      }
      add("");
      add(theme.fg("dim", "Enter submit • Esc cancel"));
      add(accentBorder(theme, width));
      return lines;
    }

    if (!q) {
      add(theme.fg("warning", "No question"));
      return lines;
    }

    add(theme.fg("accent", theme.bold(q.header)));
    addWrapped(theme.fg("text", theme.bold(q.question)));
    add("");

    if (snapshot.mode === "custom" || snapshot.mode === "chat") {
      add(
        theme.fg(
          "accent",
          snapshot.mode === "custom"
            ? "Type your answer:"
            : "What would you like to discuss or clarify?",
        ),
      );
      addWrapped(snapshot.inputDraft || theme.fg("dim", "(empty)"));
      add("");
      add(theme.fg("dim", "Enter submit • Esc back"));
      add(accentBorder(theme, width));
      return lines;
    }

    if (snapshot.notice) {
      add(theme.fg("warning", snapshot.notice));
      add("");
    }

    if (q.multiSelect === true) {
      for (const [index, option] of q.options.entries()) {
        lines.push(
          ...renderOptionLine(
            snapshot,
            width,
            index,
            option.label,
            option.description,
            snapshot.selectedMultiIndexes.has(index),
          ),
        );
      }
      lines.push(
        ...renderOptionLine(
          snapshot,
          width,
          q.options.length,
          questionnaireActionLabel(snapshot, q.options.length) ?? NEXT_QUESTION_LABEL,
          "Submit selected options.",
        ),
      );
      lines.push(
        ...renderOptionLine(
          snapshot,
          width,
          q.options.length + 1,
          questionnaireActionLabel(snapshot, q.options.length + 1) ?? CHAT_ABOUT_THIS_LABEL,
          "Pause and discuss this question.",
        ),
      );
      add("");
      add(theme.fg("dim", "↑↓ navigate • Space toggle • Enter confirm • Esc cancel"));
    } else {
      q.options.forEach((option, index) => {
        lines.push(...renderOptionLine(snapshot, width, index, option.label, option.description));
        if (option.preview && index === snapshot.selectedIndex) {
          add(`     ${theme.fg("dim", "Preview:")}`);
          for (const previewLine of option.preview.split("\n").slice(0, 8))
            addWrapped(theme.fg("muted", previewLine), "     ");
        }
      });
      lines.push(
        ...renderOptionLine(
          snapshot,
          width,
          q.options.length,
          questionnaireActionLabel(snapshot, q.options.length) ?? TYPE_SOMETHING_LABEL,
          "Enter a custom answer.",
        ),
      );
      lines.push(
        ...renderOptionLine(
          snapshot,
          width,
          q.options.length + 1,
          questionnaireActionLabel(snapshot, q.options.length + 1) ?? CHAT_ABOUT_THIS_LABEL,
          "Pause and discuss this question.",
        ),
      );
      add("");
      add(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
    }

    add(accentBorder(theme, width));
    return lines;
  }

  return { render, handleInput, invalidate: refresh };
}
