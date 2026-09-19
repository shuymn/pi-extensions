import { describe, expect, test } from "bun:test";
import {
  createModels,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./index";

function registeredProvider(): Provider {
  let provider: Provider | undefined;
  extension({
    registerProvider(value: Provider) {
      provider = value;
    },
  } as ExtensionAPI);
  if (!provider) throw new Error("Provider was not registered");
  return provider;
}

describe("abliteration-provider", () => {
  test("makes models available after Pi login, persists the key, and supports logout", async () => {
    const credentials = new InMemoryCredentialStore();
    const registry = createModels({
      credentials,
      authContext: {
        async env() {
          throw new Error("Environment variables must not be used");
        },
        async fileExists() {
          return false;
        },
      },
    });
    registry.setProvider(registeredProvider());
    expect(await registry.getAvailable("abliteration")).toEqual([]);

    await registry.login("abliteration", "api_key", {
      async prompt(prompt) {
        expect(prompt.type).toBe("secret");
        return "  ak_test-key  ";
      },
      notify() {},
    });

    expect(await credentials.read("abliteration")).toEqual({
      type: "api_key",
      key: "ak_test-key",
    });
    expect((await registry.getAuth("abliteration"))?.auth.apiKey).toBe("ak_test-key");
    expect(await registry.getAvailable("abliteration")).toHaveLength(3);
    await registry.logout("abliteration");
    expect(await registry.getAvailable("abliteration")).toEqual([]);
  });

  test("does not save blank or cancelled input", async () => {
    const credentials = new InMemoryCredentialStore();
    const registry = createModels({ credentials });
    registry.setProvider(registeredProvider());
    for (const prompt of [
      async () => "  ",
      async () => {
        throw new Error("cancelled");
      },
    ]) {
      await expect(
        registry.login("abliteration", "api_key", { prompt, notify() {} }),
      ).rejects.toThrow();
      expect(await credentials.read("abliteration")).toBeUndefined();
    }
  });

  test("registers the documented capabilities, limits, rates, and session affinity", () => {
    const provider = registeredProvider();
    expect(provider.id).toBe("abliteration");
    const models = provider.getModels();
    expect(models.map((model) => model.id)).toEqual([
      "abliterated-model-large-v2",
      "abliterated-model",
      "abliterated-model-large",
    ]);
    for (const model of models) {
      const base = model.id === "abliterated-model";
      expect(model.api).toBe("openai-completions");
      expect(model.baseUrl).toBe("https://api.abliteration.ai/v1");
      expect(model.input).toEqual(base ? ["text", "image"] : ["text"]);
      expect(model.contextWindow).toBe(base ? 262_144 : 1_000_000);
      expect(model.maxTokens).toBe(base ? 262_134 : 999_990);
      expect(model.cost).toEqual(
        base
          ? { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 }
          : { input: 3, output: 5, cacheRead: 0.3, cacheWrite: 3 },
      );
      expect(model.compat).toMatchObject({
        sendSessionAffinityHeaders: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      });
    }
    expect(models.map(getSupportedThinkingLevels)).toEqual([
      ["low", "high", "max"],
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      ["off", "high", "max"],
    ]);
  });
});
