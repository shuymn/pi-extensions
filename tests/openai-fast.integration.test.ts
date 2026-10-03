import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import openaiFastExtension from "../extensions/openai-fast";
import { withTimeout } from "./support/async";
import { isolateEnvVars } from "./support/env";

isolateEnvVars(["PI_CODING_AGENT_DIR"]);
const originalFetch = globalThis.fetch;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "openai-fast-pi-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ "openai-fast": { enabled: true } }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

test.each([
  {
    initialProvider: "openai",
    selectedProvider: "compatible",
    authType: "api_key",
    expectedTier: "priority",
  },
  {
    initialProvider: "compatible",
    selectedProvider: "openai",
    authType: "api_key",
    expectedTier: undefined,
  },
  {
    initialProvider: "openai",
    selectedProvider: "compatible",
    authType: "oauth",
    expectedTier: "priority",
  },
])("WHEN selection changes during authentication, fast SHALL follow the dispatched provider: %j", async ({
  initialProvider,
  selectedProvider,
  authType,
  expectedTier,
}) => {
  const credentials = new InMemoryCredentialStore();
  for (const id of ["openai", "compatible"]) {
    await credentials.modify(id, async () =>
      id === "openai" && authType === "oauth"
        ? {
            type: "oauth",
            access: "offline-oauth-fixture-only",
            refresh: "offline-refresh-fixture-only",
            expires: Date.now() + 60 * 60 * 1000,
            clientId: "offline-fixture-client",
            scopes: ["chatgpt.tokens.use.direct"],
          }
        : { type: "api_key", key: "sk-offline-fixture-only" },
    );
  }
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const authStarted = Promise.withResolvers<void>();
  const releaseAuth = Promise.withResolvers<void>();
  let delayRequests = false;
  const heldAuth = (provider: Provider): Provider => {
    const apiKey = provider.auth.apiKey!;
    const oauth = provider.auth.oauth!;
    async function hold() {
      if (delayRequests && provider.id === initialProvider) {
        authStarted.resolve();
        await releaseAuth.promise;
      }
    }
    return {
      ...provider,
      auth: {
        ...provider.auth,
        apiKey: {
          ...apiKey,
          async resolve(context) {
            await hold();
            return apiKey.resolve(context);
          },
        },
        oauth: {
          ...oauth,
          async toAuth(credential) {
            await hold();
            return oauth.toAuth(credential);
          },
        },
      },
    };
  };
  const openai = openaiProvider();
  const physical = openai.getModels().find((model) => model.id === "gpt-5.5")!;
  const compatible = { ...physical, provider: "compatible" };
  runtime.registerNativeProvider(heldAuth(openai));
  runtime.registerNativeProvider(
    heldAuth({
      ...openai,
      id: "compatible",
      getModels: () => [compatible],
      getAllModels: () => [compatible],
    }),
  );
  await runtime.refresh({ allowNetwork: false });

  const requests: Array<{ payload: Record<string, unknown>; authorization: string | null }> = [];
  globalThis.fetch = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    requests.push({ payload, authorization: new Headers(init?.headers).get("authorization") });
    const response = {
      type: "response.completed",
      response: {
        id: "resp_offline_fast",
        status: "completed",
        output: [],
        service_tier: payload.service_tier ?? "default",
        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
      },
    };
    return new Response(`data: ${JSON.stringify(response)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [openaiFastExtension],
  });
  let session: AgentSession | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      modelRuntime: runtime,
      model: runtime.getModel(initialProvider, physical.id)!,
      thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(dir),
      resourceLoader: loader,
      tools: [],
    }));
    await session.bindExtensions({ mode: "print" });
    delayRequests = true;
    const prompt = session.prompt("Offline fixture.");
    await withTimeout(authStarted.promise, "request authentication did not start");
    await session.setModel(runtime.getModel(selectedProvider, physical.id)!);
    expect(session.model?.provider).toBe(selectedProvider);
    releaseAuth.resolve();
    await withTimeout(prompt, "offline request did not complete");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.payload.service_tier).toBe(expectedTier);
    expect(requests[0]!.authorization).toBe(
      `Bearer ${authType === "oauth" ? "offline-oauth-fixture-only" : "sk-offline-fixture-only"}`,
    );
    const assistant = session.messages.find((message) => message.role === "assistant");
    expect(assistant?.provider).toBe(initialProvider);
    expect(assistant?.stopReason).toBe("stop");
  } finally {
    releaseAuth.resolve();
    session?.dispose();
  }
});

test.each([
  true,
  false,
])("When fast is enabled=%s, loading the extension shall preserve cached OpenAI models and subsequent catalog refreshes", async (enabled) => {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ "openai-fast": { enabled } }));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({
    type: "api_key",
    key: "sk-offline-fixture-only",
  }));
  const bundled = openaiProvider()
    .getModels()
    .find((model) => model.id === "gpt-5.5")!;
  const cached = {
    ...bundled,
    id: "gpt-5-catalog-fixture",
    name: "New cached OpenAI model",
    contextWindow: bundled.contextWindow + 10_000,
  };
  const updated = {
    ...bundled,
    contextWindow: bundled.contextWindow + 20_000,
    cost: { ...bundled.cost, input: bundled.cost.input + 1 },
    compat: { ...bundled.compat, supportsDeveloperRole: false },
  };
  const modelsStore = new InMemoryModelsStore();
  await modelsStore.write("openai", {
    models: [cached, updated],
    lastModified: Number.MAX_SAFE_INTEGER,
  });
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const original = runtime.getProvider("openai")!;
  expect(runtime.getModel("openai", cached.id)).toMatchObject(cached);
  expect(runtime.getModel("openai", bundled.id)).toMatchObject(updated);

  const payloads: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    // Any accidental catalog/network fetch has no request body and fails here.
    const payload = JSON.parse(String(init?.body));
    payloads.push(payload);
    const event = {
      type: "response.completed",
      response: {
        id: "resp_cached_fast",
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

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [openaiFastExtension],
  });
  let session: AgentSession | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      modelRuntime: runtime,
      model: runtime.getModel("openai", cached.id)!,
      thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(dir),
      resourceLoader: loader,
      tools: [],
    }));
    await session.bindExtensions({ mode: "print" });
    const wrapped = runtime.getProvider("openai")!;
    expect(wrapped).not.toBe(original);
    expect(wrapped.getModels).toBe(original.getModels);
    expect(wrapped.getAllModels).toBe(original.getAllModels);
    expect(wrapped.refreshModels).toBe(original.refreshModels);
    expect(runtime.getModel("openai", cached.id)).toMatchObject(cached);
    expect(runtime.getModel("openai", bundled.id)).toMatchObject(updated);
    expect(runtime.getAvailableSnapshot().find((model) => model.id === cached.id)).toMatchObject(
      cached,
    );
    expect(runtime.getAllModels("openai").find((model) => model.id === cached.id)).toMatchObject(
      cached,
    );

    const refreshed = { ...cached, contextWindow: cached.contextWindow + 30_000 };
    await modelsStore.write("openai", {
      models: [refreshed, updated],
      lastModified: Number.MAX_SAFE_INTEGER,
    });
    const refresh = await runtime.refresh({ allowNetwork: false, providers: ["openai"] });
    expect(refresh.aborted).toBe(false);
    expect(refresh.errors.size).toBe(0);
    expect(runtime.getModel("openai", cached.id)).toMatchObject(refreshed);
    expect(runtime.getModel("openai", bundled.id)).toMatchObject(updated);
    expect(runtime.getAvailableSnapshot().find((model) => model.id === cached.id)).toMatchObject(
      refreshed,
    );
    expect(runtime.getAllModels("openai").find((model) => model.id === cached.id)).toMatchObject(
      refreshed,
    );

    await withTimeout(
      session.prompt("Offline catalog fixture."),
      "cached model request did not finish",
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.model).toBe(cached.id);
    expect(payloads[0]!.service_tier).toBe(enabled ? "priority" : undefined);
    expect(session.messages.find((message) => message.role === "assistant")?.stopReason).toBe(
      "stop",
    );
  } finally {
    session?.dispose();
  }
});
