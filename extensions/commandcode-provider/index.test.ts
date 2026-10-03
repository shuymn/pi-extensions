import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import extension, {
  COMMANDCODE_ANTHROPIC_API,
  COMMANDCODE_ANTHROPIC_BASE_URL,
  COMMANDCODE_DISPLAY_NAME,
  COMMANDCODE_FALLBACK_MODELS,
  COMMANDCODE_MODELS_URL,
  COMMANDCODE_OPENAI_API,
  COMMANDCODE_OPENAI_BASE_URL,
  COMMANDCODE_PROVIDER_ID,
  COMMANDCODE_THINKING_LEVEL_MAP,
  createCommandCodeModelConfig,
  fetchCommandCodeModels,
  parseCommandCodeModels,
} from "./index";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function registerProvider(): Provider {
  let provider: Provider | undefined;
  expect(
    extension({
      registerProvider(value: Provider) {
        provider = value;
      },
    } as never),
  ).toBeUndefined();
  if (!provider) throw new Error("Provider was not registered");
  return provider;
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async ({ update }) => {
      update?.();
      return true;
    },
    ...overrides,
  };
}

afterEach(() => mock.restore());

describe("commandcode-provider extension", () => {
  test("maps Claude models to the Anthropic Messages endpoint", () => {
    const model = createCommandCodeModelConfig({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      context_length: 1_000_000,
    });

    expect(model).toMatchObject({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      api: COMMANDCODE_ANTHROPIC_API,
      baseUrl: COMMANDCODE_ANTHROPIC_BASE_URL,
      reasoning: true,
      thinkingLevelMap: COMMANDCODE_THINKING_LEVEL_MAP,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(model.compat).toEqual({ forceAdaptiveThinking: true });
  });

  test("keeps budget-based thinking for Claude models without adaptive thinking support", () => {
    const model = createCommandCodeModelConfig({
      id: "claude-haiku-4-5-20251001",
      name: "Claude Haiku 4.5",
      context_length: 200_000,
    });

    expect(model.compat).toBeUndefined();
  });

  test("publishes max thinking only for models with matching capabilities", () => {
    for (const id of [
      "claude-haiku-4-5-20251001",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "moonshotai/Kimi-K2.6",
    ]) {
      expect(createCommandCodeModelConfig({ id }).thinkingLevelMap).toEqual({ xhigh: "xhigh" });
    }
    for (const id of ["claude-opus-4-8", "deepseek/deepseek-v4-pro", "moonshotai/Kimi-K3"]) {
      expect(createCommandCodeModelConfig({ id }).thinkingLevelMap).toEqual(
        COMMANDCODE_THINKING_LEVEL_MAP,
      );
    }
  });

  test("uses model-specific max output tokens", () => {
    expect(
      createCommandCodeModelConfig({
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        context_length: 1_000_000,
      }).maxTokens,
    ).toBe(128_000);
    expect(
      createCommandCodeModelConfig({
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        context_length: 1_000_000,
      }).maxTokens,
    ).toBe(131_072);
  });

  test("maps non-Claude models to the OpenAI Chat Completions endpoint", () => {
    const model = createCommandCodeModelConfig({
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      context_length: 1_000_000,
    });

    expect(model).toMatchObject({
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: COMMANDCODE_OPENAI_API,
      baseUrl: COMMANDCODE_OPENAI_BASE_URL,
      reasoning: true,
      thinkingLevelMap: COMMANDCODE_THINKING_LEVEL_MAP,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      compat: {
        maxTokensField: "max_tokens",
        supportsStore: false,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
      },
    });
  });

  test("parses the live model-list wire shape", () => {
    const models = parseCommandCodeModels({
      data: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
        { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", context_length: 256_000 },
        { id: 123, name: "invalid", context_length: 1 },
        { id: "", name: "empty", context_length: 1 },
        { id: "   ", name: "blank", context_length: 1 },
      ],
    });

    expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "moonshotai/Kimi-K2.5"]);
    expect(models[0]?.api).toBe(COMMANDCODE_ANTHROPIC_API);
    expect(models[1]?.api).toBe(COMMANDCODE_OPENAI_API);
  });

  test("fetches models from the unauthenticated Command Code models endpoint", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return jsonResponse({
        data: [{ id: "gpt-5.5", name: "GPT-5.5", context_length: 200_000 }],
      });
    }) as typeof fetch;

    const models = await fetchCommandCodeModels(fetchImpl);

    expect(calls).toEqual([COMMANDCODE_MODELS_URL]);
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("gpt-5.5");
  });

  test("registers synchronously with fallback models and does not fetch offline", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected fetch"));
    const provider = registerProvider();
    expect(provider.id).toBe(COMMANDCODE_PROVIDER_ID);
    expect(provider.name).toBe(COMMANDCODE_DISPLAY_NAME);
    expect(provider.baseUrl).toBe(COMMANDCODE_OPENAI_BASE_URL);
    expect(provider.auth.apiKey).toBeDefined();
    expect(provider.auth.oauth).toBeUndefined();
    expect(provider.getModels()).toEqual(
      COMMANDCODE_FALLBACK_MODELS.map(createCommandCodeModelConfig),
    );
    await provider.refreshModels?.(refreshContext({ allowNetwork: false }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(provider.getAllModels?.()).toEqual(provider.getModels());
  });

  test("replaces the fallback and removes models missing from later live catalogs", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ id: "claude-sonnet-4-6" }, { id: "new-model" }] }),
    );
    const provider = registerProvider();
    await provider.refreshModels?.(refreshContext());
    expect(provider.getModels().map((model) => model.id)).toEqual([
      "claude-sonnet-4-6",
      "new-model",
    ]);
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "new-model" }] }));
    await provider.refreshModels?.(refreshContext());
    expect(provider.getModels().map((model) => model.id)).toEqual(["new-model"]);
    expect(provider.getAllModels?.()).toEqual(provider.getModels());
  });

  for (const [name, response] of [
    ["HTTP failure", () => jsonResponse({}, { status: 503 })],
    ["invalid JSON", () => new Response("not-json")],
    ["empty catalog", () => jsonResponse({ data: [] })],
  ] as const) {
    test(`reports ${name} while retaining the initial or latest successful catalog`, async () => {
      const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(response());
      const provider = registerProvider();
      const fallback = provider.getModels();
      await expect(provider.refreshModels?.(refreshContext())).rejects.toThrow();
      expect(provider.getModels()).toBe(fallback);
      fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: "live-model" }] }));
      await provider.refreshModels?.(refreshContext());
      const live = provider.getModels();
      fetchMock.mockResolvedValue(response());
      await expect(provider.refreshModels?.(refreshContext())).rejects.toThrow();
      expect(provider.getModels()).toBe(live);
    });
  }

  test("does not mutate the catalog when the runtime rejects publication", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: [{ id: "stale-model" }] }));
    const provider = registerProvider();
    const fallback = provider.getModels();
    const publish = mock(async () => false);
    await provider.refreshModels?.(refreshContext({ publish }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(provider.getModels()).toBe(fallback);
  });

  test("combines caller cancellation with the discovery timeout", async () => {
    const controller = new AbortController();
    const timeout = new AbortController();
    const timeoutMock = spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let requestSignal: AbortSignal | null | undefined;
    spyOn(globalThis, "fetch").mockImplementation(((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason));
      });
    }) as typeof fetch);
    const provider = registerProvider();
    const fallback = provider.getModels();
    const refresh = provider.refreshModels?.(refreshContext({ signal: controller.signal }));
    controller.abort(new Error("Cancelled"));
    await expect(refresh).rejects.toThrow("Cancelled");
    expect(requestSignal?.aborted).toBe(true);
    expect(timeoutMock).toHaveBeenCalledWith(10_000);
    expect(provider.getModels()).toBe(fallback);

    const timedRefresh = provider.refreshModels?.(refreshContext());
    timeout.abort(new Error("Timed out"));
    await expect(timedRefresh).rejects.toThrow("Timed out");
    expect(provider.getModels()).toBe(fallback);
  });

  test("aborts hung model discovery requests", async () => {
    const fetchImpl = ((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })) as typeof fetch;

    await expect(fetchCommandCodeModels(fetchImpl, AbortSignal.timeout(50))).rejects.toThrow();
  });
});
