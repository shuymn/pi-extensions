import { describe, expect, test } from "bun:test";
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
  createSakanaAiStreamSimple,
  SAKANA_AI_API_KEY_CONFIG_FALLBACK,
  SAKANA_AI_BASE_URL,
  SAKANA_AI_DEFAULT_MAX_RETRIES,
  SAKANA_AI_DEFAULT_TIMEOUT_MS,
  SAKANA_AI_DISPLAY_NAME,
  SAKANA_AI_MODELS,
  SAKANA_AI_PROVIDER_ID,
  SAKANA_AI_RESPONSES_API,
  SAKANA_AI_THINKING_LEVEL_MAP,
  SAKANA_AI_UPSTREAM_API,
  sanitizeSakanaResponsesPayload,
} from "./index";

function fakeModel(): Model<Api> {
  return {
    ...SAKANA_AI_MODELS[0],
    api: SAKANA_AI_RESPONSES_API,
    provider: SAKANA_AI_PROVIDER_ID,
    baseUrl: SAKANA_AI_BASE_URL,
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
  stream: ReturnType<ReturnType<typeof createSakanaAiStreamSimple>>,
) {
  const types: string[] = [];
  for await (const event of stream) {
    types.push(event.type);
  }
  return types;
}

describe("sakana-ai-provider extension", () => {
  test("registers Sakana AI as a Responses API-key provider", () => {
    const pi = createFakePi();

    extension(pi as never);

    const provider = pi.providers.get(SAKANA_AI_PROVIDER_ID);
    expect(provider).toBeDefined();
    expect(provider?.name).toBe(SAKANA_AI_DISPLAY_NAME);
    expect(provider?.baseUrl).toBe(SAKANA_AI_BASE_URL);
    expect(provider?.api).toBe(SAKANA_AI_RESPONSES_API);
    expect(provider?.apiKey).toBe(SAKANA_AI_API_KEY_CONFIG_FALLBACK);
    expect(provider?.streamSimple).toBeFunction();
    expect(provider?.oauth).toBeUndefined();
    expect(provider?.authHeader).toBeUndefined();

    const models = provider?.models as typeof SAKANA_AI_MODELS | undefined;
    expect(models).toEqual(SAKANA_AI_MODELS);
    expect(models?.map((model) => model.id)).toEqual(["fugu", "fugu-ultra"]);
  });

  test("exposes only Sakana-supported thinking levels", () => {
    expect(SAKANA_AI_THINKING_LEVEL_MAP).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  test("removes unsupported OpenAI Responses request fields", () => {
    const payload = sanitizeSakanaResponsesPayload({
      model: "fugu",
      input: [{ role: "user", content: "hello" }],
      prompt_cache_key: "cache-key",
      prompt_cache_retention: "24h",
      store: false,
      service_tier: "priority",
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "xhigh", summary: "auto" },
      tools: [
        {
          type: "function",
          name: "responses_tool",
          strict: false,
          function: { name: "chat_tool", parameters: {}, strict: false },
        },
      ],
    });

    expect(payload).toEqual({
      model: "fugu",
      input: [{ role: "user", content: "hello" }],
      reasoning: { effort: "xhigh" },
      tools: [
        {
          type: "function",
          name: "responses_tool",
          function: { name: "chat_tool", parameters: {} },
        },
      ],
    });
  });

  test("delegates to the OpenAI Responses stream with Sakana fallback defaults when the caller omits options", async () => {
    const seenApis: string[] = [];
    const seenOptions: Array<{ timeoutMs?: number; maxRetries?: number }> = [];
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model, _context, options) => {
        seenApis.push(model.api);
        seenOptions.push({ timeoutMs: options?.timeoutMs, maxRetries: options?.maxRetries });
        const stream = createAssistantMessageEventStream();
        const message = fakeAssistantMessage(model);
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });

    const types = await collectStreamTypes(streamSimple(fakeModel(), {} as Context));

    expect(types).toEqual(["start", "done"]);
    expect(seenApis).toEqual([SAKANA_AI_UPSTREAM_API]);
    expect(seenOptions).toEqual([
      { timeoutMs: SAKANA_AI_DEFAULT_TIMEOUT_MS, maxRetries: SAKANA_AI_DEFAULT_MAX_RETRIES },
    ]);
  });

  test("preserves caller timeout and retry overrides", async () => {
    const seenOptions: Array<{ timeoutMs?: number; maxRetries?: number }> = [];
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model, _context, options) => {
        seenOptions.push({ timeoutMs: options?.timeoutMs, maxRetries: options?.maxRetries });
        const stream = createAssistantMessageEventStream();
        const message = fakeAssistantMessage(model);
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });

    await collectStreamTypes(
      streamSimple(fakeModel(), {} as Context, { timeoutMs: 123_000, maxRetries: 2 }),
    );

    expect(seenOptions).toEqual([{ timeoutMs: 123_000, maxRetries: 2 }]);
  });

  test("sanitizes payloads before user payload hooks inspect them", async () => {
    const seenPayloads: unknown[] = [];
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model, _context, options) => {
        void options?.onPayload?.(
          {
            model: "fugu",
            input: [],
            store: false,
            reasoning: { effort: "high", summary: "auto" },
          },
          model,
        );
        const stream = createAssistantMessageEventStream();
        const message = fakeAssistantMessage(model);
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });

    await collectStreamTypes(
      streamSimple(fakeModel(), {} as Context, {
        onPayload(payload) {
          seenPayloads.push(payload);
        },
      }),
    );

    expect(seenPayloads).toEqual([{ model: "fugu", input: [], reasoning: { effort: "high" } }]);
  });

  test("emits an error event when the upstream stream factory throws", async () => {
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: () => {
        throw new Error("No API provider registered");
      },
    });

    const types = await collectStreamTypes(streamSimple(fakeModel(), {} as Context));

    expect(types).toEqual(["error"]);
  });

  test("closes the output stream when the upstream ends without a terminal event", async () => {
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: fakeAssistantMessage(model) });
        // Non-conformant upstream: ends without pushing a terminal done/error event.
        stream.end();
        return stream;
      },
    });

    const types = await withTimeout(
      collectStreamTypes(streamSimple(fakeModel(), {} as Context)),
      "output stream did not close",
      100,
    );
    expect(types).toEqual(["start"]);
  });
});
