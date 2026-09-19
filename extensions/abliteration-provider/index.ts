import { createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Catalog/limits: https://docs.abliteration.ai/models
// Rates: https://docs.abliteration.ai/pricing (the Pi integration example has older rates).
const models: Omit<Model<"openai-completions">, "api" | "provider" | "baseUrl">[] = [
  {
    id: "abliterated-model-large-v2",
    name: "Abliterated Model Large V2",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 999_990,
    cost: { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3 },
  },
  {
    id: "abliterated-model",
    name: "Abliterated Model",
    reasoning: true,
    thinkingLevelMap: { off: "none", xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 262_134,
    cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
  },
  {
    id: "abliterated-model-large",
    name: "Abliterated Model Large",
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    },
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 999_990,
    cost: { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3 },
  },
];

export default function (pi: ExtensionAPI) {
  pi.registerProvider(
    createProvider({
      id: "abliteration",
      name: "abliteration.ai",
      baseUrl: "https://api.abliteration.ai/v1",
      auth: {
        apiKey: {
          name: "API キー",
          async login(interaction) {
            const key = (
              await interaction.prompt({
                type: "secret",
                message: "abliteration.ai の API キーを入力してください",
              })
            ).trim();
            if (!key) throw new Error("API キーが入力されていません");
            return { type: "api_key", key };
          },
          async resolve({ credential }) {
            return credential?.key
              ? { auth: { apiKey: credential.key }, source: "stored API key" }
              : undefined;
          },
        },
      },
      api: openAICompletionsApi(),
      models: models.map((model) => ({
        ...model,
        api: "openai-completions",
        provider: "abliteration",
        baseUrl: "https://api.abliteration.ai/v1",
        compat: {
          maxTokensField: "max_tokens",
          supportsStore: false,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: true,
          // Use Pi's per-session value, never a static shared affinity header.
          sendSessionAffinityHeaders: true,
        },
      })),
    }),
  );
}
