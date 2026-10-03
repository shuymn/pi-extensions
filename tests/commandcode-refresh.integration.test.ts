import { afterEach, expect, test } from "bun:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import commandcodeExtension, {
  COMMANDCODE_FALLBACK_MODELS,
  COMMANDCODE_MODELS_URL,
  COMMANDCODE_PROVIDER_ID,
} from "../extensions/commandcode-provider";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function createRuntime() {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(COMMANDCODE_PROVIDER_ID, async () => ({
    type: "api_key",
    key: "commandcode-test-only",
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    refreshOnCreate: false,
  });
  commandcodeExtension({
    registerProvider(provider: Provider) {
      runtime.registerNativeProvider(provider);
    },
  } as ExtensionAPI);
  await runtime.refresh({ providers: [COMMANDCODE_PROVIDER_ID], allowNetwork: false });
  return runtime;
}

function response(id: string): Response {
  return Response.json({ data: [{ id, context_length: 100_000 }] });
}

const refreshOptions = { providers: [COMMANDCODE_PROVIDER_ID], allowNetwork: true };

test("Command Code refresh retains fallback or last live catalog and uses stored authentication", async () => {
  let calls = 0;
  let liveResponse = new Response("unavailable", { status: 503 });
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe(COMMANDCODE_MODELS_URL);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    calls++;
    return liveResponse;
  }) as typeof fetch;
  const runtime = await createRuntime();
  const ids = () => runtime.getModels(COMMANDCODE_PROVIDER_ID).map((model) => model.id);
  const fallbackIds = COMMANDCODE_FALLBACK_MODELS.map((model) => model.id);
  expect(calls).toBe(0);
  expect(ids()).toEqual(fallbackIds);

  const failure = await runtime.refresh(refreshOptions);
  expect(failure.errors.get(COMMANDCODE_PROVIDER_ID)?.message).toContain("503");
  expect(ids()).toEqual(fallbackIds);

  liveResponse = response("claude-new-fixture");
  expect((await runtime.refresh(refreshOptions)).errors.size).toBe(0);
  expect(ids()).toEqual(["claude-new-fixture"]);
  const model = runtime.getModel(COMMANDCODE_PROVIDER_ID, "claude-new-fixture")!;
  expect(model.api).toBe("anthropic-messages");
  expect(model.baseUrl).toBe("https://api.commandcode.ai/provider");
  expect((await runtime.getAuth(model))?.auth.apiKey).toBe("commandcode-test-only");
  expect(await runtime.getAvailable(COMMANDCODE_PROVIDER_ID)).toEqual([model]);

  liveResponse = new Response("unavailable", { status: 503 });
  expect((await runtime.refresh(refreshOptions)).errors.has(COMMANDCODE_PROVIDER_ID)).toBe(true);
  expect(ids()).toEqual(["claude-new-fixture"]);
  await runtime.refresh({ ...refreshOptions, allowNetwork: false });
  expect(ids()).toEqual(["claude-new-fixture"]);
  expect(calls).toBe(3);
});

test("Command Code refresh cancellation leaves the catalog unchanged", async () => {
  const runtime = await createRuntime();
  const before = runtime.getModels(COMMANDCODE_PROVIDER_ID);
  const started = Promise.withResolvers<AbortSignal>();
  globalThis.fetch = (async (_url, init) => {
    const signal = init!.signal!;
    started.resolve(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const controller = new AbortController();
  const refreshing = runtime.refresh({ ...refreshOptions, signal: controller.signal });
  const requestSignal = await started.promise;
  controller.abort();
  expect((await refreshing).aborted).toBe(true);
  expect(requestSignal.aborted).toBe(true);
  expect(runtime.getModels(COMMANDCODE_PROVIDER_ID)).toEqual(before);
});

test("a superseded Command Code refresh cannot publish its stale catalog", async () => {
  const runtime = await createRuntime();
  const started = Promise.withResolvers<void>();
  const stale = Promise.withResolvers<Response>();
  let calls = 0;
  globalThis.fetch = (async () => {
    if (++calls === 1) {
      started.resolve();
      return stale.promise;
    }
    return response("gpt-new-fixture");
  }) as typeof fetch;
  const first = runtime.refresh(refreshOptions);
  await started.promise;
  expect((await runtime.refresh(refreshOptions)).errors.size).toBe(0);
  stale.resolve(response("gpt-stale-fixture"));
  await first;
  // Drain the deliberately abort-ignoring fetch and its publication attempt.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(runtime.getModels(COMMANDCODE_PROVIDER_ID).map((model) => model.id)).toEqual([
    "gpt-new-fixture",
  ]);
});
