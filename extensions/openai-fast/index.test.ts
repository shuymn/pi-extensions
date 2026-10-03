import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { OPENAI_FAST_STATUS_KEY, OPENAI_FAST_STATUS_ON } from "../../lib/openai-fast";
import { isolateEnvVars } from "../../tests/support/env";
import { createFakePi as createSharedFakePi } from "../../tests/support/fake-pi";
import openaiFastExtension, { applyOpenAIFastServiceTier } from "./index";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: FakeContext) => Promise<void> | void;
};

type FakeContext = {
  hasUI: boolean;
  model?: unknown;
  modelRegistry: ReturnType<typeof createFakePi>["modelRegistry"];
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
};

function createFakePi() {
  const builtin = openaiProvider();
  const providers = new Map<string, Provider>([[builtin.id, builtin]]);
  const nativeProviders = new Map<string, Provider>();
  return {
    ...createSharedFakePi<never, CommandDefinition>(),
    providers,
    modelRegistry: {
      getProvider: (id: string) => providers.get(id),
      getRegisteredNativeProvider: (id: string) => nativeProviders.get(id),
      getRegisteredProviderConfig: () => undefined,
    },
    registerProvider(provider: Provider) {
      nativeProviders.set(provider.id, provider);
      providers.set(provider.id, provider);
    },
    unregisterProvider(id: string) {
      nativeProviders.delete(id);
      providers.set(id, builtin);
    },
  };
}

async function startExtension(pi: ReturnType<typeof createFakePi>) {
  openaiFastExtension(pi as never);
  await pi.getEventHandlers("session_start")[0]!({}, createContext(pi).ctx);
}

function createContext(
  pi: ReturnType<typeof createFakePi>,
  model: unknown = { provider: "openai", api: "openai-responses" },
) {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx: FakeContext = {
    hasUI: true,
    model,
    modelRegistry: pi.modelRegistry,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.set(key, value);
      },
    },
  };

  return { ctx, notifications, statuses };
}

describe("openai-fast extension", () => {
  let tempAgentDir: string;
  let request: { payload: Record<string, unknown>; headers: Headers } | undefined;
  const originalFetch = globalThis.fetch;

  isolateEnvVars(["PI_CODING_AGENT_DIR"]);

  beforeEach(() => {
    tempAgentDir = mkdtempSync(join(tmpdir(), "openai-fast-agent-test-"));
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
    request = undefined;
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      request = { payload, headers: new Headers(init?.headers) };
      const event = {
        type: "response.completed",
        response: {
          id: "resp_offline_fast",
          status: "completed",
          output: [],
          service_tier: payload.service_tier ?? "default",
          usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
        },
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempAgentDir, { recursive: true, force: true });
  });

  async function payloadFor(
    pi: ReturnType<typeof createFakePi>,
    method: "stream" | "streamSimple" = "streamSimple",
    samplingParams?: Record<string, unknown>,
  ) {
    const provider = pi.providers.get("openai")!;
    const model = provider.getModels().find((model) => model.id === "gpt-5.5")!;
    const result = await provider[method](model, normalizeContext({ messages: [] }), {
      apiKey: "sk-offline-fixture-only",
      samplingParams,
      headers: { "x-fast-fixture": "preserved" },
      onPayload(payload) {
        return { ...(payload as Record<string, unknown>), user: "caller-hook" };
      },
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(request!.headers.get("x-fast-fixture")).toBe("preserved");
    expect(request!.payload.user).toBe("caller-hook");
    return request!.payload;
  }

  test("registers /openai-fast and preserves the native OpenAI provider", async () => {
    const pi = createFakePi();
    const original = pi.providers.get("openai")!;

    await startExtension(pi);

    expect(pi.getCommand("openai-fast")?.description).toBe(
      "Control OpenAI Responses fast service tier with global settings persistence",
    );
    expect(pi.getCommand("codex-fast")).toBeUndefined();
    const provider = pi.providers.get("openai")!;
    expect(provider).not.toBe(original);
    expect(provider.auth).toBe(original.auth);
    expect(provider.auth.apiKey).toBeDefined();
    expect(provider.auth.oauth).toBeDefined();
    expect(provider.getModels().some((model) => model.id === "gpt-5.5")).toBe(true);
  });

  test.each([
    "stream",
    "streamSimple",
  ] as const)("/openai-fast enables priority for native %s without mutating caller options", async (method) => {
    const pi = createFakePi();
    await startExtension(pi);

    const { ctx, notifications, statuses } = createContext(pi);
    await pi.getCommand("openai-fast")!.handler("", ctx);
    const samplingParams = { top_p: 0.2, service_tier: "default" };
    const payload = await payloadFor(pi, method, samplingParams);

    expect(payload.service_tier).toBe("priority");
    expect(payload.top_p).toBe(0.2);
    expect(samplingParams).toEqual({ top_p: 0.2, service_tier: "default" });
    expect(notifications).toEqual([
      { message: "OpenAI fast mode を有効化しました。", level: "info" },
    ]);
    expect(statuses.get(OPENAI_FAST_STATUS_KEY)).toBe(OPENAI_FAST_STATUS_ON);
  });

  test("/openai-fast off disables service tier injection", async () => {
    const pi = createFakePi();
    await startExtension(pi);

    const { ctx, statuses } = createContext(pi);
    await pi.getCommand("openai-fast")!.handler("on", ctx);
    await pi.getCommand("openai-fast")!.handler("off", ctx);

    expect((await payloadFor(pi)).service_tier).toBeUndefined();
    expect(statuses.get(OPENAI_FAST_STATUS_KEY)).toBeUndefined();
  });

  test("loads fast mode from global settings.json", async () => {
    writeFileSync(
      join(tempAgentDir, "settings.json"),
      JSON.stringify({ "openai-fast": { enabled: true } }),
    );

    const pi = createFakePi();
    await startExtension(pi);

    const { ctx, statuses } = createContext(pi);
    await pi.getEventHandlers("session_start")[0]!({}, ctx);

    expect((await payloadFor(pi)).service_tier).toBe("priority");
    expect(statuses.get(OPENAI_FAST_STATUS_KEY)).toBe(OPENAI_FAST_STATUS_ON);
  });

  test.each([
    true,
    false,
  ])("When only legacy fast settings exist, their enabled=%s value shall be retained without rewriting settings", async (enabled) => {
    const settings = { theme: "dark", "codex-fast": { enabled } };
    writeFileSync(join(tempAgentDir, "settings.json"), JSON.stringify(settings));
    const pi = createFakePi();
    await startExtension(pi);
    const { ctx, statuses } = createContext(pi);
    await pi.getEventHandlers("session_start")[0]!({}, ctx);

    expect((await payloadFor(pi)).service_tier).toBe(enabled ? "priority" : undefined);
    expect(statuses.get(OPENAI_FAST_STATUS_KEY)).toBe(enabled ? OPENAI_FAST_STATUS_ON : undefined);
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual(settings);
  });

  test("When a migrated fast setting is changed, the new setting shall override legacy settings after reload", async () => {
    writeFileSync(
      join(tempAgentDir, "settings.json"),
      JSON.stringify({
        theme: "dark",
        "codex-fast": { enabled: true },
      }),
    );
    const pi = createFakePi();
    await startExtension(pi);
    const { ctx } = createContext(pi);

    await pi.getCommand("openai-fast")!.handler("off", ctx);
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      "codex-fast": { enabled: true },
      "openai-fast": { enabled: false },
    });

    const reloaded = createFakePi();
    await startExtension(reloaded);
    expect((await payloadFor(reloaded)).service_tier).toBeUndefined();
  });

  test.each([
    { provider: "openai-codex", api: "openai-codex-responses" },
    { provider: "custom", api: "openai-responses" },
    { provider: "openai", api: "openai-completions" },
  ])("When fast is enabled, requests outside OpenAI Responses shall remain unchanged: %j", (model) => {
    const payload = { model: "gpt-5.5" };
    expect(applyOpenAIFastServiceTier(payload, model, true)).toBeUndefined();
    expect(payload).toEqual({ model: "gpt-5.5" });
  });

  test("persists fast mode changes to global settings.json", async () => {
    writeFileSync(
      join(tempAgentDir, "settings.json"),
      JSON.stringify({ theme: "dark", "openai-fast": { lastChangedBy: "test" } }),
    );
    const pi = createFakePi();
    await startExtension(pi);

    const { ctx } = createContext(pi);
    await pi.getCommand("openai-fast")!.handler("on", ctx);
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      "openai-fast": { lastChangedBy: "test", enabled: true },
    });

    await pi.getCommand("openai-fast")!.handler("off", ctx);
    expect(JSON.parse(readFileSync(join(tempAgentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
      "openai-fast": { lastChangedBy: "test", enabled: false },
    });
  });

  test("creates global settings.json when persisting fast mode", async () => {
    const pi = createFakePi();
    await startExtension(pi);

    const { ctx } = createContext(pi);
    await pi.getCommand("openai-fast")!.handler("on", ctx);

    const settingsPath = join(tempAgentDir, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      "openai-fast": { enabled: true },
    });
  });

  test("status reports the current setting without changing it", async () => {
    const pi = createFakePi();
    await startExtension(pi);

    const { ctx, notifications } = createContext(pi);
    await pi.getCommand("openai-fast")!.handler("status", ctx);
    expect((await payloadFor(pi)).service_tier).toBeUndefined();

    await pi.getCommand("openai-fast")!.handler("on", ctx);
    await pi.getCommand("openai-fast")!.handler("status", ctx);
    expect((await payloadFor(pi)).service_tier).toBe("priority");
    expect(notifications).toEqual([
      { message: "OpenAI fast mode は無効です。", level: "info" },
      { message: "OpenAI fast mode を有効化しました。", level: "info" },
      { message: "OpenAI fast mode は有効です。", level: "info" },
    ]);
  });

  test.each([
    false,
    true,
  ])("When a session restarts or the extension reloads with a native provider=%s, fast shall not retain an old enabled-state wrapper", async (native) => {
    const pi = createFakePi();
    const original = pi.providers.get("openai")!;
    if (native) pi.registerProvider(original);
    await startExtension(pi);
    const wrapped = pi.providers.get("openai")!;
    const { ctx } = createContext(pi);
    await pi.getCommand("openai-fast")!.handler("on", ctx);
    await pi.getEventHandlers("session_start")[0]!({}, ctx);
    expect(pi.providers.get("openai")).toBe(wrapped);

    await pi.getEventHandlers("session_shutdown")[0]!({}, ctx);
    expect(pi.providers.get("openai")).toBe(original);
    expect((await payloadFor(pi)).service_tier).toBeUndefined();

    const reloaded = {
      ...pi,
      ...createSharedFakePi<never, CommandDefinition>(),
      providers: pi.providers,
      modelRegistry: pi.modelRegistry,
      registerProvider: pi.registerProvider,
      unregisterProvider: pi.unregisterProvider,
    };
    await startExtension(reloaded);
    await reloaded.getCommand("openai-fast")!.handler("off", createContext(reloaded).ctx);
    expect((await payloadFor(reloaded)).service_tier).toBeUndefined();
  });

  test("When another extension replaces OpenAI, shutdown shall not remove its provider", async () => {
    const pi = createFakePi();
    await startExtension(pi);
    const replacement = openaiProvider();
    pi.registerProvider(replacement);
    await pi.getEventHandlers("session_shutdown")[0]!({}, createContext(pi).ctx);
    expect(pi.providers.get("openai")).toBe(replacement);
  });

  test("does not change non-OpenAI models or non-object payloads", () => {
    expect(
      applyOpenAIFastServiceTier(
        { model: "claude-sonnet-4-6" },
        { provider: "anthropic", api: "anthropic-messages" },
        true,
      ),
    ).toBeUndefined();
    expect(
      applyOpenAIFastServiceTier("payload", { provider: "openai", api: "openai-responses" }, true),
    ).toBeUndefined();
    expect(
      applyOpenAIFastServiceTier(
        { model: "gpt-5.5" },
        { provider: "openai", api: "openai-responses" },
        false,
      ),
    ).toBeUndefined();
  });

  test("rejects unknown arguments", async () => {
    const pi = createFakePi();
    await startExtension(pi);

    const { ctx, notifications } = createContext(pi);
    await pi.getCommand("openai-fast")!.handler("maybe", ctx);

    expect(notifications).toEqual([
      { message: "使い方: /openai-fast [on|off|toggle|status]", level: "error" },
    ]);
  });
});
