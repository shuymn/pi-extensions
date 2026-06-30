import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type OpenAIResponsesCompat,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const SAKANA_AI_PROVIDER_ID = "sakana-ai";
export const SAKANA_AI_DISPLAY_NAME = "Sakana AI";
export const SAKANA_AI_BASE_URL = "https://api.sakana.ai/v1";
export const SAKANA_AI_API_KEY_CONFIG_FALLBACK = "$SAKANA_API_KEY";
export const SAKANA_AI_UPSTREAM_API = "openai-responses";
export const SAKANA_AI_RESPONSES_API = "sakana-ai-openai-responses";

// Fallback stream/retry defaults applied only when the caller omits these options.
// Sakana's Codex setup recommends a 2-hour stream idle timeout and 4 request retries.
// Note: under the normal pi runtime the SDK always supplies `timeoutMs` (from the
// `httpIdleTimeoutMs` setting), so SAKANA_AI_DEFAULT_TIMEOUT_MS only takes effect for
// direct/wrapper callers; set `httpIdleTimeoutMs` to actually raise the idle timeout.
export const SAKANA_AI_DEFAULT_TIMEOUT_MS = 7_200_000;
export const SAKANA_AI_DEFAULT_MAX_RETRIES = 4;

export const SAKANA_AI_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "xhigh",
} satisfies ProviderModelConfig["thinkingLevelMap"];

export const SAKANA_AI_OPENAI_RESPONSES_COMPAT = {
  supportsDeveloperRole: true,
  sendSessionIdHeader: false,
  supportsLongCacheRetention: false,
} satisfies OpenAIResponsesCompat;

const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FUGU_ULTRA_STANDARD_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 };
const FUGU_CONTEXT_WINDOW = 272_000;
const FUGU_MAX_TOKENS = 128_000;

export const SAKANA_AI_MODELS = [
  {
    id: "fugu",
    name: "Fugu",
    reasoning: true,
    thinkingLevelMap: SAKANA_AI_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: UNKNOWN_COST,
    contextWindow: FUGU_CONTEXT_WINDOW,
    maxTokens: FUGU_MAX_TOKENS,
    compat: SAKANA_AI_OPENAI_RESPONSES_COMPAT,
  },
  {
    id: "fugu-ultra",
    name: "Fugu Ultra",
    reasoning: true,
    thinkingLevelMap: SAKANA_AI_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    cost: FUGU_ULTRA_STANDARD_COST,
    contextWindow: FUGU_CONTEXT_WINDOW,
    maxTokens: FUGU_MAX_TOKENS,
    compat: SAKANA_AI_OPENAI_RESPONSES_COMPAT,
  },
] satisfies ProviderModelConfig[];

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type UnknownRecord = Record<string, unknown>;

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTool(tool: unknown): unknown {
  if (!isRecord(tool)) return tool;

  const next = { ...tool };
  delete next.strict;

  const functionDefinition = next.function;
  if (isRecord(functionDefinition)) {
    const nextFunctionDefinition = { ...functionDefinition };
    delete nextFunctionDefinition.strict;
    next.function = nextFunctionDefinition;
  }

  return next;
}

export function sanitizeSakanaResponsesPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;

  const next = { ...payload };
  delete next.prompt_cache_key;
  delete next.prompt_cache_retention;
  delete next.store;
  delete next.service_tier;
  delete next.include;

  if (isRecord(next.reasoning) && typeof next.reasoning.effort === "string") {
    next.reasoning = { effort: next.reasoning.effort };
  }

  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map(sanitizeTool);
  }

  return next;
}

function createErrorMessage(
  model: Model<Api>,
  error: unknown,
  signal?: AbortSignal,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: structuredClone(EMPTY_USAGE),
    stopReason: signal?.aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function createSakanaAiStreamSimple({
  upstreamStreamSimple,
}: {
  upstreamStreamSimple?: StreamSimple;
} = {}): StreamSimple {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();

    (async () => {
      try {
        const streamSimple =
          upstreamStreamSimple ?? getApiProvider(SAKANA_AI_UPSTREAM_API)?.streamSimple;
        if (!streamSimple) {
          throw new Error(`No API provider registered for api: ${SAKANA_AI_UPSTREAM_API}`);
        }

        const upstreamOptions: SimpleStreamOptions = {
          ...options,
          timeoutMs: options?.timeoutMs ?? SAKANA_AI_DEFAULT_TIMEOUT_MS,
          maxRetries: options?.maxRetries ?? SAKANA_AI_DEFAULT_MAX_RETRIES,
          async onPayload(payload, upstreamModel) {
            const sanitized = sanitizeSakanaResponsesPayload(payload);
            const replacement = await options?.onPayload?.(sanitized, upstreamModel);
            return replacement === undefined ? sanitized : replacement;
          },
        };

        const upstreamStream = streamSimple(
          { ...model, api: SAKANA_AI_UPSTREAM_API },
          context,
          upstreamOptions,
        );
        for await (const event of upstreamStream) {
          output.push(event);
        }
      } catch (error) {
        output.push({
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: createErrorMessage(model, error, options?.signal),
        });
      } finally {
        output.end();
      }
    })();

    return output;
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(SAKANA_AI_PROVIDER_ID, {
    name: SAKANA_AI_DISPLAY_NAME,
    baseUrl: SAKANA_AI_BASE_URL,
    apiKey: SAKANA_AI_API_KEY_CONFIG_FALLBACK,
    api: SAKANA_AI_RESPONSES_API,
    streamSimple: createSakanaAiStreamSimple(),
    models: SAKANA_AI_MODELS,
  });
}
