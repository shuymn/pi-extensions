export const OPENAI_FAST_STATUS_KEY = "openai-fast";
export const OPENAI_FAST_STATUS_ON = "openai-fast: on";
export const OPENAI_FAST_ICON = "\u{F140B}";

type OpenAIModelLike = {
  api?: unknown;
  provider?: unknown;
};

export function isOpenAIResponsesModel(model: unknown): boolean {
  if (!model || typeof model !== "object" || Array.isArray(model)) return false;
  const candidate = model as OpenAIModelLike;
  return candidate.provider === "openai" && candidate.api === "openai-responses";
}
