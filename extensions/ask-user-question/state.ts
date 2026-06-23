import {
  type AskUserQuestionParams,
  CHAT_ABOUT_THIS_LABEL,
  NEXT_QUESTION_LABEL,
  type QuestionAnswer,
  TYPE_SOMETHING_LABEL,
} from "./types";

export type AskUiResult =
  | { status: "completed"; answers: QuestionAnswer[] }
  | {
      status: "paused";
      answers: QuestionAnswer[];
      activeQuestionIndex: number;
      chatMessage?: string;
    }
  | { status: "cancelled"; answers: QuestionAnswer[] };

export type QuestionnaireMode = "select" | "custom" | "chat" | "summary";

export type QuestionnaireAction =
  | { type: "move"; delta: -1 | 1 }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "toggle" }
  | { type: "appendInput"; text: string }
  | { type: "backspace" };

export type QuestionnaireOptions = {
  allowChatAboutThis?: boolean;
};

export type QuestionnaireState = {
  readonly params: AskUserQuestionParams;
  readonly allowChatAboutThis: boolean;
  questionIndex: number;
  selectedIndex: number;
  mode: QuestionnaireMode;
  inputDraft: string;
  notice?: string;
  answers: QuestionAnswer[];
  multiSelections: Map<number, Set<number>>;
};

export type QuestionnaireSnapshot = {
  params: AskUserQuestionParams;
  questionIndex: number;
  questionCount: number;
  selectedIndex: number;
  mode: QuestionnaireMode;
  inputDraft: string;
  allowChatAboutThis: boolean;
  notice?: string;
  answers: QuestionAnswer[];
  currentQuestion: AskUserQuestionParams["questions"][number] | undefined;
  selectedMultiIndexes: Set<number>;
};

export type QuestionnaireUpdateResult = {
  changed: boolean;
  terminal?: AskUiResult;
};

export function createQuestionnaireState(
  params: AskUserQuestionParams,
  options: QuestionnaireOptions = {},
): QuestionnaireState {
  return {
    params,
    allowChatAboutThis: options.allowChatAboutThis !== false,
    questionIndex: 0,
    selectedIndex: 0,
    mode: "select",
    inputDraft: "",
    answers: [],
    multiSelections: new Map(),
  };
}

export function questionnaireSnapshot(state: QuestionnaireState): QuestionnaireSnapshot {
  const selectedMultiIndexes = state.multiSelections.get(state.questionIndex) ?? new Set<number>();
  return {
    params: state.params,
    questionIndex: state.questionIndex,
    questionCount: state.params.questions.length,
    selectedIndex: state.selectedIndex,
    mode: state.mode,
    inputDraft: state.inputDraft,
    allowChatAboutThis: state.allowChatAboutThis,
    notice: state.notice,
    answers: [...state.answers],
    currentQuestion: currentQuestion(state),
    selectedMultiIndexes: new Set(selectedMultiIndexes),
  };
}

export function questionnaireItemCount(state: QuestionnaireState): number {
  const question = currentQuestion(state);
  return question ? question.options.length + 1 + (state.allowChatAboutThis ? 1 : 0) : 0;
}

export function questionnaireActionLabel(
  snapshot: QuestionnaireSnapshot,
  index: number,
): string | undefined {
  const question = snapshot.currentQuestion;
  if (!question) return undefined;
  if (index < question.options.length) return question.options[index]?.label;

  const actionIndex = question.options.length;
  if (index === actionIndex) {
    return question.multiSelect === true ? NEXT_QUESTION_LABEL : TYPE_SOMETHING_LABEL;
  }
  if (snapshot.allowChatAboutThis && index === actionIndex + 1) return CHAT_ABOUT_THIS_LABEL;
  return undefined;
}

export function updateQuestionnaireState(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  if (state.mode === "summary") return updateSummary(state, action);
  if (state.mode === "custom" || state.mode === "chat") return updateInputMode(state, action);
  return updateSelectMode(state, action);
}

function currentQuestion(state: QuestionnaireState) {
  return state.params.questions[state.questionIndex];
}

function getMultiSet(state: QuestionnaireState): Set<number> {
  let set = state.multiSelections.get(state.questionIndex);
  if (!set) {
    set = new Set<number>();
    state.multiSelections.set(state.questionIndex, set);
  }
  return set;
}

function advanceOrComplete(state: QuestionnaireState): void {
  if (state.questionIndex >= state.params.questions.length - 1) {
    state.mode = "summary";
    state.selectedIndex = 0;
    return;
  }
  state.questionIndex += 1;
  state.selectedIndex = 0;
  state.mode = "select";
}

function saveOption(state: QuestionnaireState, optionIndex: number): boolean {
  const question = currentQuestion(state);
  const option = question?.options[optionIndex];
  if (!question || !option) return false;
  state.notice = undefined;
  state.answers.push({
    questionIndex: state.questionIndex,
    question: question.question,
    kind: "option",
    answer: option.label,
    ...(option.preview ? { preview: option.preview } : {}),
  });
  advanceOrComplete(state);
  return true;
}

function saveMulti(state: QuestionnaireState): boolean {
  const question = currentQuestion(state);
  if (!question) return false;
  const selected = Array.from(getMultiSet(state))
    .sort((a, b) => a - b)
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => Boolean(label));
  if (selected.length === 0) {
    state.notice = "Select at least one option before continuing.";
    return true;
  }
  state.notice = undefined;
  state.answers.push({
    questionIndex: state.questionIndex,
    question: question.question,
    kind: "multi",
    answer: null,
    selected,
  });
  advanceOrComplete(state);
  return true;
}

function enterInputMode(state: QuestionnaireState, mode: "custom" | "chat"): void {
  state.mode = mode;
  state.inputDraft = "";
  state.notice = undefined;
}

function submitInput(state: QuestionnaireState): QuestionnaireUpdateResult {
  const question = currentQuestion(state);
  if (!question) return { changed: false };
  const trimmed = state.inputDraft.trim();
  if (state.mode === "custom") {
    state.notice = undefined;
    state.answers.push({
      questionIndex: state.questionIndex,
      question: question.question,
      kind: "custom",
      answer: trimmed || null,
    });
    advanceOrComplete(state);
    return { changed: true };
  }

  return {
    changed: false,
    terminal: {
      status: "paused",
      answers: [...state.answers],
      activeQuestionIndex: state.questionIndex,
      ...(trimmed ? { chatMessage: trimmed } : {}),
    },
  };
}

function toggleSelectedMultiOption(state: QuestionnaireState): boolean {
  const question = currentQuestion(state);
  if (question?.multiSelect !== true || state.selectedIndex >= question.options.length) {
    return false;
  }
  const set = getMultiSet(state);
  state.notice = undefined;
  if (set.has(state.selectedIndex)) set.delete(state.selectedIndex);
  else set.add(state.selectedIndex);
  return true;
}

function handleSelectConfirm(state: QuestionnaireState): boolean {
  const question = currentQuestion(state);
  if (!question) return false;
  const isMulti = question.multiSelect === true;
  if (isMulti) {
    const submitIndex = question.options.length;
    const chatIndex = question.options.length + 1;
    if (state.selectedIndex < question.options.length) return toggleSelectedMultiOption(state);
    if (state.selectedIndex === submitIndex) return saveMulti(state);
    if (state.allowChatAboutThis && state.selectedIndex === chatIndex) {
      enterInputMode(state, "chat");
      return true;
    }
    return false;
  }

  const customIndex = question.options.length;
  const chatIndex = question.options.length + 1;
  if (state.selectedIndex < question.options.length) return saveOption(state, state.selectedIndex);
  if (state.selectedIndex === customIndex) {
    enterInputMode(state, "custom");
    return true;
  }
  if (state.allowChatAboutThis && state.selectedIndex === chatIndex) {
    enterInputMode(state, "chat");
    return true;
  }
  return false;
}

function updateSummary(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  if (action.type === "confirm") {
    return { changed: false, terminal: { status: "completed", answers: [...state.answers] } };
  }
  if (action.type === "cancel") {
    return { changed: false, terminal: { status: "cancelled", answers: [...state.answers] } };
  }
  return { changed: false };
}

function updateInputMode(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  switch (action.type) {
    case "confirm":
      return submitInput(state);
    case "cancel":
      state.mode = "select";
      state.inputDraft = "";
      return { changed: true };
    case "backspace":
      if (state.inputDraft.length === 0) return { changed: false };
      state.inputDraft = [...state.inputDraft].slice(0, -1).join("");
      return { changed: true };
    case "appendInput":
      state.inputDraft += action.text;
      return { changed: true };
    default:
      return { changed: false };
  }
}

function updateSelectMode(
  state: QuestionnaireState,
  action: QuestionnaireAction,
): QuestionnaireUpdateResult {
  switch (action.type) {
    case "cancel":
      return { changed: false, terminal: { status: "cancelled", answers: [...state.answers] } };
    case "move": {
      const next = Math.min(
        questionnaireItemCount(state) - 1,
        Math.max(0, state.selectedIndex + action.delta),
      );
      if (next === state.selectedIndex) return { changed: false };
      state.selectedIndex = next;
      return { changed: true };
    }
    case "toggle":
      return { changed: toggleSelectedMultiOption(state) };
    case "confirm":
      return { changed: handleSelectConfirm(state) };
    default:
      return { changed: false };
  }
}
