import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CommandCodeModelConfig = Model<"openai-completions" | "anthropic-messages">;

export const COMMANDCODE_PROVIDER_ID = "commandcode";
export const COMMANDCODE_DISPLAY_NAME = "Command Code";
export const COMMANDCODE_MODELS_URL = "https://api.commandcode.ai/provider/v1/models";
export const COMMANDCODE_OPENAI_BASE_URL = "https://api.commandcode.ai/provider/v1";
export const COMMANDCODE_ANTHROPIC_BASE_URL = "https://api.commandcode.ai/provider";
export const COMMANDCODE_OPENAI_API = "openai-completions";
export const COMMANDCODE_ANTHROPIC_API = "anthropic-messages";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
export const COMMANDCODE_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

export type CommandCodeModelListResponse = {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    context_length?: unknown;
  }>;
};

export const COMMANDCODE_FALLBACK_MODELS = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    context_length: 1_000_000,
    max_tokens: 64_000,
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    context_length: 1_000_000,
    max_tokens: 128_000,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    context_length: 1_000_000,
    max_tokens: 128_000,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    context_length: 200_000,
    max_tokens: 64_000,
  },
  { id: "gpt-5.5", name: "GPT-5.5", context_length: 200_000, max_tokens: 128_000 },
  { id: "gpt-5.4", name: "GPT-5.4", context_length: 400_000, max_tokens: 128_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", context_length: 400_000, max_tokens: 128_000 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", context_length: 400_000, max_tokens: 128_000 },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", context_length: 256_000, max_tokens: 262_144 },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", context_length: 256_000, max_tokens: 262_144 },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    context_length: 1_000_000,
    max_tokens: 384_000,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    context_length: 1_000_000,
    max_tokens: 131_072,
  },
] satisfies Array<{ id: string; name: string; context_length: number; max_tokens: number }>;

const COMMANDCODE_MODEL_MAX_TOKENS = Object.fromEntries(
  COMMANDCODE_FALLBACK_MODELS.map((model) => [model.id, model.max_tokens]),
) as Record<string, number>;

function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("claude-");
}

function needsForceAdaptiveThinking(modelId: string): boolean {
  return modelId.startsWith("claude-opus-4-") || modelId === "claude-sonnet-4-6";
}

export const COMMANDCODE_THINKING_LEVEL_MAP = {
  xhigh: "xhigh",
  max: "max",
} satisfies CommandCodeModelConfig["thinkingLevelMap"];

const COMMANDCODE_XHIGH_THINKING_LEVEL_MAP = {
  xhigh: "xhigh",
} satisfies CommandCodeModelConfig["thinkingLevelMap"];

function supportsMaxThinking(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return (
    needsForceAdaptiveThinking(modelId) ||
    normalized.startsWith("deepseek/deepseek-v4") ||
    normalized.includes("kimi-k3")
  );
}

function toPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

export function createCommandCodeModelConfig(model: {
  id: string;
  name?: string;
  context_length?: number;
  max_tokens?: number;
}): CommandCodeModelConfig {
  const anthropic = isAnthropicModel(model.id);
  const contextWindow = toPositiveInteger(model.context_length, DEFAULT_CONTEXT_WINDOW);
  const maxOutputTokens =
    model.max_tokens ?? COMMANDCODE_MODEL_MAX_TOKENS[model.id] ?? DEFAULT_MAX_TOKENS;

  return {
    id: model.id,
    provider: COMMANDCODE_PROVIDER_ID,
    name: model.name ?? model.id,
    api: anthropic ? COMMANDCODE_ANTHROPIC_API : COMMANDCODE_OPENAI_API,
    baseUrl: anthropic ? COMMANDCODE_ANTHROPIC_BASE_URL : COMMANDCODE_OPENAI_BASE_URL,
    reasoning: true,
    thinkingLevelMap: supportsMaxThinking(model.id)
      ? COMMANDCODE_THINKING_LEVEL_MAP
      : COMMANDCODE_XHIGH_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(contextWindow, maxOutputTokens),
    compat: anthropic
      ? needsForceAdaptiveThinking(model.id)
        ? { forceAdaptiveThinking: true }
        : undefined
      : {
          maxTokensField: "max_tokens",
          supportsStore: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: true,
        },
  };
}

export function parseCommandCodeModels(
  payload: CommandCodeModelListResponse,
): CommandCodeModelConfig[] {
  return (payload.data ?? [])
    .filter(
      (model): model is { id: string; name?: string; context_length?: number } =>
        typeof model.id === "string" && model.id.trim().length > 0,
    )
    .map((model) =>
      createCommandCodeModelConfig({
        id: model.id,
        name: typeof model.name === "string" ? model.name : undefined,
        context_length: typeof model.context_length === "number" ? model.context_length : undefined,
      }),
    );
}

export async function fetchCommandCodeModels(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CommandCodeModelConfig[]> {
  const response = await fetchImpl(COMMANDCODE_MODELS_URL, { signal });
  if (!response.ok) throw new Error(`Command Code models request failed: ${response.status}`);

  const models = parseCommandCodeModels((await response.json()) as CommandCodeModelListResponse);
  if (models.length === 0) throw new Error("Command Code models response did not include models");
  return models;
}

export default function (pi: ExtensionAPI) {
  let catalog = COMMANDCODE_FALLBACK_MODELS.map(createCommandCodeModelConfig);
  const provider = createProvider({
    id: COMMANDCODE_PROVIDER_ID,
    name: COMMANDCODE_DISPLAY_NAME,
    baseUrl: COMMANDCODE_OPENAI_BASE_URL,
    auth: { apiKey: envApiKeyAuth("Command Code API key", ["COMMANDCODE_API_KEY"]) },
    models: [],
    api: {
      [COMMANDCODE_OPENAI_API]: openAICompletionsApi(),
      [COMMANDCODE_ANTHROPIC_API]: anthropicMessagesApi(),
    },
  });

  pi.registerProvider({
    ...provider,
    getModels: () => catalog,
    getAllModels: () => catalog,
    async refreshModels(context) {
      if (!context.allowNetwork) return;
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(COMMANDCODE_MODEL_DISCOVERY_TIMEOUT_MS),
      ]);
      signal.throwIfAborted();
      const discovered = await fetchCommandCodeModels(fetch, signal);
      await context.publish({
        update: () => {
          catalog = discovered;
        },
      });
    },
  });
}
