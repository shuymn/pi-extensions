import { Check } from "typebox/value";
import { type AskUserQuestionParams, AskUserQuestionParamsSchema } from "./types";

export function validateAskUserQuestionParams(
  params: unknown,
): asserts params is AskUserQuestionParams {
  if (!Check(AskUserQuestionParamsSchema, params)) {
    throw new Error(
      "Invalid ask_user_question parameters: use 1–4 questions with question, header, and 2–4 label/description options only.",
    );
  }

  const normalize = (value: string) => value.trim().toLowerCase();
  const questions = new Set<string>();
  for (const question of params.questions) {
    const key = normalize(question.question);
    if (questions.has(key)) throw new Error(`Duplicate question: ${question.question}`);
    questions.add(key);
    const labels = new Set<string>();
    for (const option of question.options) {
      const label = normalize(option.label);
      if (labels.has(label)) throw new Error(`Duplicate option label: ${option.label}`);
      labels.add(label);
    }
  }
}
