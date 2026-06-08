export const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_VALUES);

export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];

export type ModelSpec = {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
};

export function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return THINKING_LEVELS.has(normalized) ? (normalized as ThinkingLevel) : undefined;
}

export function parseModelSpec(value: unknown): ModelSpec | undefined {
  if (typeof value !== "string") return undefined;

  const entry = value.trim();
  const slashIndex = entry.indexOf("/");
  if (slashIndex <= 0 || slashIndex === entry.length - 1) return undefined;

  const provider = entry.slice(0, slashIndex).trim();
  let model = entry.slice(slashIndex + 1).trim();
  if (!provider || !model) return undefined;

  const colonIndex = model.lastIndexOf(":");
  const thinkingLevel = parseThinkingLevel(
    colonIndex === -1 ? undefined : model.slice(colonIndex + 1),
  );
  if (thinkingLevel) {
    model = model.slice(0, colonIndex).trim();
    if (!model) return undefined;
  }

  return { provider, model, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function formatModelSpec(spec: Pick<ModelSpec, "provider" | "model">): string {
  return `${spec.provider}/${spec.model}`;
}

export function formatModelSpecWithThinking(spec: ModelSpec): string {
  return `${formatModelSpec(spec)}${spec.thinkingLevel ? `:${spec.thinkingLevel}` : ""}`;
}
