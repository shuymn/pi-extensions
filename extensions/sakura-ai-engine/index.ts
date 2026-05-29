import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  getApiProvider,
  type Model,
  type OpenAICompletionsCompat,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const SAKURA_AI_ENGINE_PROVIDER_ID = "sakura-ai-engine";
export const SAKURA_AI_ENGINE_AUTH_PROVIDER_ID = SAKURA_AI_ENGINE_PROVIDER_ID;
export const SAKURA_AI_ENGINE_DISPLAY_NAME = "Sakura AI Engine";
export const SAKURA_AI_ENGINE_BASE_URL = "https://api.ai.sakura.ad.jp/v1";
export const SAKURA_AI_ENGINE_API_KEY_CONFIG_FALLBACK = "SAKURA_AI_ENGINE_API_KEY";
export const SAKURA_AI_ENGINE_UPSTREAM_API = "openai-completions";
export const SAKURA_AI_ENGINE_RATE_LIMITED_API = "sakura-ai-engine-openai-completions";
export const SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS = 3_000;
export const SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS = 1;
export const SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV = "SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS";
export const SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV =
  "SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS";

export const SAKURA_AI_ENGINE_JPY_PER_USD = 160;

const SAKURA_AI_ENGINE_COST_JPY_PER_1M_INPUT = 60;
const SAKURA_AI_ENGINE_COST_JPY_PER_1M_OUTPUT = 300;

/**
 * Compute USD cost per 1M tokens from JPY, rounded up to 2 decimal places.
 * Exchange rate is set via SAKURA_AI_ENGINE_JPY_PER_USD.
 */
export function sakuraAiEngineCost(): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} {
  const roundUp = (value: number) => Math.ceil(value * 100) / 100;
  const rate = SAKURA_AI_ENGINE_JPY_PER_USD;
  return {
    input: roundUp(SAKURA_AI_ENGINE_COST_JPY_PER_1M_INPUT / rate),
    output: roundUp(SAKURA_AI_ENGINE_COST_JPY_PER_1M_OUTPUT / rate),
    cacheRead: 0,
    cacheWrite: 0,
  };
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const SAKURA_AI_ENGINE_OPENAI_COMPAT = {
  maxTokensField: "max_tokens",
  supportsStore: false,
  supportsStrictMode: false,
  supportsUsageInStreaming: false,
  supportsReasoningEffort: false,
} satisfies OpenAICompletionsCompat;

export const SAKURA_AI_ENGINE_MODELS = [
  {
    id: "preview/Kimi-K2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text", "image"],
    cost: sakuraAiEngineCost(),
    contextWindow: 262_144,
    maxTokens: 256_000,
    compat: SAKURA_AI_ENGINE_OPENAI_COMPAT,
  },
] satisfies ProviderModelConfig[];

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
type Now = () => number;
type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const defaultSleep: Sleep = (ms, signal) => {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
};

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") return fallback;

  const value = Number.parseInt(rawValue, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRateLimitConfig() {
  return {
    windowMs: readPositiveIntegerEnv(
      SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV,
      SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS,
    ),
    maxConcurrentRequests: readPositiveIntegerEnv(
      SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV,
      SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS,
    ),
  };
}

export class SakuraAiEngineRateLimiter {
  private activeRequests = 0;
  private windowStartedAt = 0;
  private windowRequestCount = 0;
  private queue: Array<() => void> = [];
  private scheduleTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly now: Now,
    private readonly sleep: Sleep,
  ) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      await this.waitForWindowSlot(signal);
      return await task();
    } finally {
      this.activeRequests -= 1;
      this.drainQueue();
    }
  }

  private async waitForWindowSlot(signal?: AbortSignal): Promise<void> {
    const scheduled = this.scheduleTail
      .catch(() => {})
      .then(async () => {
        while (true) {
          if (signal?.aborted) throw signal.reason ?? new Error("Aborted");

          const { maxConcurrentRequests, windowMs } = readRateLimitConfig();
          const currentTime = this.now();
          const windowElapsed = currentTime - this.windowStartedAt;
          if (this.windowStartedAt === 0 || windowElapsed >= windowMs) {
            this.windowStartedAt = currentTime;
            this.windowRequestCount = 0;
          }

          if (this.windowRequestCount < maxConcurrentRequests) {
            this.windowRequestCount += 1;
            return;
          }

          const waitMs = Math.max(0, this.windowStartedAt + windowMs - currentTime);
          await this.sleep(waitMs, signal);
        }
      });

    this.scheduleTail = scheduled.catch(() => {});
    await scheduled;
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }

      const queued = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.queue = this.queue.filter((entry) => entry !== queued);
        reject(signal?.reason ?? new Error("Aborted"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(queued);
      this.drainQueue();
    });
  }

  private drainQueue() {
    const { maxConcurrentRequests } = readRateLimitConfig();
    while (this.activeRequests < maxConcurrentRequests) {
      const next = this.queue.shift();
      if (!next) return;
      this.activeRequests += 1;
      next();
    }
  }
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

export function createSakuraAiEngineRateLimitedStreamSimple({
  limiter = new SakuraAiEngineRateLimiter(Date.now, defaultSleep),
  upstreamStreamSimple,
}: {
  limiter?: SakuraAiEngineRateLimiter;
  upstreamStreamSimple?: StreamSimple;
} = {}): StreamSimple {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();

    (async () => {
      try {
        await limiter.run(async () => {
          const streamSimple =
            upstreamStreamSimple ?? getApiProvider(SAKURA_AI_ENGINE_UPSTREAM_API)?.streamSimple;
          if (!streamSimple) {
            throw new Error(`No API provider registered for api: ${SAKURA_AI_ENGINE_UPSTREAM_API}`);
          }

          const upstreamStream = streamSimple(
            { ...model, api: SAKURA_AI_ENGINE_UPSTREAM_API },
            context,
            options,
          );
          for await (const event of upstreamStream) {
            output.push(event);
          }
          await upstreamStream.result();
        }, options?.signal);
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
  pi.registerProvider(SAKURA_AI_ENGINE_PROVIDER_ID, {
    name: SAKURA_AI_ENGINE_DISPLAY_NAME,
    baseUrl: SAKURA_AI_ENGINE_BASE_URL,
    apiKey: SAKURA_AI_ENGINE_API_KEY_CONFIG_FALLBACK,
    api: SAKURA_AI_ENGINE_RATE_LIMITED_API,
    streamSimple: createSakuraAiEngineRateLimitedStreamSimple(),
    models: SAKURA_AI_ENGINE_MODELS,
  });
}
