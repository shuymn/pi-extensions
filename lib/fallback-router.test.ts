import { describe, expect, test } from "bun:test";
import {
  type Api,
  type AssistantMessage,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  type ModelRouteRequest,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import {
  configureFallbackRouter,
  createFallbackVirtualModel,
  FALLBACK_ROUTER_ID,
  FALLBACK_ROUTER_PROVIDER,
  getFallbackRouterCandidates,
} from "./fallback-router";
import type { ModelSpec } from "./model-spec";

function model(id: string, api = "openai-completions"): Model<Api> {
  return {
    provider: "test",
    id,
    api,
    name: id,
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
const a = model("a");
const b = model("b");
const c = model("c");
const config: ModelSpec[] = [
  { provider: "test", model: "a", thinkingLevel: "low" },
  { provider: "test", model: "b" },
  { provider: "test", model: "c", thinkingLevel: "high" },
];
function registry(models = [a, b, c]): ModelRegistry {
  return {
    find(provider: string, id: string) {
      return models.find((entry) => entry.provider === provider && entry.id === id);
    },
  } as ModelRegistry;
}
function request(overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest {
  return {
    model: model("auto", "pi-virtual"),
    reason: "user",
    thinkingLevel: "medium",
    messages: [],
    ...overrides,
  };
}
function failed(
  physical: Model<Api>,
  errorMessage = "503 original detail",
): NonNullable<ModelRouteRequest["failed"]> {
  return {
    model: physical,
    thinkingLevel: "low",
    message: {
      role: "assistant",
      provider: physical.provider,
      model: physical.id,
      api: physical.api,
      stopReason: "error",
      errorMessage,
      content: [],
      timestamp: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    } satisfies AssistantMessage,
  };
}

describe("fallback router", () => {
  test("routes the explicit primary, native retry sequence, sticky continuation, and new user reset", async () => {
    const router = createFallbackVirtualModel(registry(), config);
    const primary = await router.route(request());
    expect(primary).toEqual({
      model: a,
      thinkingLevel: "low",
      state: { attempted: ["test/a"], current: "test/a" },
    });
    const retry = await router.route(
      request({ reason: "retry", state: primary.state, failed: failed(a) }),
    );
    expect(retry.model).toBe(b);
    expect(retry.thinkingLevel).toBe("medium");
    const sticky = await router.route(
      request({
        reason: "continuation",
        state: retry.state,
        previous: { model: b, thinkingLevel: "off" },
      }),
    );
    expect(sticky.model).toBe(b);
    expect(sticky.thinkingLevel).toBe("off");
    expect(sticky.state).toBe(retry.state);
    const last = await router.route(
      request({ reason: "retry", state: sticky.state, failed: failed(b) }),
    );
    expect(last.model).toBe(c);
    expect(last.thinkingLevel).toBe("high");
    expect((await router.route(request({ state: last.state, previous: { model: c } }))).model).toBe(
      a,
    );
  });

  test("direct requests ignore branch state and do not return state", async () => {
    const router = createFallbackVirtualModel(registry(), config);
    const first = await router.route(request());
    const next = await router.route(
      request({ reason: "retry", state: first.state, failed: failed(a) }),
    );
    expect(
      await router.route(request({ reason: "direct", state: next.state, previous: { model: b } })),
    ).toEqual({ model: a, thinkingLevel: "low" });
    expect((await router.route(request({ reason: "continuation", state: next.state }))).model).toBe(
      b,
    );
  });

  test("forked and independent branches never share attempts or mutate input state", async () => {
    const router = createFallbackVirtualModel(registry(), config);
    const first = await router.route(request());
    const snapshot = JSON.stringify(first.state);
    const next = await router.route(
      request({ reason: "retry", state: first.state, failed: failed(a) }),
    );
    await router.route(request({ reason: "retry", state: next.state, failed: failed(b) }));
    expect(
      (
        await router.route(
          request({ reason: "retry", state: JSON.parse(snapshot), failed: failed(a) }),
        )
      ).model,
    ).toBe(b);
    expect(JSON.stringify(first.state)).toBe(snapshot);
    expect((await router.route(request())).model).toBe(a);
  });

  test("native retry reason alone permits switching; no error classifier or error rewriting", async () => {
    const router = createFallbackVirtualModel(registry(), config);
    const first = await router.route(request());
    const failure = failed(a, "401 opaque native retry");
    const before = structuredClone(failure.message);
    expect(
      (await router.route(request({ reason: "retry", state: first.state, failed: failure }))).model,
    ).toBe(b);
    expect(failure.message).toEqual(before);
    expect(
      (await router.route(request({ reason: "continuation", state: first.state, failed: failure })))
        .model,
    ).toBe(a);
  });

  test("skips absent and duplicate candidates, leaving exhaustion to native physical retries", async () => {
    const router = createFallbackVirtualModel(registry([a, b]), [
      { provider: "test", model: "missing" },
      config[0]!,
      { ...config[0]!, thinkingLevel: "high" },
      config[1]!,
    ]);
    const first = await router.route(request());
    const next = await router.route(
      request({ reason: "retry", state: first.state, failed: failed(a) }),
    );
    expect(next.model).toBe(b);
    const failure = failed(b, "429 original provider text");
    const exhausted = await router.route(
      request({ reason: "retry", state: next.state, failed: failure }),
    );
    expect(exhausted.model).toBe(b);
    expect(exhausted.state).toBe(next.state);
    expect(failure.message.errorMessage).toBe("429 original provider text");
  });

  test("fails explicitly for empty, entirely absent, or virtual candidates", async () => {
    expect(() => createFallbackVirtualModel(registry(), []).route(request())).toThrow(
      "requires --fallback-model",
    );
    expect(() => createFallbackVirtualModel(registry([]), config).route(request())).toThrow(
      "No unattempted physical",
    );
    expect(() =>
      createFallbackVirtualModel(registry([model("a", "pi-virtual")]), config).route(request()),
    ).toThrow("must be a physical model");
  });

  test("missing successful sticky candidates recover to unattempted configured backups", async () => {
    const models = [a, b, c];
    const router = createFallbackVirtualModel(registry(models), config);
    const primary = await router.route(request());
    const sticky = await router.route(
      request({ reason: "retry", state: primary.state, failed: failed(a) }),
    );
    const before = structuredClone(sticky.state);
    models.splice(models.indexOf(b), 1);
    const recovered = await router.route(
      request({
        reason: "continuation",
        state: sticky.state,
        previous: { model: b, thinkingLevel: "off" },
      }),
    );
    expect(recovered).toEqual({
      model: c,
      thinkingLevel: "high",
      state: { attempted: ["test/a", "test/b", "test/c"], current: "test/c" },
    });
    expect(sticky.state).toEqual(before);
    const continued = await router.route(
      request({
        reason: "continuation",
        state: recovered.state,
        previous: { model: c, thinkingLevel: "minimal" },
      }),
    );
    expect(continued.model).toBe(c);
    expect(continued.thinkingLevel).toBe("minimal");
    expect(continued.state).toBe(recovered.state);
  });

  test("missing state-only sticky selection recovers without mutating a fork's state", async () => {
    const models = [a, b, c];
    const router = createFallbackVirtualModel(registry(models), config);
    const first = await router.route(request());
    const state = Object.freeze({
      ...(first.state as { attempted: string[]; current: string }),
      attempted: Object.freeze(["test/a"]),
    });
    models.shift();
    const recovered = await router.route(request({ reason: "continuation", state }));
    expect(recovered).toEqual({
      model: b,
      thinkingLevel: "medium",
      state: { attempted: ["test/a", "test/b"], current: "test/b" },
    });
    expect(state).toEqual({ attempted: ["test/a"], current: "test/a" });
    models.unshift(a);
    expect(await router.route(request({ reason: "continuation", state }))).toEqual({
      model: a,
      thinkingLevel: "low",
      state,
    });
    expect(
      (await router.route(request({ reason: "continuation", state: recovered.state }))).model,
    ).toBe(b);
  });

  test("continuation can reuse recovered attempted candidates without resetting retry history", async () => {
    const models = [a, b];
    const router = createFallbackVirtualModel(registry(models), config.slice(0, 2));
    const first = await router.route(request());
    const sticky = await router.route(
      request({ reason: "retry", state: first.state, failed: failed(a) }),
    );
    models.splice(0, models.length);
    // The primary returns to the catalog, while the successful backup disappears.
    models.push(a);
    const recovered = await router.route(
      request({
        reason: "continuation",
        state: sticky.state,
        previous: { model: b, thinkingLevel: "off" },
      }),
    );
    expect(recovered).toEqual({
      model: a,
      thinkingLevel: "low",
      state: { attempted: ["test/a", "test/b"], current: "test/a" },
    });
    expect(sticky.state).toEqual({ attempted: ["test/a", "test/b"], current: "test/b" });
    models.push(b);
    const failure = failed(a, "503 still failing after continuation");
    const exhausted = await router.route(
      request({ reason: "retry", state: recovered.state, failed: failure }),
    );
    expect(exhausted.model).toBe(a);
    expect(exhausted.state).toBe(recovered.state);
    expect(failure.message.errorMessage).toBe("503 still failing after continuation");
    expect(() => router.route(request({ reason: "retry", state: recovered.state }))).toThrow(
      "No unattempted physical",
    );
  });

  test("state-only continuation can reuse configured candidates after exhaustion", async () => {
    const state = Object.freeze({
      attempted: Object.freeze(["test/a", "test/b", "test/c"]),
      current: "test/c",
    });
    const router = createFallbackVirtualModel(registry([b]), config);
    const result = await router.route(request({ reason: "continuation", state }));
    expect(result).toEqual({
      model: b,
      thinkingLevel: "medium",
      state: { attempted: ["test/a", "test/b", "test/c"], current: "test/b" },
    });
    expect(state.current).toBe("test/c");
    expect((await router.route(request({ reason: "direct", state: result.state }))).model).toBe(b);
    expect((await router.route(request({ reason: "user", state: result.state }))).state).toEqual({
      attempted: ["test/b"],
      current: "test/b",
    });
  });

  test("missing sticky models with no configured catalog candidate fail instead of inventing models", async () => {
    const unconfigured = model("unconfigured");
    const models = [a, unconfigured];
    const router = createFallbackVirtualModel(registry(models), config);
    const first = await router.route(request());
    models.shift();
    for (const previous of [{ model: a }, undefined]) {
      expect(() =>
        router.route(request({ reason: "continuation", state: first.state, previous })),
      ).toThrow("No unattempted physical");
    }
    expect(first.state).toEqual({ attempted: ["test/a"], current: "test/a" });
  });

  test("cross-provider recovery requires explicit candidates, not matching model ids", async () => {
    const otherA = { ...a, provider: "other" };
    const otherB = { ...b, provider: "other" };
    const state = { attempted: ["test/a"], current: "test/a" };
    const unconfigured = createFallbackVirtualModel(registry([otherA, otherB]), config);
    expect(() =>
      unconfigured.route(request({ reason: "continuation", state, previous: { model: a } })),
    ).toThrow("No unattempted physical");
    const optedIn = createFallbackVirtualModel(registry([otherA, otherB]), [
      ...config,
      { provider: "other", model: "b", thinkingLevel: "high" },
    ]);
    expect(
      await optedIn.route(request({ reason: "continuation", state, previous: { model: a } })),
    ).toEqual({
      model: otherB,
      thinkingLevel: "high",
      state: { attempted: ["test/a", "other/b"], current: "other/b" },
    });
  });

  test("native retry exhaustion cannot route to an unconfigured or disappeared failed model", async () => {
    const state = { attempted: ["test/a"], current: "test/a" };
    const router = createFallbackVirtualModel(registry([a, b]), config.slice(0, 1));
    expect(() => router.route(request({ reason: "retry", state, failed: failed(b) }))).toThrow(
      "No unattempted physical",
    );
    const unavailable = createFallbackVirtualModel(registry([b]), config.slice(0, 1));
    expect(() => unavailable.route(request({ reason: "retry", state, failed: failed(a) }))).toThrow(
      "No unattempted physical",
    );
  });

  test("native routing retries without a failed message advance only to unattempted candidates", async () => {
    const router = createFallbackVirtualModel(registry(), config);
    const first = await router.route(request());
    const next = await router.route(
      request({ reason: "retry", state: first.state, failed: failed(a) }),
    );
    const last = await router.route(
      request({ reason: "retry", state: next.state, previous: { model: a } }),
    );
    expect(last.model).toBe(c);
    expect(() => router.route(request({ reason: "retry", state: last.state }))).toThrow(
      "No unattempted physical",
    );
  });

  test("metadata snapshots and factory configuration cannot be mutated by the caller", async () => {
    const parent = registry();
    const candidates = [{ provider: "test", model: "a" }];
    configureFallbackRouter(parent, candidates);
    const router = createFallbackVirtualModel(parent, candidates);
    candidates[0]!.model = "b";
    candidates.push({ provider: "test", model: "c" });
    const stored = getFallbackRouterCandidates(parent)!;
    expect(stored).toEqual([{ provider: "test", model: "a" }]);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored[0])).toBe(true);
    expect(getFallbackRouterCandidates(registry())).toBeUndefined();
    expect((await router.route(request())).model).toBe(a);
  });

  test("fresh child registration resolves through the child public registry, offline", async () => {
    const options = {
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    };
    const parent = await ModelRuntime.create(options);
    const child = await ModelRuntime.create({
      ...options,
      credentials: new InMemoryCredentialStore(),
    });
    const parentRegistry = new ModelRegistry(parent);
    const physical = parent.getModels("anthropic")[0]!;
    await child.setRuntimeApiKey(physical.provider, "offline-test-key");
    const candidates = [{ provider: physical.provider, model: physical.id }];
    configureFallbackRouter(parentRegistry, candidates);
    const childRegistry = new ModelRegistry(child);
    child.registerVirtualModel(
      createFallbackVirtualModel(childRegistry, getFallbackRouterCandidates(parentRegistry)!),
    );
    const selected = child.getModel(FALLBACK_ROUTER_PROVIDER, FALLBACK_ROUTER_ID)!;
    const result = await child.resolveModel(selected, [], { reason: "user", thinkingLevel: "off" });
    expect(result.model).toBe(childRegistry.find(physical.provider, physical.id)!);
    expect(result.model.api).not.toBe("pi-virtual");
    expect(result.state).toEqual({
      attempted: [`${physical.provider}/${physical.id}`],
      current: `${physical.provider}/${physical.id}`,
    });
  });
});
