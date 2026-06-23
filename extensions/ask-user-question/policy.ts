export const ASK_USER_QUESTION_POLICY_EVENT = "ask-user-question:set-policy";

export type AskUserQuestionPolicy = {
  allowChatAboutThis?: boolean;
};

export function isAskUserQuestionPolicy(value: unknown): value is AskUserQuestionPolicy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Partial<AskUserQuestionPolicy>;
  return policy.allowChatAboutThis === undefined || typeof policy.allowChatAboutThis === "boolean";
}
