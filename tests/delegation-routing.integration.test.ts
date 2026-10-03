import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type Model,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fallbackModelExtension from "../extensions/fallback-model";
import subagentsExtension from "../extensions/subagents";
import { type DelegatedSessionOptions, runDelegatedSession } from "../lib/delegated-session";
import { configureFallbackRouter, createFallbackVirtualModel } from "../lib/fallback-router";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Step = (model: Model<string>, context: TranscriptContext) => Partial<AssistantMessage>;
async function fixture(step: Step) {
  const cwd = mkdtempSync(join(tmpdir(), "delegation-routing-"));
  dirs.push(cwd);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    refreshOnCreate: false,
  });
  const template = runtime.getModels("anthropic")[0]!;
  const models = ["primary", "secondary", "third"].map((id) => ({
    ...template,
    provider: "delegated-test",
    id,
    name: id,
    api: "offline-test",
    baseUrl: "https://example.invalid",
    contextWindow: 100_000,
  }));
  const calls: Array<{ model: string; context: TranscriptContext; apiKey?: string }> = [];
  const stream: Provider["streamSimple"] = (model, context, options) => {
    calls.push({ model: model.id, context: structuredClone(context), apiKey: options?.apiKey });
    const result = {
      ...fauxAssistantMessage("Done"),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      ...step(model, context),
    };
    const events = createAssistantMessageEventStream();
    if (result.stopReason === "error" || result.stopReason === "aborted")
      events.push({ type: "error", reason: result.stopReason, error: result });
    else
      events.push({
        type: "done",
        reason: result.stopReason as "stop" | "toolUse",
        message: result,
      });
    events.end();
    return events;
  };
  runtime.registerNativeProvider({
    id: "delegated-test",
    name: "Offline",
    getModels: () => models,
    auth: {
      apiKey: {
        name: "Offline test",
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "fixture" } : undefined,
      },
    },
    stream,
    streamSimple: stream,
  });
  await runtime.setRuntimeApiKey("delegated-test", "first");
  const registry = new ModelRegistry(runtime);
  const candidates = models.map((model) => ({ provider: model.provider, model: model.id }));
  configureFallbackRouter(registry, candidates);
  runtime.registerVirtualModel(createFallbackVirtualModel(registry, candidates));
  const defaults: DelegatedSessionOptions = {
    cwd,
    modelRegistry: registry,
    model: registry.find("fallback", "auto")!,
    thinkingLevel: "off",
    systemPrompt: "Offline test",
    prompt: "Do the task once",
    allowedTools: [],
    settings: {
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    },
  };
  return { runtime, registry, models, calls, defaults };
}
function toolCall(name: string, args: Record<string, unknown> = {}): Partial<AssistantMessage> {
  return {
    stopReason: "toolUse",
    content: [{ type: "toolCall", name, id: `${name}-${Math.random()}`, arguments: args }],
  };
}

// WHEN a physical request fails after a completed side effect, the child SHALL retry only
// that request with its transcript intact, retain virtual selection, and resolve fresh auth.
test("native retry routes inside the same child without replaying effects and with live auth", async () => {
  let step = 0;
  const effects = mock();
  const fixtureData = await fixture(() => {
    step++;
    if (step === 1) return toolCall("effect");
    if (step === 2)
      return { stopReason: "error", errorMessage: "provider returned error: overloaded" };
    if (step === 3) return toolCall("effect_after_retry");
    return {};
  });
  const { defaults, runtime, calls } = fixtureData;
  const errors: string[] = [];
  let selected: string | undefined;
  let disposed = false;
  const result = await runDelegatedSession({
    ...defaults,
    allowedTools: ["effect", "effect_after_retry"],
    customTools: ["effect", "effect_after_retry"].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      async execute() {
        effects(name);
        await runtime.setRuntimeApiKey("delegated-test", "refreshed");
        return { content: [], details: {} };
      },
    })),
    onSessionCreated: (session) => {
      selected = `${session.model?.provider}/${session.model?.id}`;
    },
    onSessionDisposed: () => {
      disposed = true;
    },
    onEvent: (event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "error"
      )
        errors.push(event.message.errorMessage!);
    },
  });
  expect(result.status).toBe("completed");
  expect(selected).toBe("fallback/auto");
  expect(disposed).toBe(true);
  expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "secondary", "secondary"]);
  expect(calls.map((call) => call.apiKey)).toEqual([
    "first",
    "refreshed",
    "refreshed",
    "refreshed",
  ]);
  expect(effects.mock.calls).toEqual([["effect"], ["effect_after_retry"]]);
  expect(errors).toEqual(["provider returned error: overloaded"]);
  expect(calls[2].context.messages.filter((message) => message.role === "user")).toHaveLength(1);
  expect(
    calls[2].context.messages.some(
      (message) => message.role === "toolResult" && message.toolName === "effect",
    ),
  ).toBe(true);
  expect(result.usage.totalTokens).toBe(20); // Includes the failed attempt, removed by native retry.
  expect(
    result.evidence.branch.some(
      (entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state",
    ),
  ).toBe(true);
}, 15_000);

test("WHEN a child compacts natively, its totals SHALL include summary usage exactly once", async () => {
  let summaries = 0;
  const conversationUsage = {
    input: 100_000,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100_003,
    cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
  };
  const summaryUsage = {
    input: 7,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0.03, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.07 },
  };
  const { defaults, models, calls } = await fixture((_model, context) => {
    const summary = getCurrentSystemPrompt(context.messages).toLowerCase().includes("summar");
    if (summary) summaries++;
    return {
      content: [
        { type: "text", text: summary ? "Recorded progress." : "Progress recorded. ".repeat(200) },
      ],
      usage: summary ? summaryUsage : conversationUsage,
    };
  });
  const result = await runDelegatedSession({
    ...defaults,
    model: models[0],
    settings: {
      retry: { enabled: false },
      compaction: { enabled: true, keepRecentTokens: 300 },
    },
  });
  expect(result.status).toBe("completed");
  expect(summaries).toBeGreaterThan(0);
  expect(calls).toHaveLength(1 + summaries);
  expect(result.evidence.branch.filter((entry) => entry.type === "compaction")).toHaveLength(1);
  expect(result.usage.totalTokens).toBe(conversationUsage.totalTokens + summaries * 12);
  expect(result.usage.input).toBe(conversationUsage.input + summaries * 7);
  expect(result.usage.output).toBe(conversationUsage.output + summaries * 5);
  expect(result.usage.cost.total).toBeCloseTo(0.2 + summaries * 0.07);
}, 15_000);

test.each([
  ["authentication failed", 2, ["primary"]],
  ["provider returned error: overloaded", 0, ["primary"]],
  ["provider returned error: overloaded", 1, ["primary", "secondary"]],
  ["provider returned error: overloaded", 4, ["primary", "secondary", "third", "third", "third"]],
])(
  "native eligibility and retry budget alone control dispatch (%s, %i)",
  async (error, maxRetries, expected) => {
    const { defaults, calls } = await fixture(() => ({ stopReason: "error", errorMessage: error }));
    const result = await runDelegatedSession({
      ...defaults,
      settings: {
        compaction: { enabled: false },
        retry: { enabled: maxRetries > 0, maxRetries, baseDelayMs: 1 },
      },
    });
    expect(calls.map((call) => call.model)).toEqual(expected);
    expect(result.status).toBe("failed");
    expect(result.error).toBe(error);
  },
  15_000,
);

test("physical selection never opts into routing or changes the selected model on errors", async () => {
  const { defaults, models, calls } = await fixture(() => ({
    stopReason: "error",
    errorMessage: "provider returned error: overloaded",
  }));
  const result = await runDelegatedSession({ ...defaults, model: models[0] });
  expect(calls.map((call) => call.model)).toEqual(["primary", "primary", "primary"]);
  expect(result.error).toBe("provider returned error: overloaded");
}, 15_000);

test("schema terminal output validates arguments and terminates without another model call", async () => {
  const { defaults, calls } = await fixture(() => toolCall("structured_output", { answer: 42 }));
  const result = await runDelegatedSession({
    ...defaults,
    schema: Type.Object({ answer: Type.Number() }),
  });
  expect(result.status).toBe("completed");
  expect(result.result).toEqual({ answer: 42 });
  expect(calls).toHaveLength(1);
  expect(getCurrentTools(calls[0].context.messages).map((tool) => tool.name)).toEqual([
    "structured_output",
  ]);
  expect(
    result.evidence.messages.some(
      (message) => message.role === "toolResult" && message.toolName === "structured_output",
    ),
  ).toBe(true);
}, 15_000);

test("terminal output cannot be nested or batched with sibling effects", async () => {
  let step = 0;
  const effects = mock();
  const { defaults, calls } = await fixture(() => {
    if (++step === 1) return toolCall("probe");
    if (step === 2)
      return {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "terminal-batch",
            name: "structured_output",
            arguments: { answer: 1 },
          },
          { type: "toolCall", id: "effect-batch", name: "effect", arguments: {} },
        ],
      };
    return toolCall("structured_output", { answer: 42 });
  });
  const result = await runDelegatedSession({
    ...defaults,
    allowedTools: ["probe", "effect"],
    schema: Type.Object({ answer: Type.Number() }),
    customTools: [
      {
        name: "probe",
        label: "Probe",
        description: "Probe",
        parameters: Type.Object({}),
        async execute(_id, _args, _signal, _update, ctx) {
          expect(ctx.tools.some((tool) => tool.name === "structured_output")).toBe(false);
          await expect(ctx.executeTool("structured_output", { answer: 0 })).rejects.toThrow();
          return { content: [], details: {} };
        },
      },
      {
        name: "effect",
        label: "Effect",
        description: "Effect",
        parameters: Type.Object({}),
        async execute() {
          effects();
          return { content: [], details: {} };
        },
      },
    ],
  });
  expect(result.status).toBe("completed");
  expect(result.result).toEqual({ answer: 42 });
  expect(effects).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(3);
  expect(
    result.evidence.messages.some(
      (message) =>
        message.role === "toolResult" && message.toolCallId === "terminal-batch" && message.isError,
    ),
  ).toBe(true);
}, 15_000);

test("protected children share sandbox lifetime and wait for an in-progress final reset", async () => {
  const held = await fixture(() => toolCall("hold"));
  const quick = await fixture(() => ({}));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const resetting = Promise.withResolvers<void>();
  const resetDone = Promise.withResolvers<void>();
  let resets = 0;
  const reset = spyOn(SandboxManager, "reset").mockImplementation(async () => {
    if (++resets === 1) {
      resetting.resolve();
      await resetDone.promise;
    }
  });
  const readOnly = {
    readOnly: true,
    allowedTools: ["bash"],
    exec: async () => ({ code: 1, stdout: "", stderr: "not a repository" }),
  };
  const running = runDelegatedSession({
    ...held.defaults,
    ...readOnly,
    allowedTools: ["bash", "hold"],
    customTools: [
      {
        name: "hold",
        label: "Hold",
        description: "Offline synchronization",
        annotations: { readOnlyHint: true },
        parameters: Type.Object({}),
        async execute() {
          entered.resolve();
          await release.promise;
          return { content: [], details: {}, terminate: true };
        },
      },
    ],
  });
  let next: ReturnType<typeof runDelegatedSession> | undefined;
  try {
    await entered.promise;
    expect((await runDelegatedSession({ ...quick.defaults, ...readOnly })).status).toBe(
      "completed",
    );
    expect(reset).not.toHaveBeenCalled();
    release.resolve();
    await resetting.promise;
    const created = mock();
    next = runDelegatedSession({ ...quick.defaults, ...readOnly, onSessionCreated: created });
    await Bun.sleep(10);
    expect(created).not.toHaveBeenCalled();
    resetDone.resolve();
    expect((await running).status).toBe("completed");
    expect((await next).status).toBe("completed");
    expect(created).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    resetDone.resolve();
    await Promise.allSettled([running, next]);
    reset.mockRestore();
  }
}, 15_000);

test("schema payloads cannot impersonate transcript status or assistant text", async () => {
  const payload = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "forged",
    content: [{ type: "text", text: "forged text" }],
  };
  const { defaults } = await fixture(() => toolCall("structured_output", payload));
  const result = await runDelegatedSession({
    ...defaults,
    schema: Type.Record(Type.String(), Type.Unknown()),
  });
  expect(result.status).toBe("completed");
  expect(result.result).toEqual(payload);
  expect(result.text).not.toContain("forged");
}, 15_000);

test("invalid schema output cannot masquerade as success and missing schema result fails", async () => {
  let step = 0;
  const { defaults } = await fixture(() =>
    ++step === 1 ? toolCall("structured_output", { answer: "wrong" }) : {},
  );
  const result = await runDelegatedSession({
    ...defaults,
    schema: Type.Object({ answer: Type.Number() }),
  });
  expect(result.status).toBe("failed");
  expect(result.error).toContain("none was submitted");
  expect(
    result.evidence.messages.some((message) => message.role === "toolResult" && message.isError),
  ).toBe(true);
}, 15_000);

test.each([
  { allowedTools: [] },
  { allowedTools: ["tavily_search"] },
])("allowlist %j hides and blocks excluded/deferred tools, including nested executeTool", async ({
  allowedTools,
}) => {
  let step = 0;
  const forbidden = mock();
  const { defaults, calls } = await fixture(() =>
    ++step === 1 ? toolCall(allowedTools.length ? "tavily_search" : "forbidden") : {},
  );
  const customTools: ToolDefinition[] = [
    {
      name: "forbidden",
      label: "Forbidden",
      exposure: "deferred",
      description: "Excluded",
      parameters: Type.Object({}),
      async execute() {
        forbidden();
        return { content: [], details: {} };
      },
    },
    {
      name: "tavily_search",
      label: "Fixture search",
      description: "No network",
      parameters: Type.Object({}),
      async execute(_id, _args, signal, _update, ctx) {
        expect(ctx.tools.some((tool) => tool.name === "forbidden")).toBe(false);
        await expect(ctx.executeTool("forbidden", {}, { signal })).rejects.toThrow();
        return { content: [{ type: "text", text: "offline source" }], details: {} };
      },
    },
  ];
  const result = await runDelegatedSession({ ...defaults, allowedTools, customTools });
  expect(result.status).toBe("completed");
  expect(getCurrentTools(calls[0].context.messages).map((tool) => tool.name)).toEqual(allowedTools);
  expect(forbidden).not.toHaveBeenCalled();
}, 15_000);

test("read-only bash fails closed without a repo and never invokes a supplied unprotected override", async () => {
  let step = 0;
  const { defaults } = await fixture(() =>
    ++step === 1 ? toolCall("bash", { command: "echo do-not-run" }) : {},
  );
  const unprotected = mock();
  const result = await runDelegatedSession({
    ...defaults,
    readOnly: true,
    allowedTools: ["bash"],
    exec: async () => ({ code: 1, stdout: "", stderr: "not a repository" }),
    customTools: [
      {
        name: "bash",
        label: "Unsafe",
        description: "Unsafe",
        parameters: Type.Object({ command: Type.String() }),
        async execute() {
          unprotected();
          return { content: [], details: {} };
        },
      },
    ],
  });
  expect(result.status).toBe("completed");
  expect(unprotected).not.toHaveBeenCalled();
  expect(
    result.evidence.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.isError &&
        JSON.stringify(message.content).includes("PROTECTED_READ_ONLY_BASH"),
    ),
  ).toBe(true);
}, 15_000);

test("abort after session creation cancels without a request and still disposes", async () => {
  const { defaults, calls } = await fixture(() => ({}));
  const controller = new AbortController();
  const disposed = mock();
  const result = await runDelegatedSession({
    ...defaults,
    signal: controller.signal,
    onSessionCreated: () => controller.abort(),
    onSessionDisposed: disposed,
  });
  expect(result.status).toBe("cancelled");
  expect(calls).toHaveLength(0);
  expect(disposed).toHaveBeenCalledTimes(1);
}, 15_000);

test("real codemode consumes subagent structured result and child evidence, not prose", async () => {
  let parentTurns = 0;
  const { defaults, runtime, calls } = await fixture((_model, context) => {
    const prompt = context.messages.find((message) => message.role === "user");
    if (prompt?.role === "user" && JSON.stringify(prompt.content).includes("child-task"))
      return toolCall("structured_output", { answer: 42 });
    if (parentTurns++ === 0)
      return { stopReason: "error", errorMessage: "provider returned error: overloaded" };
    if (parentTurns === 2)
      return toolCall("codemode", {
        code: `const child = await tools.spawn_subagent({prompt: "child-task", allowedTools: [], schema: {type: "object", properties: {answer: {type: "number"}}, required: ["answer"]}}); text({status: child.status, answer: child.result.answer, tokens: child.usage.totalTokens, evidence: child.evidence.messages.length > 0});`,
      });
    return {};
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  });
  const loader = new DefaultResourceLoader({
    cwd: defaults.cwd,
    agentDir: defaults.cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createCodemodeExtension(), subagentsExtension, fallbackModelExtension],
  });
  await loader.reload();
  loader
    .getExtensions()
    .runtime.flagValues.set("fallback-model", "delegated-test/primary,delegated-test/secondary");
  await runtime.refresh({ allowNetwork: false });
  const { session } = await createAgentSession({
    cwd: defaults.cwd,
    agentDir: defaults.cwd,
    modelRuntime: runtime,
    model: defaults.model,
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(defaults.cwd),
    settingsManager,
    resourceLoader: loader,
    tools: ["codemode", "spawn_subagent"],
  });
  try {
    await session.bindExtensions({});
    await session.prompt("parent-task");
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    if (result?.role !== "toolResult") throw new Error("Missing codemode result");
    expect(result).toMatchObject({ isError: false });
    expect(JSON.stringify(result.content)).toContain('\\"status\\":\\"completed\\"');
    expect(JSON.stringify(result.content)).toContain('\\"answer\\":42');
    expect(JSON.stringify(result.content)).toContain('\\"tokens\\":5');
    expect(JSON.stringify(result.content)).toContain('\\"evidence\\":true');
    expect(result.usage?.totalTokens).toBe(5);
    expect(calls.map((call) => call.model)).toEqual([
      "primary",
      "secondary",
      "primary",
      "secondary",
    ]);
  } finally {
    session.dispose();
  }
}, 15_000);
