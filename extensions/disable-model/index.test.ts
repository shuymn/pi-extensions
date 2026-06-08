import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

import { isolateEnvVars } from "../../tests/support/env";
import disableModelExtension, {
  DISABLE_MODEL_SETTINGS_KEY,
  isModelHidden,
  parseExclusionRules,
} from "./index";

const ENV_KEYS = ["PI_CODING_AGENT_DIR"] as const;

type Handler = (event: unknown, ctx: FakeContext) => unknown;
type FakeContext = ReturnType<typeof createContext>;

type FakeModel = Model<Api>;

const openaiModel = model("openai", "gpt-4o");
const openaiMiniModel = model("openai", "gpt-4o-mini");
const anthropicModel = model("anthropic", "claude-sonnet-4-5");

function model(provider: string, id: string): FakeModel {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
}

function createFakePi(setModelResult = true) {
  const handlers = new Map<string, Handler[]>();
  const setModelCalls: FakeModel[] = [];

  return {
    handlers,
    setModelCalls,
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async setModel(model: FakeModel) {
      setModelCalls.push(model);
      return setModelResult;
    },
  };
}

function createContext(options: {
  cwd: string;
  models?: FakeModel[];
  model?: FakeModel;
  hasUI?: boolean;
}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const shutdownCalls: boolean[] = [];
  const models = options.models ?? [openaiModel, openaiMiniModel, anthropicModel];

  return {
    cwd: options.cwd,
    model: options.model,
    hasUI: options.hasUI ?? true,
    notifications,
    shutdownCalls,
    shutdown() {
      shutdownCalls.push(true);
    },
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    modelRegistry: {
      getAll: () => [...models] as Model<Api>[],
      getAvailable: () => [...models] as Model<Api>[],
      find(provider: string, modelId: string) {
        return models.find(
          (candidate) => candidate.provider === provider && candidate.id === modelId,
        ) as Model<Api> | undefined;
      },
    },
  };
}

function writeSettings(path: string, settings: unknown) {
  mkdirSync(join(path, ".pi"), { recursive: true });
  writeFileSync(join(path, ".pi", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

describe("disable-model extension", () => {
  isolateEnvVars(ENV_KEYS);

  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-disable-model-extension-"));
    process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("parses provider and provider/model exclusions", () => {
    expect(parseExclusionRules("openai, anthropic/claude-sonnet-4-5, invalid/")).toEqual([
      { type: "provider", provider: "openai" },
      { type: "model", provider: "anthropic", model: "claude-sonnet-4-5" },
    ]);
  });

  test("deduplicates exclusions from nested arrays", () => {
    expect(parseExclusionRules(["openai", ["openai", "openai/gpt-4o"]])).toEqual([
      { type: "provider", provider: "openai" },
      { type: "model", provider: "openai", model: "gpt-4o" },
    ]);
  });

  test("ignores unsupported wildcard-like exclusions", () => {
    expect(parseExclusionRules("openai/*, */gpt-4o, openai/gpt-*, anthropic")).toEqual([
      { type: "provider", provider: "anthropic" },
    ]);
  });

  test("matches provider and provider/model rules exactly", () => {
    const rules = parseExclusionRules("openai/gpt-4o,anthropic");

    expect(isModelHidden(openaiModel, rules)).toBe(true);
    expect(isModelHidden(openaiMiniModel, rules)).toBe(false);
    expect(isModelHidden(anthropicModel, rules)).toBe(true);
  });

  test("registers session_start listener", () => {
    const pi = createFakePi();
    disableModelExtension(pi as never);

    expect(pi.handlers.has("session_start")).toBe(true);
  });

  test("filters model registry methods from project settings", async () => {
    writeSettings(tempDir, {
      [DISABLE_MODEL_SETTINGS_KEY]: { exclude: ["openai/gpt-4o", "anthropic"] },
    });
    const pi = createFakePi();
    disableModelExtension(pi as never);
    const ctx = createContext({ cwd: tempDir });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(ctx.modelRegistry.getAll()).toEqual([openaiMiniModel]);
    expect(ctx.modelRegistry.getAvailable()).toEqual([openaiMiniModel]);
    expect(ctx.modelRegistry.find("openai", "gpt-4o")).toBeUndefined();
    expect(ctx.modelRegistry.find("openai", "gpt-4o-mini")).toEqual(openaiMiniModel);
    expect(ctx.notifications).toEqual([
      { message: "disable-model 設定を適用しました: 2 件", level: "info" },
    ]);
  });

  test("accepts comma-separated exclusions from project settings", async () => {
    writeSettings(tempDir, {
      [DISABLE_MODEL_SETTINGS_KEY]: { exclude: "openai/gpt-4o,anthropic" },
    });
    const pi = createFakePi();
    disableModelExtension(pi as never);
    const ctx = createContext({ cwd: tempDir });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(ctx.modelRegistry.getAvailable()).toEqual([openaiMiniModel]);
  });

  test("restores model registry methods when exclusions are removed", async () => {
    writeSettings(tempDir, { [DISABLE_MODEL_SETTINGS_KEY]: { exclude: "openai/gpt-4o" } });
    const pi = createFakePi();
    disableModelExtension(pi as never);
    const ctx = createContext({ cwd: tempDir });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);
    expect(ctx.modelRegistry.getAvailable()).toEqual([openaiMiniModel, anthropicModel]);

    writeSettings(tempDir, {});
    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(ctx.modelRegistry.getAvailable()).toEqual([
      openaiModel,
      openaiMiniModel,
      anthropicModel,
    ]);
  });

  test("switches away when the current model is excluded", async () => {
    writeSettings(tempDir, { [DISABLE_MODEL_SETTINGS_KEY]: { exclude: "openai/gpt-4o" } });
    const pi = createFakePi();
    disableModelExtension(pi as never);
    const ctx = createContext({ cwd: tempDir, model: openaiModel });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(pi.setModelCalls).toEqual([openaiMiniModel]);
    expect(ctx.shutdownCalls).toEqual([]);
    expect(ctx.notifications).toContainEqual({
      message: "disable-model によりモデルを切り替えました: openai/gpt-4o-mini",
      level: "warning",
    });
  });

  test("shuts down when the current model is excluded and no replacement is available", async () => {
    writeSettings(tempDir, { [DISABLE_MODEL_SETTINGS_KEY]: { exclude: "openai" } });
    const pi = createFakePi();
    disableModelExtension(pi as never);
    const ctx = createContext({ cwd: tempDir, models: [openaiModel], model: openaiModel });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(pi.setModelCalls).toEqual([]);
    expect(ctx.shutdownCalls).toEqual([true]);
    expect(ctx.notifications).toContainEqual({
      message: "disable-model の対象モデルが選択中ですが、切り替え先がありません",
      level: "error",
    });
  });

  test("does nothing when no exclusions are configured", async () => {
    const pi = createFakePi();
    disableModelExtension(pi as never);
    const ctx = createContext({ cwd: tempDir });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(ctx.modelRegistry.getAvailable()).toEqual([
      openaiModel,
      openaiMiniModel,
      anthropicModel,
    ]);
    expect(ctx.notifications).toEqual([]);
  });
});
