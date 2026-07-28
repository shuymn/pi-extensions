import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
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

// Fallback request settings applied only when the caller omits these options.
// Pi's global `httpIdleTimeoutMs` must be configured separately for a 2-hour stream idle timeout.
export const SAKANA_AI_DEFAULT_TIMEOUT_MS = 7_200_000;
export const SAKANA_AI_DEFAULT_MAX_RETRIES = 4;

export const SAKANA_AI_THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "xhigh",
  max: null,
} satisfies ProviderModelConfig["thinkingLevelMap"];

export const SAKANA_AI_MAX_THINKING_LEVEL_MAP = {
  ...SAKANA_AI_THINKING_LEVEL_MAP,
  max: "max",
} satisfies ProviderModelConfig["thinkingLevelMap"];

export const SAKANA_AI_OPENAI_RESPONSES_COMPAT = {
  supportsDeveloperRole: true,
  sessionAffinityFormat: "openai-nosession",
  supportsLongCacheRetention: false,
} satisfies OpenAIResponsesCompat;

// Pi's upstream Responses parser does not expose Sakana's billable orchestration tokens,
// so no listed model's cost can be calculated accurately yet.
const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Cap Pi's usable context to avoid Sakana's higher pricing and subscription usage above 272K.
const FUGU_CONTEXT_WINDOW = 272_000;
const FUGU_MAX_TOKENS = 128_000;
const FUGU_MODEL_DEFAULTS = {
  input: ["text", "image"],
  cost: UNKNOWN_COST,
  contextWindow: FUGU_CONTEXT_WINDOW,
  maxTokens: FUGU_MAX_TOKENS,
  compat: SAKANA_AI_OPENAI_RESPONSES_COMPAT,
} satisfies Pick<ProviderModelConfig, "input" | "cost" | "contextWindow" | "maxTokens" | "compat">;

export const SAKANA_AI_MODELS = [
  {
    id: "fugu",
    name: "Fugu",
    reasoning: true,
    thinkingLevelMap: SAKANA_AI_THINKING_LEVEL_MAP,
    ...FUGU_MODEL_DEFAULTS,
  },
  {
    id: "fugu-ultra",
    name: "Fugu Ultra",
    reasoning: true,
    thinkingLevelMap: SAKANA_AI_MAX_THINKING_LEVEL_MAP,
    ...FUGU_MODEL_DEFAULTS,
  },
  {
    id: "fugu-ultra-v1.1",
    name: "Fugu Ultra v1.1",
    reasoning: true,
    thinkingLevelMap: SAKANA_AI_MAX_THINKING_LEVEL_MAP,
    ...FUGU_MODEL_DEFAULTS,
  },
  {
    id: "fugu-ultra-v1.0",
    name: "Fugu Ultra v1.0",
    reasoning: true,
    thinkingLevelMap: SAKANA_AI_THINKING_LEVEL_MAP,
    ...FUGU_MODEL_DEFAULTS,
  },
  {
    id: "fugu-cyber",
    name: "Fugu Cyber",
    reasoning: true,
    thinkingLevelMap: SAKANA_AI_THINKING_LEVEL_MAP,
    ...FUGU_MODEL_DEFAULTS,
  },
] satisfies ProviderModelConfig[];

const REASONING_SUMMARY_MODEL_IDS = new Set([
  "fugu-ultra",
  "fugu-ultra-v1.1",
  "fugu-ultra-v1.0",
  "fugu-cyber",
]);

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
  if (tool.type === "web_search") return { type: "web_search" };

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

export function sanitizeSakanaResponsesPayload(payload: unknown, modelId?: string): unknown {
  if (!isRecord(payload)) return payload;

  const next = { ...payload };
  delete next.prompt_cache_key;
  delete next.prompt_cache_retention;
  delete next.store;
  delete next.service_tier;
  delete next.include;
  delete next.previous_response_id;

  if (isRecord(next.reasoning)) {
    const reasoning: UnknownRecord = {};
    if (typeof next.reasoning.effort === "string") {
      reasoning.effort = next.reasoning.effort;
    }
    if (
      modelId &&
      REASONING_SUMMARY_MODEL_IDS.has(modelId) &&
      typeof next.reasoning.summary === "string"
    ) {
      reasoning.summary = next.reasoning.summary;
    }
    if (Object.keys(reasoning).length > 0) {
      next.reasoning = reasoning;
    } else {
      delete next.reasoning;
    }
  }

  if (Array.isArray(next.tools)) {
    next.tools = next.tools.map(sanitizeTool);
  }

  return next;
}

function normalizeMessageApi(message: AssistantMessage, api: Api): AssistantMessage {
  return message.api === api ? message : { ...message, api };
}

function normalizeEventApi(event: AssistantMessageEvent, api: Api): AssistantMessageEvent {
  if ("partial" in event) {
    return { ...event, partial: normalizeMessageApi(event.partial, api) };
  }
  if (event.type === "done") {
    return { ...event, message: normalizeMessageApi(event.message, api) };
  }
  return { ...event, error: normalizeMessageApi(event.error, api) };
}

function createUpstreamContext(model: Model<Api>, context: Context): Context {
  return {
    ...context,
    messages: (context.messages ?? []).map((message) => {
      if (
        message.role === "assistant" &&
        message.api === model.api &&
        message.provider === model.provider &&
        message.model === model.id
      ) {
        return { ...message, api: SAKANA_AI_UPSTREAM_API };
      }
      return message;
    }),
  };
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
            const sanitized = sanitizeSakanaResponsesPayload(payload, upstreamModel.id);
            if (!options?.onPayload) return sanitized;

            const replacement = await options.onPayload(sanitized, model);
            return replacement === undefined
              ? sanitized
              : sanitizeSakanaResponsesPayload(replacement, upstreamModel.id);
          },
          async onResponse(response) {
            await options?.onResponse?.(response, model);
          },
        };

        const upstreamStream = streamSimple(
          { ...model, api: SAKANA_AI_UPSTREAM_API },
          createUpstreamContext(model, context),
          upstreamOptions,
        );
        let receivedTerminalEvent = false;
        for await (const event of upstreamStream) {
          if (event.type === "done" || event.type === "error") {
            receivedTerminalEvent = true;
          }
          output.push(normalizeEventApi(event, model.api));
        }
        if (!receivedTerminalEvent) {
          throw new Error("Upstream stream ended without a terminal event");
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
