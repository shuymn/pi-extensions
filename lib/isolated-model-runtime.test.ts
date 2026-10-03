import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  createProvider,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Provider,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configureFallbackRouter, createFallbackVirtualModel } from "./fallback-router";
import { createIsolatedModelRuntime } from "./isolated-model-runtime";

test("isolated runtimes inherit custom providers and resolve current parent auth", async () => {
  const parent = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  parent.registerNativeProvider(
    createProvider({
      id: "test-isolated",
      name: "Test isolated",
      baseUrl: "https://example.invalid/v1",
      auth: {
        apiKey: {
          name: "Test key",
          resolve: async ({ credential }) =>
            credential?.key
              ? {
                  auth: { apiKey: credential.key, headers: { "x-parent": "yes" } },
                  source: "test",
                }
              : undefined,
        },
      },
      models: [
        {
          id: "custom",
          name: "Custom",
          api: "openai-completions",
          provider: "test-isolated",
          baseUrl: "https://example.invalid/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  await parent.setRuntimeApiKey("test-isolated", "first-key");
  const child = await createIsolatedModelRuntime(new ModelRegistry(parent));
  expect(child.getModel("test-isolated", "custom")).toEqual(
    parent.getModel("test-isolated", "custom"),
  );
  expect((await child.getAuth("test-isolated"))?.auth).toMatchObject({
    apiKey: "first-key",
    headers: { "x-parent": "yes" },
  });
  await parent.setRuntimeApiKey("test-isolated", "refreshed-key");
  expect((await child.getAuth("test-isolated"))?.auth.apiKey).toBe("refreshed-key");
});

test.each([
  "models",
  "modelOverrides",
])("WHEN %s supplies per-model headers, isolated dispatch SHALL preserve them and caller overrides", async (source) => {
  const dir = mkdtempSync(join(tmpdir(), "isolated-headers-"));
  try {
    const modelId = "claude-sonnet-4-5";
    const headers = { "x-required": "tenant-model", "x-scope": "model" };
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          anthropic: {
            headers: { "x-scope": "provider" },
            ...(source === "models"
              ? { models: [{ id: modelId, headers }] }
              : { modelOverrides: { [modelId]: { headers } } }),
          },
        },
      }),
    );
    const parent = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath,
      refreshOnCreate: false,
    });
    expect(parent.getError()).toBeUndefined();
    await parent.setRuntimeApiKey("anthropic", "offline-key");
    const requests: Array<ProviderHeaders | undefined> = [];
    const stream: Provider["streamSimple"] = (model, _context, options) => {
      requests.push(options?.headers);
      const events = createAssistantMessageEventStream();
      events.push({
        type: "done",
        reason: "stop",
        message: {
          ...fauxAssistantMessage("Offline result"),
          api: model.api,
          provider: model.provider,
          model: model.id,
        },
      });
      events.end();
      return events;
    };
    parent.getProvider("anthropic")!.streamSimple = stream;
    const registry = new ModelRegistry(parent);
    const physical = registry.find("anthropic", modelId)!;
    configureFallbackRouter(registry, [{ provider: physical.provider, model: physical.id }]);
    const child = await createIsolatedModelRuntime(registry);
    expect((await parent.completeSimple(physical, { messages: [] })).stopReason).toBe("stop");
    expect((await child.completeSimple(physical, { messages: [] })).stopReason).toBe("stop");
    expect(
      (await child.completeSimple(child.getModel("fallback", "auto")!, { messages: [] }))
        .stopReason,
    ).toBe("stop");
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(request).toMatchObject(headers);
    expect((await child.getAuth(physical))?.auth.headers).toMatchObject(headers);
    expect(
      (
        await child.completeSimple(
          physical,
          { messages: [] },
          {
            headers: { "x-scope": "caller" },
            transformHeaders(request) {
              expect(request).toMatchObject({
                "x-required": "tenant-model",
                "x-scope": "caller",
              });
              return { ...request, "x-transform": "kept" };
            },
          },
        )
      ).stopReason,
    ).toBe("stop");
    expect(requests.at(-1)).toMatchObject({
      "x-required": "tenant-model",
      "x-scope": "caller",
      "x-transform": "kept",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owned router is re-created locally, with a settled auth snapshot and no parent closure", async () => {
  const parent = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  await parent.setRuntimeApiKey("anthropic", "test-only");
  const physical = parent.getModels("anthropic")[0]!;
  const registry = new ModelRegistry(parent);
  const candidates = [{ provider: physical.provider, model: physical.id }];
  configureFallbackRouter(registry, candidates);
  const parentRoute = mock(() => {
    throw new Error("Parent route must never execute");
  });
  parent.registerVirtualModel({
    ...createFallbackVirtualModel(registry, candidates),
    route: parentRoute,
  });
  const child = await createIsolatedModelRuntime(registry);
  const virtual = child.getModel("fallback", "auto")!;
  expect(child.hasConfiguredAuth(physical.provider)).toBe(true);
  const route = await child.resolveModel(virtual, [], { reason: "user", thinkingLevel: "high" });
  expect(route.model).toEqual(physical);
  expect(route.state).toMatchObject({ attempted: [`${physical.provider}/${physical.id}`] });
  const direct = await child.resolveModel(virtual, [], { reason: "direct", thinkingLevel: "high" });
  expect(direct.state).toBeUndefined();
  expect(parentRoute).not.toHaveBeenCalled();
});

test.each([
  "test-router",
  "anthropic",
])("isolated virtual selections fail explicitly without replacing the model (%s)", async (provider) => {
  const parent = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const physical = parent.getModels("anthropic")[0];
  if (!physical) throw new Error("Expected a built-in physical model");
  const route = mock(() => ({ model: physical, thinkingLevel: "off" as const }));
  parent.registerVirtualModel({
    provider,
    id: "test-auto",
    name: "Test auto",
    thinkingLevels: ["low", "high"],
    contextWindow: 8192,
    maxTokens: 1024,
    input: ["text"],
    route,
  });
  const selected = parent.getModel(provider, "test-auto");
  if (!selected) throw new Error("Expected a registered virtual model");
  const child = await createIsolatedModelRuntime(new ModelRegistry(parent));
  expect(child.getModel(provider, "test-auto")).toEqual(selected);
  expect(child.getModel(physical.provider, physical.id)).toEqual(physical);
  expect(child.getPhysicalModel(physical.provider, physical.id)).toEqual(physical);

  const error = `Virtual model ${provider}/test-auto is unsupported in isolated sessions`;
  await expect(
    child.resolveModel(selected, [], { reason: "user", thinkingLevel: "high" }),
  ).rejects.toThrow(error);
  const response = await child.completeSimple(selected, { messages: [] });
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain(error);
  expect(response.errorMessage).toContain("Select a physical model explicitly");
  expect(route).not.toHaveBeenCalled();
  expect(parent.getModel(provider, "test-auto")).toEqual(selected);
});
