import { describe, expect, test } from "bun:test";

import fallbackModelExtension, {
  FALLBACK_MODEL_FLAG,
  parseFallbackModelList,
  shouldFallbackForError,
} from "./index";

type Model = { provider: string; id: string };
type EventHandler = (event: any, ctx: any) => Promise<unknown> | unknown;

function createFakePi(
  flags: Record<string, unknown> = {},
  { setModelResults = [] }: { setModelResults?: boolean[] } = {},
) {
  const events = new Map<string, EventHandler[]>();
  const flagValues = new Map(Object.entries(flags));
  const registeredFlags = new Set<string>();

  return {
    events,
    flags: [] as Array<{ name: string; definition: unknown }>,
    selectedModels: [] as Model[],
    selectedThinkingLevels: [] as string[],
    on(eventName: string, handler: EventHandler) {
      events.set(eventName, [...(events.get(eventName) ?? []), handler]);
    },
    registerFlag(name: string, definition: unknown) {
      registeredFlags.add(name);
      this.flags.push({ name, definition });
      if (
        definition &&
        typeof definition === "object" &&
        "default" in definition &&
        !flagValues.has(name)
      ) {
        flagValues.set(name, definition.default);
      }
    },
    getFlag(name: string) {
      if (!registeredFlags.has(name)) return undefined;
      return flagValues.get(name);
    },
    async setModel(model: Model) {
      this.selectedModels.push(model);
      return setModelResults.shift() ?? true;
    },
    setThinkingLevel(level: string) {
      this.selectedThinkingLevels.push(level);
    },
  };
}

function createCtx({
  currentModel = { provider: "anthropic", id: "claude-primary" },
  available = new Map<string, Model>(),
  hasUI = true,
}: {
  currentModel?: Model;
  available?: Map<string, Model>;
  hasUI?: boolean;
} = {}) {
  const notifications: Array<{ message: string; level: string }> = [];
  return {
    ctx: {
      hasUI,
      model: currentModel,
      modelRegistry: {
        find(provider: string, id: string) {
          return available.get(`${provider}/${id}`);
        },
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    },
    notifications,
  };
}

const assistantError = (errorMessage: string) => ({
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    content: [],
  },
});

describe("fallback-model extension", () => {
  test("parses comma-separated provider/model entries with optional effort", () => {
    expect(
      parseFallbackModelList("anthropic/claude, openai/gpt-5:low, google/gemini:xhigh"),
    ).toEqual([
      { provider: "anthropic", model: "claude" },
      { provider: "openai", model: "gpt-5", thinkingLevel: "low" },
      { provider: "google", model: "gemini", thinkingLevel: "xhigh" },
    ]);
  });

  test("ignores invalid or empty fallback entries and keeps unknown colon suffixes as model ids", () => {
    expect(parseFallbackModelList(" , invalid, /missing-provider, openai/, ok/model:bad ")).toEqual(
      [{ provider: "ok", model: "model:bad" }],
    );
  });

  test("registers --fallback-model string flag", () => {
    const pi = createFakePi();

    fallbackModelExtension(pi as never);

    expect(pi.flags).toEqual([
      {
        name: FALLBACK_MODEL_FLAG,
        definition: {
          description:
            'Comma-separated fallback models, e.g. "provider/model,provider/model:high". Put thinking level in the final colon segment.',
          type: "string",
        },
      },
    ]);
  });

  test("switches to the first fallback model and applies specified effort", async () => {
    const pi = createFakePi({ [FALLBACK_MODEL_FLAG]: "openai/gpt-5:low,google/gemini" });
    fallbackModelExtension(pi as never);
    const openaiModel = { provider: "openai", id: "gpt-5" };
    const { ctx, notifications } = createCtx({
      available: new Map([["openai/gpt-5", openaiModel]]),
    });

    const result = await pi.events.get("message_end")![0]!(assistantError("429 rate limit"), ctx);

    expect(pi.selectedModels).toEqual([openaiModel]);
    expect(pi.selectedThinkingLevels).toEqual(["low"]);
    expect(result).toEqual({
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider returned error: fallback model selected after: 429 rate limit",
        content: [],
      },
    });
    expect(notifications).toEqual([
      { message: "Fallback model に切り替えます: openai/gpt-5:low", level: "warning" },
    ]);
  });

  test("accepts thinking level suffixes case-insensitively", () => {
    expect(parseFallbackModelList("openai/gpt-5:HIGH")).toEqual([
      { provider: "openai", model: "gpt-5", thinkingLevel: "high" },
    ]);
  });

  test("leaves thinking level unchanged when effort is omitted", async () => {
    const pi = createFakePi({ [FALLBACK_MODEL_FLAG]: "google/gemini" });
    fallbackModelExtension(pi as never);
    const geminiModel = { provider: "google", id: "gemini" };
    const { ctx } = createCtx({ available: new Map([["google/gemini", geminiModel]]) });

    await pi.events.get("message_end")![0]!(assistantError("model unavailable"), ctx);

    expect(pi.selectedModels).toEqual([geminiModel]);
    expect(pi.selectedThinkingLevels).toEqual([]);
  });

  test("falls back sequentially across repeated errors", async () => {
    const pi = createFakePi({ [FALLBACK_MODEL_FLAG]: "openai/gpt-5,google/gemini:xhigh" });
    fallbackModelExtension(pi as never);
    const openaiModel = { provider: "openai", id: "gpt-5" };
    const geminiModel = { provider: "google", id: "gemini" };
    const { ctx } = createCtx({
      available: new Map([
        ["openai/gpt-5", openaiModel],
        ["google/gemini", geminiModel],
      ]),
    });

    await pi.events.get("message_end")![0]!(assistantError("429"), ctx);
    ctx.model = openaiModel;
    await pi.events.get("message_end")![0]!(assistantError("503"), ctx);

    expect(pi.selectedModels).toEqual([openaiModel, geminiModel]);
    expect(pi.selectedThinkingLevels).toEqual(["xhigh"]);
  });

  test("skips the current model and unavailable candidates", async () => {
    const pi = createFakePi({
      [FALLBACK_MODEL_FLAG]: "anthropic/claude-primary,openai/missing,google/gemini",
    });
    fallbackModelExtension(pi as never);
    const geminiModel = { provider: "google", id: "gemini" };
    const { ctx } = createCtx({ available: new Map([["google/gemini", geminiModel]]) });

    await pi.events.get("message_end")![0]!(assistantError("overloaded"), ctx);

    expect(pi.selectedModels).toEqual([geminiModel]);
  });

  test("skips candidates when setModel declines them", async () => {
    const pi = createFakePi(
      { [FALLBACK_MODEL_FLAG]: "openai/gpt-5,google/gemini" },
      { setModelResults: [false, true] },
    );
    fallbackModelExtension(pi as never);
    const openaiModel = { provider: "openai", id: "gpt-5" };
    const geminiModel = { provider: "google", id: "gemini" };
    const { ctx } = createCtx({
      available: new Map([
        ["openai/gpt-5", openaiModel],
        ["google/gemini", geminiModel],
      ]),
    });

    const result = await pi.events.get("message_end")![0]!(assistantError("503"), ctx);

    expect(pi.selectedModels).toEqual([openaiModel, geminiModel]);
    expect(result).toEqual({
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider returned error: fallback model selected after: 503",
        content: [],
      },
    });
  });

  test("returns undefined when setModel declines all candidates", async () => {
    const pi = createFakePi(
      { [FALLBACK_MODEL_FLAG]: "openai/gpt-5,google/gemini" },
      { setModelResults: [false, false] },
    );
    fallbackModelExtension(pi as never);
    const openaiModel = { provider: "openai", id: "gpt-5" };
    const geminiModel = { provider: "google", id: "gemini" };
    const { ctx } = createCtx({
      available: new Map([
        ["openai/gpt-5", openaiModel],
        ["google/gemini", geminiModel],
      ]),
    });

    const result = await pi.events.get("message_end")![0]!(assistantError("503"), ctx);

    expect(result).toBeUndefined();
    expect(pi.selectedModels).toEqual([openaiModel, geminiModel]);
  });

  test("returns undefined when all candidates are unavailable", async () => {
    const pi = createFakePi({ [FALLBACK_MODEL_FLAG]: "openai/missing,google/missing" });
    fallbackModelExtension(pi as never);
    const { ctx } = createCtx();

    const result = await pi.events.get("message_end")![0]!(assistantError("503"), ctx);

    expect(result).toBeUndefined();
    expect(pi.selectedModels).toEqual([]);
  });

  test("switches models without notifying when UI is unavailable", async () => {
    const pi = createFakePi({ [FALLBACK_MODEL_FLAG]: "openai/gpt-5" });
    fallbackModelExtension(pi as never);
    const openaiModel = { provider: "openai", id: "gpt-5" };
    const { ctx, notifications } = createCtx({
      available: new Map([["openai/gpt-5", openaiModel]]),
      hasUI: false,
    });

    await pi.events.get("message_end")![0]!(assistantError("503"), ctx);

    expect(pi.selectedModels).toEqual([openaiModel]);
    expect(notifications).toEqual([]);
  });

  test("does not fallback for non-target errors", async () => {
    const pi = createFakePi({ [FALLBACK_MODEL_FLAG]: "openai/gpt-5" });
    fallbackModelExtension(pi as never);
    const { ctx } = createCtx({
      available: new Map([["openai/gpt-5", { provider: "openai", id: "gpt-5" }]]),
    });

    const result = await pi.events.get("message_end")![0]!(
      assistantError("401 invalid api key"),
      ctx,
    );

    expect(result).toBeUndefined();
    expect(pi.selectedModels).toEqual([]);
  });

  test("recognizes retryable model availability errors", () => {
    expect(shouldFallbackForError("model unavailable")).toBe(true);
    expect(shouldFallbackForError("quota exceeded")).toBe(false);
    expect(shouldFallbackForError("403 authorization failed")).toBe(false);
    expect(shouldFallbackForError("401 invalid api key")).toBe(false);
  });
});
