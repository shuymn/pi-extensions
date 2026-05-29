import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { withTimeout } from "../../tests/support/async";
import { createFakePi } from "../../tests/support/fake-pi";
import extension, {
  createSakuraAiEngineRateLimitedStreamSimple,
  SAKURA_AI_ENGINE_API_KEY_CONFIG_FALLBACK,
  SAKURA_AI_ENGINE_AUTH_PROVIDER_ID,
  SAKURA_AI_ENGINE_BASE_URL,
  SAKURA_AI_ENGINE_DISPLAY_NAME,
  SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV,
  SAKURA_AI_ENGINE_MODELS,
  SAKURA_AI_ENGINE_OPENAI_COMPAT,
  SAKURA_AI_ENGINE_PROVIDER_ID,
  SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV,
  SAKURA_AI_ENGINE_RATE_LIMITED_API,
  SAKURA_AI_ENGINE_UPSTREAM_API,
  SakuraAiEngineRateLimiter,
  sakuraAiEngineCost,
} from "./index";

function fakeModel(): Model<Api> {
  return {
    id: "preview/Kimi-K2.6",
    name: "Kimi K2.6",
    api: SAKURA_AI_ENGINE_RATE_LIMITED_API,
    provider: SAKURA_AI_ENGINE_PROVIDER_ID,
    baseUrl: SAKURA_AI_ENGINE_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: sakuraAiEngineCost(),
    contextWindow: 262_144,
    maxTokens: 256_000,
    compat: SAKURA_AI_ENGINE_OPENAI_COMPAT,
  } as Model<Api>;
}

function fakeAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function collectStreamTypes(
  stream: ReturnType<ReturnType<typeof createSakuraAiEngineRateLimitedStreamSimple>>,
) {
  const types: string[] = [];
  for await (const event of stream) {
    types.push(event.type);
  }
  return types;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function waitForCondition(condition: () => boolean, message: string): Promise<void> {
  await withTimeout(
    (async () => {
      while (!condition()) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })(),
    message,
    50,
  );
}

describe("sakura-ai-engine extension", () => {
  let prevAgentDir: string | undefined;
  let tempAgentDir: string;

  beforeEach(() => {
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    tempAgentDir = mkdtempSync(join(tmpdir(), "sakura-agent-test-"));
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  });

  afterEach(() => {
    rmSync(tempAgentDir, { recursive: true, force: true });
    if (prevAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    }
  });

  test("registers Sakura AI Engine as a rate-limited OpenAI-compatible API-key provider", () => {
    const pi = createFakePi();

    extension(pi as never);

    const provider = pi.providers.get(SAKURA_AI_ENGINE_PROVIDER_ID);
    expect(SAKURA_AI_ENGINE_AUTH_PROVIDER_ID).toBe(SAKURA_AI_ENGINE_PROVIDER_ID);
    expect(provider).toBeDefined();
    expect(provider?.name).toBe(SAKURA_AI_ENGINE_DISPLAY_NAME);
    expect(provider?.baseUrl).toBe(SAKURA_AI_ENGINE_BASE_URL);
    expect(provider?.api).toBe(SAKURA_AI_ENGINE_RATE_LIMITED_API);
    expect(provider?.streamSimple).toBeFunction();
    expect(provider?.apiKey).toBe(SAKURA_AI_ENGINE_API_KEY_CONFIG_FALLBACK);
    expect(provider?.oauth).toBeUndefined();
    expect(provider?.authHeader).toBeUndefined();

    const models = provider?.models as typeof SAKURA_AI_ENGINE_MODELS | undefined;
    expect(models).toEqual(SAKURA_AI_ENGINE_MODELS);
    expect(models).toHaveLength(1);

    const [model] = models ?? [];
    expect(model).toEqual({
      id: "preview/Kimi-K2.6",
      name: "Kimi K2.6",
      reasoning: true,
      input: ["text", "image"],
      cost: sakuraAiEngineCost(),
      contextWindow: 262_144,
      maxTokens: 256_000,
      compat: SAKURA_AI_ENGINE_OPENAI_COMPAT,
    });
    expect(model?.compat).toEqual({
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsStrictMode: false,
      supportsUsageInStreaming: false,
      supportsReasoningEffort: false,
    });
  });

  test("allows up to the configured parallel request count inside one rate-limit window", async () => {
    const previousWindow = process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV];
    const previousConcurrency = process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV];
    process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV] = "30";
    process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV] = "2";

    try {
      let now = 1_000;
      const sleepDurations: number[] = [];
      const limiter = new SakuraAiEngineRateLimiter(
        () => now,
        async (ms) => {
          sleepDurations.push(ms);
          now += ms;
        },
      );
      const started: string[] = [];
      let finishFirst!: () => void;
      let finishSecond!: () => void;

      const first = limiter.run(async () => {
        started.push("first");
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      });
      const second = limiter.run(async () => {
        started.push("second");
        await new Promise<void>((resolve) => {
          finishSecond = resolve;
        });
      });
      await waitForCondition(
        () => started.length === 2,
        "first two requests did not start inside the same window",
      );

      const third = limiter.run(async () => {
        started.push("third");
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(started).toEqual(["first", "second"]);
      finishFirst();
      finishSecond();
      await first;
      await second;
      await third;

      expect(started).toEqual(["first", "second", "third"]);
      expect(sleepDurations).toEqual([30]);
    } finally {
      restoreEnv(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV, previousWindow);
      restoreEnv(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV, previousConcurrency);
    }
  });

  test("releases the active slot after the protected task throws", async () => {
    const previousWindow = process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV];
    const previousConcurrency = process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV];
    process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV] = "1";
    process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV] = "1";

    try {
      const limiter = new SakuraAiEngineRateLimiter(Date.now, async () => {});

      await expect(
        limiter.run(async () => {
          throw new Error("upstream failed");
        }),
      ).rejects.toThrow("upstream failed");

      let nextStarted = false;
      await limiter.run(async () => {
        nextStarted = true;
      });

      expect(nextStarted).toBe(true);
    } finally {
      restoreEnv(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV, previousWindow);
      restoreEnv(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV, previousConcurrency);
    }
  });

  test("releases the active slot when an acquired request is aborted during window sleep", async () => {
    const previousWindow = process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV];
    const previousConcurrency = process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV];
    process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV] = "100";
    process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV] = "1";

    try {
      let now = 1_000;
      const firstController = new AbortController();
      const limiter = new SakuraAiEngineRateLimiter(
        () => now,
        async (ms, signal) => {
          now += ms;
          signal?.throwIfAborted();
        },
      );

      await limiter.run(async () => {}, firstController.signal);
      firstController.abort(new Error("abort during rate-delay"));
      await expect(limiter.run(async () => {}, firstController.signal)).rejects.toThrow(
        "abort during rate-delay",
      );

      let secondStarted = false;
      const second = limiter.run(async () => {
        secondStarted = true;
      });

      await withTimeout(second, "second request never acquired a released slot", 50);
      expect(secondStarted).toBe(true);
    } finally {
      restoreEnv(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV, previousWindow);
      restoreEnv(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV, previousConcurrency);
    }
  });

  test("delegates to the OpenAI completions stream with the upstream API id", async () => {
    const seenApis: string[] = [];
    const streamSimple = createSakuraAiEngineRateLimitedStreamSimple({
      limiter: new SakuraAiEngineRateLimiter(Date.now, async () => {}),
      upstreamStreamSimple: (model) => {
        seenApis.push(model.api);
        const stream = createAssistantMessageEventStream();
        const message = fakeAssistantMessage(model);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });

    const types = await collectStreamTypes(streamSimple(fakeModel(), {} as Context));

    expect(types).toEqual(["start", "done"]);
    expect(seenApis).toEqual([SAKURA_AI_ENGINE_UPSTREAM_API]);
  });

  test("closes the output stream and relays an error when aborted mid-stream", async () => {
    const controller = new AbortController();
    let upstreamStarted = false;
    const streamSimple = createSakuraAiEngineRateLimitedStreamSimple({
      limiter: new SakuraAiEngineRateLimiter(Date.now, async () => {}),
      upstreamStreamSimple: (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const message = fakeAssistantMessage(model);
        stream.push({ type: "start", partial: message });
        upstreamStarted = true;
        options?.signal?.addEventListener(
          "abort",
          () => {
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
          },
          { once: true },
        );
        return stream;
      },
    });

    const outputStream = streamSimple(fakeModel(), {} as Context, { signal: controller.signal });
    const typesPromise = collectStreamTypes(outputStream);
    await waitForCondition(() => upstreamStarted, "upstream stream never started");
    controller.abort();

    const types = await withTimeout(typesPromise, "stream did not end after mid-stream abort", 50);
    expect(types).toEqual(["start", "error"]);
  });

  test("relays an upstream error event without throwing", async () => {
    const streamSimple = createSakuraAiEngineRateLimitedStreamSimple({
      limiter: new SakuraAiEngineRateLimiter(Date.now, async () => {}),
      upstreamStreamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        const message = fakeAssistantMessage(model);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "error", reason: "error", error: message });
        stream.end();
        return stream;
      },
    });

    const types = await collectStreamTypes(streamSimple(fakeModel(), {} as Context));

    expect(types).toEqual(["start", "error"]);
  });

  test("emits an error event when the upstream stream factory throws", async () => {
    const streamSimple = createSakuraAiEngineRateLimitedStreamSimple({
      limiter: new SakuraAiEngineRateLimiter(Date.now, async () => {}),
      upstreamStreamSimple: () => {
        throw new Error("No API provider registered");
      },
    });

    const types = await collectStreamTypes(streamSimple(fakeModel(), {} as Context));

    expect(types).toEqual(["error"]);
  });

  test("emits an error event when aborted while waiting in the acquire queue", async () => {
    const controller = new AbortController();
    const limiter = new SakuraAiEngineRateLimiter(Date.now, async () => {});

    // Occupy the only concurrency slot so the next request waits in the queue.
    let releaseFirst!: () => void;
    const first = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    const streamSimple = createSakuraAiEngineRateLimitedStreamSimple({
      limiter,
      upstreamStreamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: "stop", message: fakeAssistantMessage(model) });
        stream.end();
        return stream;
      },
    });

    const outputStream = streamSimple(fakeModel(), {} as Context, { signal: controller.signal });
    const typesPromise = collectStreamTypes(outputStream);
    await Promise.resolve();
    controller.abort();

    const types = await withTimeout(
      typesPromise,
      "stream did not end after acquire-queue abort",
      50,
    );
    expect(types).toEqual(["error"]);

    releaseFirst();
    await first;
  });
});
