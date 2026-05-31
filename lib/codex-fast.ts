export const CODEX_FAST_STATUS_KEY = "codex-fast";
export const CODEX_FAST_STATUS_ON = "codex-fast: on";
export const CODEX_FAST_ICON = "\u{F140B}";

type CodexModelLike = {
  api?: unknown;
  provider?: unknown;
};

export function isOpenAICodexModel(model: unknown): boolean {
  if (!model || typeof model !== "object" || Array.isArray(model)) return false;
  const candidate = model as CodexModelLike;
  return candidate.provider === "openai-codex" || candidate.api === "openai-codex-responses";
}
