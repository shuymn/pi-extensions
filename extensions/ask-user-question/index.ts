import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AskUserQuestionParamsSchema,
  FREE_INPUT_LABEL,
  type QuestionAnswer,
  type QuestionnaireResult,
  type QuestionnaireStatus,
} from "./types";
import { validateAskUserQuestionParams } from "./validation";

export default function askUserQuestion(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: `Ask the user up to 4 structured questions sequentially when implementation-relevant decisions are ambiguous. Each question accepts one listed option or a custom answer. Put a recommended option first and append "(Recommended)" to its label. Cancellation or interruption preserves only actual answers; unansweredQuestionIndexes are zero-based. Do not infer answers to unanswered questions.`,
    promptSnippet:
      "Ask the user up to 4 structured questions when implementation-relevant requirements or decisions are ambiguous",
    promptGuidelines: [
      "Use ask_user_question when ambiguity materially affects implementation, architecture, scope, data loss, or user-visible behavior.",
      "Group related questions in one call and resolve trivial choices without asking.",
    ],
    parameters: AskUserQuestionParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      validateAskUserQuestionParams(params);
      const answers: QuestionAnswer[] = [];
      const finish = (status: QuestionnaireStatus) => {
        const details: QuestionnaireResult = {
          status,
          answers,
          questionCount: params.questions.length,
          unansweredQuestionIndexes: params.questions
            .map((_, index) => index)
            .slice(answers.length),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      };

      if (signal?.aborted) return finish("interrupted");
      if (!ctx.hasUI) return finish("unavailable");
      try {
        for (const [questionIndex, question] of params.questions.entries()) {
          if (signal?.aborted) return finish("interrupted");
          const labels = question.options.map((option, index) => `${index + 1}. ${option.label}`);
          const freeInput = `${labels.length + 1}. ${FREE_INPUT_LABEL}`;
          const title = [
            `質問 ${questionIndex + 1}/${params.questions.length}: ${question.header}`,
            question.question,
            ...question.options.map((option, index) => `${labels[index]}\n${option.description}`),
          ].join("\n\n");
          const selected = await ctx.ui.select(title, [...labels, freeInput], { signal });
          if (signal?.aborted) return finish("interrupted");
          if (selected === undefined) return finish("cancelled");
          if (selected === freeInput) {
            const input = await ctx.ui.input(
              `${question.question}\n回答を入力してください（空欄でキャンセル）`,
              undefined,
              { signal },
            );
            if (signal?.aborted) return finish("interrupted");
            if (input === undefined || input.trim() === "") return finish("cancelled");
            answers.push({
              questionIndex,
              question: question.question,
              kind: "custom",
              answer: input,
            });
          } else {
            const optionIndex = labels.indexOf(selected);
            if (optionIndex < 0) throw new Error("Invalid ask_user_question UI selection.");
            answers.push({
              questionIndex,
              question: question.question,
              kind: "option",
              answer: question.options[optionIndex].label,
            });
          }
        }
      } catch (error) {
        if (signal?.aborted) return finish("interrupted");
        throw error;
      }
      return finish("completed");
    },
  });
}
