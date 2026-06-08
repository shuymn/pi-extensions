import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolateEnvVars } from "../../tests/support/env";
import envExtension, { hasCliModelArg, PI_MODEL_ENV, resolveEnvModelSelection } from "./index";

const ENV_KEYS = ["PI_CODING_AGENT_DIR", PI_MODEL_ENV] as const;

type Handler = (event: unknown, ctx: FakeContext) => unknown;
type FakeModel = { provider: string; id: string };
type FakeContext = ReturnType<typeof createContext>;

function createFakePi(setModelResult = true) {
  const handlers = new Map<string, Handler[]>();
  const setModelCalls: FakeModel[] = [];
  const thinkingLevelCalls: string[] = [];

  return {
    handlers,
    setModelCalls,
    thinkingLevelCalls,
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async setModel(model: FakeModel) {
      setModelCalls.push(model);
      return setModelResult;
    },
    setThinkingLevel(level: string) {
      thinkingLevelCalls.push(level);
    },
  };
}

function createContext(options: { cwd: string; model?: FakeModel; hasUI?: boolean }) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const models = new Map<string, FakeModel>();
  if (options.model) {
    models.set(`${options.model.provider}/${options.model.id}`, options.model);
  }

  return {
    cwd: options.cwd,
    hasUI: options.hasUI ?? true,
    notifications,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    modelRegistry: {
      find(provider: string, model: string) {
        return models.get(`${provider}/${model}`);
      },
    },
  };
}

function writeSettings(path: string, settings: unknown) {
  mkdirSync(join(path, ".pi"), { recursive: true });
  writeFileSync(join(path, ".pi", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

async function withArgv<T>(argv: string[], run: () => T | Promise<T>): Promise<T> {
  const original = process.argv;
  Object.defineProperty(process, "argv", { configurable: true, value: argv });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "argv", { configurable: true, value: original });
  }
}

describe("env extension", () => {
  isolateEnvVars(ENV_KEYS);

  let tempDir: string;
  let agentDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-env-extension-"));
    agentDir = join(tempDir, "agent");
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("resolves provider, model, and thinking level from PI_MODEL", () => {
    process.env[PI_MODEL_ENV] = "openai/gpt-4o:high";

    expect(resolveEnvModelSelection()).toEqual({
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "high",
    });
  });

  test("accepts provider and thinking shorthand in PI_MODEL", () => {
    process.env[PI_MODEL_ENV] = "anthropic/claude-sonnet-4-5:low";

    expect(resolveEnvModelSelection()).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "low",
    });
  });

  test("settings provide PI_MODEL-compatible value", () => {
    expect(resolveEnvModelSelection({ [PI_MODEL_ENV]: "google/gemini-2.5-pro:medium" })).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
      thinkingLevel: "medium",
    });
  });

  test("environment PI_MODEL overrides settings PI_MODEL", () => {
    process.env[PI_MODEL_ENV] = "openai/gpt-4o";

    expect(resolveEnvModelSelection({ [PI_MODEL_ENV]: "anthropic/claude-sonnet-4-5" })).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  test("detects CLI model selection forms", () => {
    expect(hasCliModelArg(["bun", "pi", "--model", "openai/gpt-4o"])).toBe(true);
    expect(hasCliModelArg(["bun", "pi", "--model=openai/gpt-4o"])).toBe(true);
    expect(hasCliModelArg(["bun", "pi", "--models", "openai/gpt-4o"])).toBe(true);
    expect(hasCliModelArg(["bun", "pi", "--models=openai/gpt-4o"])).toBe(true);
    expect(hasCliModelArg(["bun", "pi", "--fallback-model", "openai/gpt-4o"])).toBe(false);
  });

  test("switches model from project settings on session start", async () => {
    writeSettings(tempDir, { env: { [PI_MODEL_ENV]: "openai/gpt-4o:high" } });
    const model = { provider: "openai", id: "gpt-4o" };
    const pi = createFakePi();
    envExtension(pi as never);
    const ctx = createContext({ cwd: tempDir, model });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(pi.setModelCalls).toEqual([model]);
    expect(pi.thinkingLevelCalls).toEqual(["high"]);
    expect(ctx.notifications).toEqual([]);
  });

  test("does nothing when CLI model selection is present", async () => {
    writeSettings(tempDir, { env: { [PI_MODEL_ENV]: "openai/gpt-4o:high" } });
    const model = { provider: "openai", id: "gpt-4o" };
    const pi = createFakePi();
    envExtension(pi as never);
    const ctx = createContext({ cwd: tempDir, model });

    await withArgv(["bun", "pi", "--models", "anthropic/claude-sonnet-4-5"], async () => {
      await pi.handlers.get("session_start")?.[0]?.({}, ctx);
    });

    expect(pi.setModelCalls).toEqual([]);
    expect(pi.thinkingLevelCalls).toEqual([]);
    expect(ctx.notifications).toEqual([]);
  });

  test("warns when configured model is missing", async () => {
    writeSettings(tempDir, { env: { [PI_MODEL_ENV]: "openai/missing:high" } });
    const pi = createFakePi();
    envExtension(pi as never);
    const ctx = createContext({ cwd: tempDir });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(pi.setModelCalls).toEqual([]);
    expect(ctx.notifications).toEqual([
      { message: "env model が見つかりません: openai/missing:high", level: "warning" },
    ]);
  });

  test("warns when configured model cannot be selected", async () => {
    writeSettings(tempDir, { env: { [PI_MODEL_ENV]: "openai/gpt-4o:high" } });
    const model = { provider: "openai", id: "gpt-4o" };
    const pi = createFakePi(false);
    envExtension(pi as never);
    const ctx = createContext({ cwd: tempDir, model });

    await pi.handlers.get("session_start")?.[0]?.({}, ctx);

    expect(pi.setModelCalls).toEqual([model]);
    expect(pi.thinkingLevelCalls).toEqual([]);
    expect(ctx.notifications).toEqual([
      { message: "env model に切り替えられません: openai/gpt-4o:high", level: "warning" },
    ]);
  });
});
