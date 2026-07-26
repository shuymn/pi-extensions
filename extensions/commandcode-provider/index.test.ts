import { describe, expect, test } from "bun:test";
import { createFakePi } from "../../tests/support/fake-pi";
import extension, {
  COMMANDCODE_ANTHROPIC_API,
  COMMANDCODE_ANTHROPIC_BASE_URL,
  COMMANDCODE_API_KEY_CONFIG_FALLBACK,
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
  resolveCommandCodeModels,
} from "./index";

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

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

  test("falls back to a curated model list when live discovery fails", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ error: "unavailable" }, { status: 503 })) as unknown as typeof fetch;

    const models = await resolveCommandCodeModels(fetchImpl);

    expect(models.map((model) => model.id)).toEqual(
      COMMANDCODE_FALLBACK_MODELS.map((model) => model.id),
    );
  });

  test("falls back when the models response is not valid JSON", async () => {
    const fetchImpl = (async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const models = await resolveCommandCodeModels(fetchImpl);

    expect(models.map((model) => model.id)).toEqual(
      COMMANDCODE_FALLBACK_MODELS.map((model) => model.id),
    );
  });

  test("falls back when the models response is empty", async () => {
    const fetchImpl = (async () => jsonResponse({ data: [] })) as unknown as typeof fetch;

    const models = await resolveCommandCodeModels(fetchImpl);

    expect(models.map((model) => model.id)).toEqual(
      COMMANDCODE_FALLBACK_MODELS.map((model) => model.id),
    );
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

  test("registers Command Code as a pi API-key provider with discovered models", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        data: [
          { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
          {
            id: "deepseek/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            context_length: 1_000_000,
          },
        ],
      })) as unknown as typeof fetch;

    try {
      const pi = createFakePi();

      await extension(pi as never);

      const provider = pi.providers.get(COMMANDCODE_PROVIDER_ID);
      expect(provider).toBeDefined();
      expect(provider?.name).toBe(COMMANDCODE_DISPLAY_NAME);
      expect(provider?.baseUrl).toBe(COMMANDCODE_OPENAI_BASE_URL);
      expect(provider?.api).toBe(COMMANDCODE_OPENAI_API);
      expect(provider?.apiKey).toBe(COMMANDCODE_API_KEY_CONFIG_FALLBACK);
      expect(provider?.oauth).toBeUndefined();
      expect(provider?.authHeader).toBeUndefined();
      expect((provider?.models as Array<{ id: string }>).map((model) => model.id)).toEqual([
        "claude-sonnet-4-6",
        "deepseek/deepseek-v4-flash",
      ]);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
