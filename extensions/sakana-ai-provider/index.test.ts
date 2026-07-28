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
  SAKANA_AI_MAX_THINKING_LEVEL_MAP,
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
    expect(models?.map((model) => model.id)).toEqual([
      "fugu",
      "fugu-ultra",
      "fugu-ultra-v1.1",
      "fugu-ultra-v1.0",
      "fugu-cyber",
    ]);
  });

  test("matches the configured model catalog, reasoning levels, context cap, and pricing", () => {
    expect(SAKANA_AI_THINKING_LEVEL_MAP).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "xhigh",
      max: null,
    });
    expect(SAKANA_AI_MAX_THINKING_LEVEL_MAP).toEqual({
      ...SAKANA_AI_THINKING_LEVEL_MAP,
      max: "max",
    });

    for (const model of SAKANA_AI_MODELS) {
      expect(model.contextWindow).toBe(272_000);
      expect(model.maxTokens).toBe(128_000);
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
    expect(SAKANA_AI_MODELS.map((model) => model.thinkingLevelMap)).toEqual([
      SAKANA_AI_THINKING_LEVEL_MAP,
      SAKANA_AI_MAX_THINKING_LEVEL_MAP,
      SAKANA_AI_MAX_THINKING_LEVEL_MAP,
      SAKANA_AI_THINKING_LEVEL_MAP,
      SAKANA_AI_THINKING_LEVEL_MAP,
    ]);
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
      previous_response_id: "resp_123",
      reasoning: { effort: "xhigh", summary: "auto" },
      tools: [
        {
          type: "function",
          name: "responses_tool",
          strict: false,
          function: { name: "chat_tool", parameters: {}, strict: false },
        },
        {
          type: "web_search",
          search_context_size: "high",
          user_location: { type: "approximate", country: "JP" },
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
        { type: "web_search" },
      ],
    });
  });

  test("keeps reasoning summaries only for models that support them", () => {
    const payload = {
      model: "ignored-by-sanitizer",
      input: [],
      reasoning: { effort: "high", summary: "auto" },
    };
    const summaryOnlyPayload = {
      model: "ignored-by-sanitizer",
      input: [],
      reasoning: { summary: "auto" },
    };

    expect(sanitizeSakanaResponsesPayload(payload, "fugu")).toEqual({
      model: "ignored-by-sanitizer",
      input: [],
      reasoning: { effort: "high" },
    });
    expect(sanitizeSakanaResponsesPayload(summaryOnlyPayload, "fugu")).toEqual({
      model: "ignored-by-sanitizer",
      input: [],
    });
    for (const modelId of ["fugu-ultra", "fugu-ultra-v1.1", "fugu-ultra-v1.0", "fugu-cyber"]) {
      expect(sanitizeSakanaResponsesPayload(payload, modelId)).toEqual(payload);
      expect(sanitizeSakanaResponsesPayload(summaryOnlyPayload, modelId)).toEqual(
        summaryOnlyPayload,
      );
    }
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

  test("keeps the public Sakana API identity across hooks, events, and replayed context", async () => {
    const upstreamContextApis: string[] = [];
    const payloadHookApis: string[] = [];
    const responseHookApis: string[] = [];
    const eventApis: string[] = [];
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model, context, options) => {
        upstreamContextApis.push(
          ...context.messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.api),
        );
        const stream = createAssistantMessageEventStream();
        void (async () => {
          await options?.onPayload?.({ model: model.id, input: [] }, model);
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          const message = fakeAssistantMessage(model);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
        })();
        return stream;
      },
    });
    const model = fakeModel();
    const output = streamSimple(
      model,
      { messages: [fakeAssistantMessage(model)] },
      {
        onPayload(_payload, hookModel) {
          payloadHookApis.push(hookModel.api);
        },
        onResponse(_response, hookModel) {
          responseHookApis.push(hookModel.api);
        },
      },
    );

    for await (const event of output) {
      if ("partial" in event) eventApis.push(event.partial.api);
      if (event.type === "done") eventApis.push(event.message.api);
    }
    const result = await output.result();

    expect(upstreamContextApis).toEqual([SAKANA_AI_UPSTREAM_API]);
    expect(payloadHookApis).toEqual([SAKANA_AI_RESPONSES_API]);
    expect(responseHookApis).toEqual([SAKANA_AI_RESPONSES_API]);
    expect(eventApis).toEqual([SAKANA_AI_RESPONSES_API, SAKANA_AI_RESPONSES_API]);
    expect(result.api).toBe(SAKANA_AI_RESPONSES_API);
  });

  test("keeps the public Sakana API identity for upstream errors and aborts", async () => {
    for (const reason of ["error", "aborted"] as const) {
      const streamSimple = createSakanaAiStreamSimple({
        upstreamStreamSimple: (model) => {
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "error",
            reason,
            error: {
              ...fakeAssistantMessage(model),
              stopReason: reason,
              errorMessage: `upstream ${reason}`,
            },
          });
          return stream;
        },
      });

      const result = await streamSimple(fakeModel(), {} as Context).result();

      expect(result.api).toBe(SAKANA_AI_RESPONSES_API);
      expect(result.stopReason).toBe(reason);
      expect(result.errorMessage).toBe(`upstream ${reason}`);
    }
  });

  test("preserves explicit request timeout and retry overrides", async () => {
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

    for (const [timeoutMs, maxRetries] of [
      [SAKANA_AI_DEFAULT_TIMEOUT_MS - 1, 2],
      [SAKANA_AI_DEFAULT_TIMEOUT_MS + 1, 1],
      [0, 0],
    ] as const) {
      await collectStreamTypes(streamSimple(fakeModel(), {} as Context, { timeoutMs, maxRetries }));
    }

    expect(seenOptions).toEqual([
      { timeoutMs: SAKANA_AI_DEFAULT_TIMEOUT_MS - 1, maxRetries: 2 },
      { timeoutMs: SAKANA_AI_DEFAULT_TIMEOUT_MS + 1, maxRetries: 1 },
      { timeoutMs: 0, maxRetries: 0 },
    ]);
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

  test("sanitizes replacements returned by user payload hooks before sending", async () => {
    const finalPayloads: unknown[] = [];
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          finalPayloads.push(
            await options?.onPayload?.(
              {
                model: "fugu",
                input: [],
                store: false,
                reasoning: { effort: "high", summary: "auto" },
                tools: [{ type: "function", name: "original", strict: true }],
              },
              model,
            ),
          );
          const message = fakeAssistantMessage(model);
          stream.push({ type: "done", reason: "stop", message });
        })();
        return stream;
      },
    });

    await collectStreamTypes(
      streamSimple(fakeModel(), {} as Context, {
        onPayload() {
          return {
            model: "fugu",
            input: [],
            store: true,
            previous_response_id: "resp_reintroduced",
            reasoning: { summary: "auto" },
            tools: [
              { type: "function", name: "replacement", strict: true },
              { type: "web_search", search_context_size: "high" },
            ],
          };
        },
      }),
    );

    expect(finalPayloads).toEqual([
      {
        model: "fugu",
        input: [],
        tools: [{ type: "function", name: "replacement" }, { type: "web_search" }],
      },
    ]);
  });

  test("keeps supported reasoning summaries before user payload hooks inspect them", async () => {
    const seenPayloads: unknown[] = [];
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model, _context, options) => {
        void options?.onPayload?.(
          {
            model: "fugu-ultra-v1.1",
            input: [],
            reasoning: { effort: "max", summary: "auto" },
          },
          model,
        );
        const stream = createAssistantMessageEventStream();
        const message = fakeAssistantMessage(model);
        stream.push({ type: "done", reason: "stop", message });
        return stream;
      },
    });

    const ultraModel = {
      ...fakeModel(),
      ...SAKANA_AI_MODELS[2],
    } as Model<Api>;
    await collectStreamTypes(
      streamSimple(ultraModel, {} as Context, {
        onPayload(payload) {
          seenPayloads.push(payload);
        },
      }),
    );

    expect(seenPayloads).toEqual([
      {
        model: "fugu-ultra-v1.1",
        input: [],
        reasoning: { effort: "max", summary: "auto" },
      },
    ]);
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

  test("resolves with a protocol error when the upstream ends without a terminal event", async () => {
    const streamSimple = createSakanaAiStreamSimple({
      upstreamStreamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: fakeAssistantMessage(model) });
        // Non-conformant upstream: ends without pushing a terminal done/error event.
        stream.end();
        return stream;
      },
    });

    const output = streamSimple(fakeModel(), {} as Context);
    const types = await withTimeout(collectStreamTypes(output), "output stream did not close", 100);
    const result = await withTimeout(output.result(), "output result did not resolve", 100);

    expect(types).toEqual(["start", "error"]);
    expect(result.api).toBe(SAKANA_AI_RESPONSES_API);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Upstream stream ended without a terminal event");
  });
});
