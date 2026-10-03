import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AuthResult,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withTimeout } from "../../tests/support/async";
import { isolateEnvVars } from "../../tests/support/env";

let completeImpl: (...args: unknown[]) => Promise<unknown> = async () => ({
  content: [{ type: "text", text: "Generated Title" }],
});

type EventHandler = (event: any, ctx: any) => Promise<void> | void;

function createFakePi(flags: Record<string, unknown> = {}) {
  const events = new Map<string, EventHandler[]>();
  const flagValues = new Map(Object.entries(flags));
  const registeredFlags = new Set<string>();
  let sessionName: string | undefined;
  let resolveSetName: ((name: string) => void) | undefined;
  const setNamePromise = new Promise<string>((resolve) => {
    resolveSetName = resolve;
  });

  return {
    events,
    setNames: [] as string[],
    flags: [] as Array<{ name: string; definition: unknown }>,
    on(eventName: string, handler: EventHandler) {
      events.set(eventName, [...(events.get(eventName) ?? []), handler]);
    },
    registerFlag(name: string, definition: unknown) {
      registeredFlags.add(name);
      this.flags.push({ name, definition });
      if (
        definition &&
        typeof definition === "object" &&
        "default" in definition &&
        !flagValues.has(name)
      ) {
        flagValues.set(name, definition.default);
      }
    },
    getFlag(name: string) {
      if (!registeredFlags.has(name)) return undefined;
      return flagValues.get(name);
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(name: string) {
      sessionName = name;
      this.setNames.push(name);
      resolveSetName?.(name);
    },
    waitForSetName() {
      return setNamePromise;
    },
  };
}

function createCtx(entries: unknown[] = [], trusted = true, cwd = tempCwd) {
  return {
    cwd,
    isProjectTrusted: () => trusted,
    sessionManager: {
      getBranch: () => entries,
    },
    modelRegistry: {
      find: (provider: string, modelId: string) => ({ provider, id: modelId }),
      streamSimple: (...args: unknown[]) => ({ result: () => completeImpl(...args) }),
    },
  };
}

type NativeTitleCall = {
  model: Model<string>;
  context: TranscriptContext;
  options?: SimpleStreamOptions;
};

async function createNativeTitleRegistry(
  resolveAuth: NonNullable<Provider["auth"]["apiKey"]>["resolve"] = async () => ({
    auth: { apiKey: "test-key", headers: { "x-test": "1" } },
    source: "fixture",
  }),
) {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = {
    ...runtime.getModels("anthropic")[0]!,
    provider: "test-provider",
    id: "test-model",
    api: "native-title-test",
    baseUrl: "https://example.invalid/{PI_TITLE_TEST_ACCOUNT}",
  };
  const calls: NativeTitleCall[] = [];
  const streamSimple: Provider["streamSimple"] = (requestModel, context, options) => {
    calls.push({ model: requestModel, context, options });
    const events = createAssistantMessageEventStream();
    const response = {
      ...fauxAssistantMessage("Configured Model Title"),
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
    };
    events.push({ type: "done", reason: "stop", message: response });
    events.end();
    return events;
  };
  runtime.registerNativeProvider({
    id: model.provider,
    name: "Native title fixture",
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "Fixture authentication",
        check: async () => ({ type: "api_key", source: "fixture" }),
        resolve: resolveAuth,
      },
    },
    stream() {
      throw new Error("The title fixture must be called through streamSimple");
    },
    streamSimple,
  });
  return { registry: new ModelRegistry(runtime), calls };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushBackgroundWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function loadExtension() {
  return await import("./index");
}

async function loadTitleHelpers() {
  return await import("./title");
}

let tempAgentDir: string;
let tempCwd: string;

function writeProjectSettings(settings: unknown) {
  const settingsDir = join(tempCwd, ".pi");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
}

describe("session-title extension", () => {
  isolateEnvVars(["PI_CODING_AGENT_DIR", "PI_TITLE_TEST_ACCOUNT"]);

  beforeEach(() => {
    tempAgentDir = mkdtempSync(join(tmpdir(), "pi-session-title-agent-test-"));
    tempCwd = mkdtempSync(join(tmpdir(), "pi-session-title-test-"));
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
  });

  afterEach(() => {
    rmSync(tempAgentDir, { recursive: true, force: true });
    rmSync(tempCwd, { recursive: true, force: true });
  });

  test("arms only fresh unnamed startup or new sessions", async () => {
    const { shouldArmSessionTitle } = await loadTitleHelpers();

    expect(shouldArmSessionTitle("startup", [], undefined)).toBe(true);
    expect(shouldArmSessionTitle("new", [], undefined)).toBe(true);
    expect(shouldArmSessionTitle("resume", [], undefined)).toBe(false);
    expect(shouldArmSessionTitle("startup", [], "Named")).toBe(false);
    expect(
      shouldArmSessionTitle(
        "startup",
        [
          {
            type: "message",
            id: "entry-1",
            parentId: null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "user", content: "hello", timestamp: 1 },
          },
        ],
        undefined,
      ),
    ).toBe(false);
  });

  test("extracts and sanitizes generated titles", async () => {
    const { extractUserText, sanitizeSessionName } = await loadTitleHelpers();

    expect(
      extractUserText([
        { type: "text", text: "調査してください" },
        { type: "image", data: "ignored" },
        { type: "text", text: "pi extension" },
      ]),
    ).toBe("調査してください\npi extension");
    expect(sanitizeSessionName('Title: "Auto Name Session".')).toBe("Auto Name Session");
    expect(sanitizeSessionName('"Auto Name Session."')).toBe("Auto Name Session");
    expect(sanitizeSessionName("タイトル：『セッション自動命名』。 ")).toBe("セッション自動命名");
    expect(sanitizeSessionName("π - Implement Auto Naming")).toBe("Implement Auto Naming");
    expect(sanitizeSessionName("Title:\nImplement Auto Naming")).toBe("Implement Auto Naming");
  });

  test("registers and honors --no-session-title", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi({ "no-session-title": true });
    const ctx = createCtx();
    const completeCalls: unknown[][] = [];
    completeImpl = async (...args: unknown[]) => {
      completeCalls.push(args);
      return { content: [{ type: "text", text: "Should Not Run" }] };
    };

    extension(pi as never);

    expect(pi.flags).toEqual([
      {
        name: "no-session-title",
        definition: {
          description: "セッション名の自動生成を無効にする",
          type: "boolean",
          default: false,
        },
      },
    ]);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "name this" } },
      ctx,
    );

    expect(completeCalls).toEqual([]);
    expect(pi.setNames).toEqual([]);
  });

  test("When other registered workflows are enabled, automatic titles shall remain enabled", async () => {
    const { default: extension } = await loadExtension();

    for (const flag of ["commit", "create-pr"] as const) {
      const pi = createFakePi({ [flag]: true });
      pi.registerFlag(flag, { type: "boolean", default: false });
      const ctx = createCtx();
      completeImpl = async () => ({
        content: [{ type: "text", text: "Workflow Session Title" }],
      });

      extension(pi as never);

      await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
      await pi.events.get("message_end")![0](
        { message: { role: "user", content: "name this" } },
        ctx,
      );

      await expect(withTimeout(pi.waitForSetName(), "session name was not set")).resolves.toBe(
        "Workflow Session Title",
      );
      expect(pi.setNames).toEqual(["Workflow Session Title"]);
    }
  });

  test("generates a title in the background without notifying or injecting context", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    const completeCalls: unknown[][] = [];
    const completion = deferred<unknown>();
    completeImpl = async (...args: unknown[]) => {
      completeCalls.push(args);
      return completion.promise;
    };

    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "pi session title please" } },
      ctx,
    );

    expect(pi.setNames).toEqual([]);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "do not start another title request" } },
      ctx,
    );
    expect(completeCalls).toHaveLength(1);
    completion.resolve({
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "set_session_title",
          arguments: { title: "Implement Auto Naming" },
        },
      ],
    });

    await expect(withTimeout(pi.waitForSetName(), "session name was not set")).resolves.toBe(
      "Implement Auto Naming",
    );
    expect(pi.setNames).toEqual(["Implement Auto Naming"]);
    expect(completeCalls).toHaveLength(1);
    const model = completeCalls[0]![0] as Record<string, unknown>;
    expect(model).toMatchObject({ provider: "openai", id: "gpt-5.3-codex-spark" });
    const options = completeCalls[0]![2] as Record<string, unknown>;
    expect(options).toMatchObject({
      reasoning: "low",
      timeoutMs: 15_000,
    });
    const context = completeCalls[0]![1] as {
      tools?: Array<{ name: string }>;
    };
    expect(context.tools?.map((tool) => tool.name)).toEqual(["set_session_title"]);
  });

  test("When trusted project settings select a native provider, the title shall use its configured stream", async () => {
    const { default: extension } = await loadExtension();
    writeProjectSettings({
      "session-title": {
        model: "test-provider/test-model:medium",
      },
    });
    const pi = createFakePi();
    const { registry, calls } = await createNativeTitleRegistry();
    const ctx = { ...createCtx(), modelRegistry: registry };

    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "pi session title please" } },
      ctx,
    );

    await expect(withTimeout(pi.waitForSetName(), "session name was not set")).resolves.toBe(
      "Configured Model Title",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toMatchObject({ provider: "test-provider", id: "test-model" });
    expect(calls[0]!.options).toMatchObject({
      apiKey: "test-key",
      headers: { "x-test": "1" },
      reasoning: "medium",
      timeoutMs: 15_000,
    });
    expect(getCurrentSystemPrompt(calls[0]!.context.messages)).toContain("set_session_title");
    expect(getCurrentTools(calls[0]!.context.messages).map((tool) => tool.name)).toEqual([
      "set_session_title",
    ]);
  });

  test("When project trust is denied, project settings shall not override the global title model", async () => {
    const { default: extension } = await loadExtension();
    writeFileSync(
      join(tempAgentDir, "settings.json"),
      JSON.stringify({ "session-title": { model: "local/global-model:off" } }),
    );
    writeProjectSettings({
      "session-title": { model: "openai/gpt-5.3-codex-spark:low" },
    });
    const pi = createFakePi();
    const ctx = createCtx([], false);
    const calls: unknown[][] = [];
    completeImpl = async (...args: unknown[]) => {
      calls.push(args);
      return { content: [{ type: "text", text: "Global Model Title" }] };
    };
    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "keep this local" } },
      ctx,
    );

    await expect(withTimeout(pi.waitForSetName(), "session name was not set")).resolves.toBe(
      "Global Model Title",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ provider: "local", id: "global-model" });
    expect(calls[0]![2]).toMatchObject({ reasoning: undefined });
  });

  const titleAuthCases: AuthResult[] = [
    { auth: {}, source: "ambient credentials" },
    { auth: { headers: { "cf-aig-authorization": "fixture-token" } }, source: "header-only" },
    {
      auth: { apiKey: "fixture-key", baseUrl: "https://account.example.invalid/v1" },
      env: { PI_TITLE_TEST_ACCOUNT: "credential-account" },
      source: "credential environment",
    },
  ];
  test.each(
    titleAuthCases,
  )("When authentication resolves without a key or with provider configuration, the title shall preserve it: %j", async (auth) => {
    const { default: extension } = await loadExtension();
    writeProjectSettings({ "session-title": { model: "test-provider/test-model:low" } });
    expect(process.env.PI_TITLE_TEST_ACCOUNT).toBeUndefined();
    const { registry, calls } = await createNativeTitleRegistry(async () => auth);
    const ctx = { ...createCtx(), modelRegistry: registry };
    const pi = createFakePi();
    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "name this" } },
      ctx,
    );

    await expect(withTimeout(pi.waitForSetName(), "session name was not set")).resolves.toBe(
      "Configured Model Title",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.apiKey).toBe(auth.auth.apiKey);
    expect(calls[0]!.options?.headers).toEqual(auth.auth.headers);
    expect(calls[0]!.options?.env).toEqual(auth.env);
    if (auth.auth.baseUrl) expect(calls[0]!.model.baseUrl).toBe(auth.auth.baseUrl);
    expect(process.env.PI_TITLE_TEST_ACCOUNT).toBeUndefined();
  });

  test("uses the first valid structured title", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    completeImpl = async () => ({
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "set_session_title",
          arguments: { title: 123 },
        },
        {
          type: "toolCall",
          id: "call-2",
          name: "set_session_title",
          arguments: {
            title: "Implement Automatic Session Naming for Pi Extension Workflow Tests",
          },
        },
      ],
    });

    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "pi session title please" } },
      ctx,
    );

    await expect(withTimeout(pi.waitForSetName(), "session name was not set")).resolves.toBe(
      "Implement Automatic Session Naming for Pi Extension",
    );
  });

  test("falls back to text title when structured tool call is absent", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    completeImpl = async () => ({
      content: [{ type: "text", text: "Implement Text Fallback" }],
    });

    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "pi session title please" } },
      ctx,
    );

    await expect(withTimeout(pi.waitForSetName(), "session name was not set")).resolves.toBe(
      "Implement Text Fallback",
    );
  });

  test.each([
    "structured",
    "text",
  ] as const)("When generated %s titles contain terminal controls, session-title shall sanitize them before publishing", async (responseType) => {
    const { default: extension } = await loadExtension();
    const cases = [
      { title: "Task\u0007\u001b]52;c;SGVsbG8=\u0007", expected: "Task" },
      {
        title: "Title: \u001b[31m『セッション自動命名』。\u001b[0m",
        expected: "セッション自動命名",
      },
      {
        title: `\u001b]0;${"ignored ".repeat(20)}\u001b\\Implement Safe Titles`,
        expected: "Implement Safe Titles",
      },
      { title: "Safe\u0000\u0007\u001b\u007f\u009b Title", expected: "Safe Title" },
      { title: "Title:\nImplement\tSafe Titles\r\nExplanation", expected: "Implement Safe Titles" },
    ];
    for (const { title, expected } of cases) {
      const pi = createFakePi();
      const ctx = createCtx();
      completeImpl = async () => ({
        content: [
          responseType === "structured"
            ? {
                type: "toolCall",
                id: "call-safe-title",
                name: "set_session_title",
                arguments: { title },
              }
            : { type: "text", text: title },
        ],
      });
      extension(pi as never);
      await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
      await pi.events.get("message_end")![0](
        { message: { role: "user", content: "name this session" } },
        ctx,
      );

      await expect(withTimeout(pi.waitForSetName(), "safe session name was not set")).resolves.toBe(
        expected,
      );
      expect(pi.setNames).toEqual([expected]);
      expect(pi.setNames[0]).not.toMatch(/\p{Cc}/u);
    }
  });

  test("When a structured title contains only terminal controls, session-title shall use the safe text fallback", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    completeImpl = async () => ({
      content: [
        {
          type: "toolCall",
          id: "call-control-only",
          name: "set_session_title",
          arguments: { title: "\u0007\u001b]52;c;SGVsbG8=\u0007" },
        },
        { type: "text", text: "\u001b[32mSafe Fallback\u001b[0m" },
      ],
    });
    extension(pi as never);
    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "name this session" } },
      ctx,
    );

    await expect(
      withTimeout(pi.waitForSetName(), "fallback session name was not set"),
    ).resolves.toBe("Safe Fallback");
    expect(pi.setNames).toEqual(["Safe Fallback"]);
  });

  test("WHEN a session changes during title generation, the new session SHALL rearm and ignore the old result", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    const oldCompletion = deferred<unknown>();
    const newCompletion = deferred<unknown>();
    const signals: AbortSignal[] = [];
    completeImpl = async (...args: unknown[]) => {
      signals.push((args[2] as { signal: AbortSignal }).signal);
      return signals.length === 1 ? oldCompletion.promise : newCompletion.promise;
    };
    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "old session" } },
      ctx,
    );
    await pi.events.get("session_start")![0]({ reason: "new" }, ctx);
    expect(signals[0]!.aborted).toBe(true);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "new session" } },
      ctx,
    );
    expect(signals).toHaveLength(2);
    oldCompletion.resolve({ content: [{ type: "text", text: "Stale Title" }] });
    await flushBackgroundWork();
    expect(pi.setNames).toEqual([]);
    expect(signals[1]!.aborted).toBe(false);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "another new message" } },
      ctx,
    );
    expect(signals).toHaveLength(2);

    newCompletion.resolve({ content: [{ type: "text", text: "Current Session Title" }] });
    await expect(withTimeout(pi.waitForSetName(), "new session name was not set")).resolves.toBe(
      "Current Session Title",
    );
    expect(pi.setNames).toEqual(["Current Session Title"]);
  });

  test("When shutdown occurs during authentication, the title request shall abort without dispatching the provider", async () => {
    const { default: extension } = await loadExtension();
    writeProjectSettings({ "session-title": { model: "test-provider/test-model:low" } });
    const pi = createFakePi();
    const auth = deferred<AuthResult>();
    const authStarted = deferred<AbortSignal>();
    const authSettled = deferred<void>();
    const { registry, calls } = await createNativeTitleRegistry(async ({ signal }) => {
      authStarted.resolve(signal);
      try {
        return await auth.promise;
      } finally {
        authSettled.resolve();
      }
    });
    const ctx = { ...createCtx(), modelRegistry: registry };

    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "name this" } },
      ctx,
    );
    const signal = await withTimeout(authStarted.promise, "authentication did not start");
    await pi.events.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    expect(signal.aborted).toBe(true);
    auth.resolve({ auth: { apiKey: "test-key" }, source: "fixture" });
    await withTimeout(authSettled.promise, "authentication did not settle");
    await flushBackgroundWork();

    expect(calls).toEqual([]);
    expect(pi.setNames).toEqual([]);
  });

  test("When shutdown interrupts generation, session-title shall abort and discard a late provider response", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    const completion = deferred<unknown>();
    let signal: AbortSignal | undefined;
    completeImpl = async (...args: unknown[]) => {
      signal = (args[2] as { signal: AbortSignal }).signal;
      return completion.promise;
    };
    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "name this" } },
      ctx,
    );
    expect(signal?.aborted).toBe(false);
    await pi.events.get("session_shutdown")![0]({ reason: "quit" }, ctx);
    expect(signal?.aborted).toBe(true);
    completion.resolve({
      content: [{ type: "text", text: "Stale Title" }],
      stopReason: "stop",
    });
    await flushBackgroundWork();
    expect(pi.setNames).toEqual([]);
  });

  test("When a name is manually assigned during generation, session-title shall preserve it", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    const completion = deferred<unknown>();
    completeImpl = async () => completion.promise;
    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "name this" } },
      ctx,
    );
    pi.setSessionName("Manual Title");
    completion.resolve({ content: [{ type: "text", text: "Automatic Title" }] });
    await flushBackgroundWork();

    expect(pi.setNames).toEqual(["Manual Title"]);
  });

  test("silently ignores title generation failures", async () => {
    const { default: extension } = await loadExtension();
    const pi = createFakePi();
    const ctx = createCtx();
    const completion = deferred<unknown>();
    const completeSettled = deferred<void>();
    completeImpl = async () => {
      try {
        return await completion.promise;
      } finally {
        completeSettled.resolve();
      }
    };

    extension(pi as never);

    await pi.events.get("session_start")![0]({ reason: "startup" }, ctx);
    await pi.events.get("message_end")![0](
      { message: { role: "user", content: "name this" } },
      ctx,
    );
    completion.reject(new Error("network down"));
    await withTimeout(completeSettled.promise, "complete did not settle");
    await flushBackgroundWork();

    expect(pi.setNames).toEqual([]);
  });
});
