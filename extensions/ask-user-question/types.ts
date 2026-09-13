import { type Static, Type } from "typebox";

export const FREE_INPUT_LABEL = "自由入力";

const nonEmptyString = (description: string, maxLength?: number) =>
  Type.String({ description, pattern: "\\S", ...(maxLength === undefined ? {} : { maxLength }) });

export const AskUserQuestionParamsSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          question: nonEmptyString("The complete, specific question to ask the user."),
          header: nonEmptyString("Short heading for this question.", 16),
          options: Type.Array(
            Type.Object(
              {
                label: nonEmptyString("Concise display label for this option.", 60),
                description: nonEmptyString("Explanation of this option and its trade-offs."),
              },
              { additionalProperties: false },
            ),
            {
              minItems: 2,
              maxItems: 4,
              description: "Single-choice options. Free input is added at runtime.",
            },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 4, description: "Questions to ask in order." },
    ),
  },
  { additionalProperties: false },
);

export type AskUserQuestionParams = Static<typeof AskUserQuestionParamsSchema>;
export type QuestionData = AskUserQuestionParams["questions"][number];
export type QuestionAnswer = {
  questionIndex: number;
  question: string;
  kind: "option" | "custom";
  answer: string;
};
export type QuestionnaireStatus = "completed" | "cancelled" | "interrupted" | "unavailable";
export interface QuestionnaireResult {
  status: QuestionnaireStatus;
  answers: QuestionAnswer[];
  questionCount: number;
  unansweredQuestionIndexes: number[];
}
