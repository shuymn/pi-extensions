import { describe, expect, test } from "bun:test";
import {
  createQuestionnaireState,
  questionnaireActionLabel,
  questionnaireSnapshot,
  updateQuestionnaireState,
} from "./state";
import type { AskUserQuestionParams } from "./types";

function params(overrides: Partial<AskUserQuestionParams> = {}): AskUserQuestionParams {
  return {
    questions: [
      {
        question: "Which database should we use?",
        header: "Database",
        options: [
          { label: "SQLite", description: "Local embedded storage.", preview: "file.db" },
          { label: "PostgreSQL", description: "Networked relational database." },
        ],
      },
      {
        question: "Which surfaces need tests?",
        header: "Tests",
        multiSelect: true,
        options: [
          { label: "API", description: "Tool execution behavior." },
          { label: "UI", description: "Interactive questionnaire behavior." },
        ],
      },
    ],
    ...overrides,
  };
}

describe("questionnaire state", () => {
  test("snapshot does not create multi-select state", () => {
    const state = createQuestionnaireState(params());

    expect(state.multiSelections.size).toBe(0);
    expect(questionnaireSnapshot(state).selectedMultiIndexes).toEqual(new Set());
    expect(state.multiSelections.size).toBe(0);
  });

  test("records single-select answer with preview and completes from summary", () => {
    const state = createQuestionnaireState(params({ questions: [params().questions[0]] }));

    expect(updateQuestionnaireState(state, { type: "confirm" })).toEqual({ changed: true });
    expect(questionnaireSnapshot(state)).toMatchObject({ mode: "summary", selectedIndex: 0 });
    expect(questionnaireSnapshot(state).answers).toEqual([
      {
        questionIndex: 0,
        question: "Which database should we use?",
        kind: "option",
        answer: "SQLite",
        preview: "file.db",
      },
    ]);

    expect(updateQuestionnaireState(state, { type: "confirm" })).toEqual({
      changed: false,
      terminal: {
        status: "completed",
        answers: [
          {
            questionIndex: 0,
            question: "Which database should we use?",
            kind: "option",
            answer: "SQLite",
            preview: "file.db",
          },
        ],
      },
    });
  });

  test("handles custom answer escape, unicode-safe backspace, and empty answer", () => {
    const state = createQuestionnaireState(params({ questions: [params().questions[0]] }));

    updateQuestionnaireState(state, { type: "move", delta: 1 });
    updateQuestionnaireState(state, { type: "move", delta: 1 });
    expect(questionnaireActionLabel(questionnaireSnapshot(state), 2)).toBe("Type something.");
    updateQuestionnaireState(state, { type: "confirm" });
    expect(questionnaireSnapshot(state)).toMatchObject({ mode: "custom", inputDraft: "" });
    expect(updateQuestionnaireState(state, { type: "backspace" })).toEqual({ changed: false });

    updateQuestionnaireState(state, { type: "appendInput", text: "Use 🍱" });
    expect(updateQuestionnaireState(state, { type: "backspace" })).toEqual({ changed: true });
    expect(questionnaireSnapshot(state).inputDraft).toBe("Use ");
    updateQuestionnaireState(state, { type: "cancel" });
    expect(questionnaireSnapshot(state)).toMatchObject({ mode: "select", inputDraft: "" });

    updateQuestionnaireState(state, { type: "confirm" });
    updateQuestionnaireState(state, { type: "confirm" });
    expect(questionnaireSnapshot(state).answers).toEqual([
      {
        questionIndex: 0,
        question: "Which database should we use?",
        kind: "custom",
        answer: null,
      },
    ]);
  });

  test("pauses chat flow with and without message", () => {
    const state = createQuestionnaireState(params({ questions: [params().questions[0]] }));

    updateQuestionnaireState(state, { type: "move", delta: 1 });
    updateQuestionnaireState(state, { type: "move", delta: 1 });
    updateQuestionnaireState(state, { type: "move", delta: 1 });
    expect(questionnaireActionLabel(questionnaireSnapshot(state), 3)).toBe("Chat about this");
    updateQuestionnaireState(state, { type: "confirm" });
    expect(updateQuestionnaireState(state, { type: "confirm" })).toEqual({
      changed: false,
      terminal: { status: "paused", answers: [], activeQuestionIndex: 0 },
    });

    const withMessage = createQuestionnaireState(params({ questions: [params().questions[0]] }));
    updateQuestionnaireState(withMessage, { type: "move", delta: 1 });
    updateQuestionnaireState(withMessage, { type: "move", delta: 1 });
    updateQuestionnaireState(withMessage, { type: "move", delta: 1 });
    updateQuestionnaireState(withMessage, { type: "confirm" });
    updateQuestionnaireState(withMessage, { type: "appendInput", text: "Need trade-offs" });
    expect(updateQuestionnaireState(withMessage, { type: "confirm" })).toEqual({
      changed: false,
      terminal: {
        status: "paused",
        answers: [],
        activeQuestionIndex: 0,
        chatMessage: "Need trade-offs",
      },
    });
  });

  test("multi-select submit requires selection and preserves option order", () => {
    const state = createQuestionnaireState(params());
    updateQuestionnaireState(state, { type: "confirm" });

    updateQuestionnaireState(state, { type: "move", delta: 1 });
    updateQuestionnaireState(state, { type: "move", delta: 1 });
    expect(updateQuestionnaireState(state, { type: "confirm" })).toEqual({ changed: true });
    expect(questionnaireSnapshot(state)).toMatchObject({
      mode: "select",
      notice: "Select at least one option before continuing.",
    });

    updateQuestionnaireState(state, { type: "move", delta: -1 });
    updateQuestionnaireState(state, { type: "toggle" });
    updateQuestionnaireState(state, { type: "move", delta: -1 });
    updateQuestionnaireState(state, { type: "toggle" });
    updateQuestionnaireState(state, { type: "move", delta: 1 });
    updateQuestionnaireState(state, { type: "move", delta: 1 });
    updateQuestionnaireState(state, { type: "confirm" });

    expect(questionnaireSnapshot(state).answers.at(-1)).toEqual({
      questionIndex: 1,
      question: "Which surfaces need tests?",
      kind: "multi",
      answer: null,
      selected: ["API", "UI"],
    });
  });

  test("summary cancellation returns partial answers", () => {
    const state = createQuestionnaireState(params({ questions: [params().questions[0]] }));

    updateQuestionnaireState(state, { type: "confirm" });
    expect(updateQuestionnaireState(state, { type: "cancel" })).toEqual({
      changed: false,
      terminal: {
        status: "cancelled",
        answers: [
          {
            questionIndex: 0,
            question: "Which database should we use?",
            kind: "option",
            answer: "SQLite",
            preview: "file.db",
          },
        ],
      },
    });
  });
});
