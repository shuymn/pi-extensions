import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionVirtualModel,
  ModelRegistry,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

import {
  FALLBACK_ROUTER_ID,
  FALLBACK_ROUTER_PROVIDER,
  getFallbackRouterCandidates,
} from "../../lib/fallback-router";
import fallbackModelExtension, { FALLBACK_MODEL_FLAG, parseFallbackModelList } from "./index";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
function harness(value?: string) {
  const flags: Array<{ name: string; definition: unknown }> = [];
  const events = new Map<string, Handler>();
  const definitions: ExtensionVirtualModel[] = [];
  const pi = {
    registerFlag(name: string, definition: unknown) {
      flags.push({ name, definition });
    },
    getFlag() {
      return value;
    },
    registerVirtualModel(definition: ExtensionVirtualModel) {
      definitions.push(definition);
    },
    on(name: string, handler: Handler) {
      events.set(name, handler);
    },
    // Selection/message methods intentionally absent: any accidental use fails the test.
  };
  fallbackModelExtension(pi as unknown as ExtensionAPI);
  return { flags, events, definitions };
}
function context(id: string) {
  const physical = { provider: "test", id, api: "openai-completions" } as Model<Api>;
  const registry = {
    find(provider: string, model: string) {
      return provider === "test" && model === id ? physical : undefined;
    },
  } as ModelRegistry;
  return { physical, registry, ctx: { modelRegistry: registry } as ExtensionContext };
}
function request(): ModelRouteRequest {
  return {
    model: { provider: "fallback", id: "auto", api: "pi-virtual" } as Model<Api>,
    reason: "user",
    thinkingLevel: "medium",
    messages: [],
  };
}

test("parses explicit ordered candidates including the primary and thinking suffixes", () => {
  expect(parseFallbackModelList("test/primary, test/backup:HIGH")).toEqual([
    { provider: "test", model: "primary" },
    { provider: "test", model: "backup", thinkingLevel: "high" },
  ]);
  expect(parseFallbackModelList(" ,invalid,/missing-provider,test/,test/model:unknown")).toEqual([
    { provider: "test", model: "model:unknown" },
  ]);
});

test("registers a selectable virtual model and only a metadata session hook, without automatic selection", () => {
  const pi = harness("test/a,test/b");
  expect(pi.flags).toEqual([
    {
      name: FALLBACK_MODEL_FLAG,
      definition: {
        description:
          'Ordered physical candidates including the primary model for fallback/auto, e.g. "provider/primary,provider/backup:high". Select fallback/auto explicitly.',
        type: "string",
      },
    },
  ]);
  expect(pi.definitions).toHaveLength(1);
  expect(pi.definitions[0]).toMatchObject({
    provider: FALLBACK_ROUTER_PROVIDER,
    id: FALLBACK_ROUTER_ID,
  });
  expect([...pi.events.keys()]).toEqual(["session_start"]);
  const { ctx, registry } = context("a");
  expect(pi.events.get("session_start")!({} as never, ctx)).toBeUndefined();
  expect(getFallbackRouterCandidates(registry)).toEqual([
    { provider: "test", model: "a" },
    { provider: "test", model: "b" },
  ]);
});

test("parent wrapper looks up each request's context registry, not a captured session", async () => {
  const pi = harness("test/a,test/b:high");
  const first = context("a");
  const second = context("b");
  pi.events.get("session_start")!({} as never, first.ctx);
  const route = pi.definitions[0]!.route;
  expect((await route(request(), first.ctx)).model).toBe(first.physical);
  const other = await route(request(), second.ctx);
  expect(other.model).toBe(second.physical);
  expect(other.thinkingLevel).toBe("high");
});

test("unconfigured router is selectable but fails explicitly when dispatched", () => {
  const pi = harness();
  const { ctx, registry } = context("a");
  pi.events.get("session_start")!({} as never, ctx);
  expect(getFallbackRouterCandidates(registry)).toEqual([]);
  expect(() => pi.definitions[0]!.route(request(), ctx)).toThrow("requires --fallback-model");
});
