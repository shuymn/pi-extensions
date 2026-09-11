import { expect, test } from "bun:test";
import { createProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
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
