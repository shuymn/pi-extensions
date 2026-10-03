import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/subagents";
import { withTimeout } from "./support/async";

async function fixture(waiter = false) {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-lifecycle-"));
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    refreshOnCreate: false,
  });
  const model = {
    ...models.getModels("anthropic")[0]!,
    provider: "lifecycle-fixture",
    id: "offline",
    name: "Offline lifecycle fixture",
    api: "offline-lifecycle",
    baseUrl: "https://example.invalid",
  };
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let heldSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  let requests = 0;
  const stream: Provider["streamSimple"] = (selected, context, options) => {
    requests++;
    const events = createAssistantMessageEventStream();
    const response = {
      ...fauxAssistantMessage("Offline completion"),
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
    };
    const finish = () => {
      if (options?.signal?.aborted) {
        response.stopReason = "aborted";
        response.errorMessage = "Offline cancellation settled";
        events.push({ type: "error", reason: "aborted", error: response });
      } else {
        events.push({ type: "done", reason: "stop", message: response });
      }
      events.end();
    };
    if (
      context.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("held-child"),
      )
    ) {
      heldSignal = options?.signal;
      heldSignal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      release = finish;
      started.resolve();
    } else finish();
    return events;
  };
  models.registerNativeProvider({
    id: model.provider,
    name: model.name,
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "Offline",
        resolve: async () => ({ auth: { apiKey: "offline" }, source: "fixture" }),
      },
    },
    stream,
    streamSimple: stream,
  });
  await models.setRuntimeApiKey(model.provider, "offline");
  let cancel: "switch" | "fork" | "tree" | undefined;
  const errors: string[] = [];
  const create: CreateAgentSessionRuntimeFactory = async ({
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: cwd,
      settingsManager: settings,
      modelRuntime: models,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          subagentsExtension,
          (pi) => {
            // Registered after subagents: a veto has no matching session_start/session_tree.
            pi.on("session_before_switch", () => ({ cancel: cancel === "switch" }));
            pi.on("session_before_fork", () => ({ cancel: cancel === "fork" }));
            pi.on("session_before_tree", () => ({ cancel: cancel === "tree" }));
          },
        ],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      tools: ["spawn_subagent", ...(waiter ? ["get_subagent_result"] : [])],
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(create, {
    cwd,
    agentDir: cwd,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const bind = (session: AgentSession) =>
    session.bindExtensions({ onError: (event) => errors.push(event.error) });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  return {
    runtime,
    errors,
    started: started.promise,
    aborted: aborted.promise,
    get signal() {
      return heldSignal;
    },
    get requests() {
      return requests;
    },
    release() {
      release?.();
      release = undefined;
    },
    cancelNext(value: typeof cancel) {
      cancel = value;
    },
    invoke(name: string, args = {}) {
      return runtime.session.extensionRunner
        .getToolDefinition(name)!
        .execute(
          "fixture",
          args,
          undefined,
          undefined,
          runtime.session.extensionRunner.createToolContext("fixture", undefined),
        );
    },
    async close() {
      release?.();
      await runtime.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test("WHEN the native parent aborts a result wait, the background child SHALL remain running", async () => {
  const f = await fixture(true);
  const session = f.runtime.session;
  const waiter = session.extensionRunner.getToolDefinition("get_subagent_result")!;
  const originalExecute = waiter.execute;
  const entered = Promise.withResolvers<void>();
  let waiting: ReturnType<typeof originalExecute> | undefined;
  let waiterSignal: AbortSignal | undefined;
  let waiterSettled = false;
  waiter.execute = (...args) => {
    // Unlike tool_execution_start, this barrier is after the real waiter has
    // installed its abort listener, not before native argument/hook preparation.
    const pending = originalExecute(...args);
    waiterSignal = args[2];
    waiting = pending.then(
      (result) => {
        waiterSettled = true;
        return result;
      },
      (error) => {
        waiterSettled = true;
        throw error;
      },
    );
    entered.resolve();
    return waiting;
  };
  let prompting: Promise<void> | undefined;
  let parentRequests = 0;
  const unexpectedRequests: string[] = [];
  try {
    const started = await f.invoke("spawn_subagent", {
      prompt: "held-child",
      background: true,
      allowedTools: [],
    });
    const id = (started.details as { id: string }).id;
    await withTimeout(f.started, "Background child did not start");
    session.agent.streamFunction = (model, _context, options) => {
      parentRequests++;
      const events = createAssistantMessageEventStream();
      const response = {
        ...fauxAssistantMessage(""),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      if (options?.signal?.aborted) {
        if (parentRequests > 2) unexpectedRequests.push(`Excess request: ${parentRequests}`);
        response.stopReason = "aborted";
        response.errorMessage = "Parent cancellation settled";
        events.push({ type: "error", reason: "aborted", error: response });
      } else if (parentRequests === 1) {
        response.stopReason = "toolUse";
        response.content = [
          {
            type: "toolCall",
            id: "wait",
            name: "get_subagent_result",
            arguments: { id, wait: true },
          },
        ];
        events.push({ type: "done", reason: "toolUse", message: response });
      } else {
        response.stopReason = "error";
        response.errorMessage = `Unexpected non-aborted parent request: ${parentRequests}`;
        unexpectedRequests.push(response.errorMessage);
        events.push({ type: "error", reason: "error", error: response });
      }
      events.end();
      return events;
    };
    prompting = session.prompt("Wait for the background result");
    await withTimeout(entered.promise, "Foreground waiter did not enter execute");
    expect(waiting).toBeDefined();
    expect(waiterSignal?.aborted).toBe(false);
    expect(waiterSettled).toBe(false);
    await withTimeout(session.abort(), "Parent abort remained blocked on its background child");
    await withTimeout(prompting, "Parent prompt did not settle");
    expect(waiterSettled).toBe(true);
    expect(waiterSignal?.aborted).toBe(true);
    expect(unexpectedRequests).toEqual([]);
    expect(f.signal?.aborted).toBe(false);
    expect((await f.invoke("get_subagent_result", { id })).details).toMatchObject({
      id,
      status: "running",
    });
    f.release();
    expect(
      (
        await withTimeout(
          f.invoke("get_subagent_result", { id, wait: true }),
          "Child did not finish",
        )
      ).details,
    ).toMatchObject({ id, status: "completed" });
    expect(f.errors).toEqual([]);
  } finally {
    waiter.execute = originalExecute;
    f.release();
    try {
      await withTimeout(Promise.all([session.abort(), prompting]), "Parent cleanup did not settle");
    } finally {
      await withTimeout(f.close(), "Lifecycle fixture cleanup did not settle");
    }
  }
}, 15_000);

// WHEN the real SDK changes branches, descendants SHALL settle before navigation completes;
// another live SDK runtime SHALL retain its independently owned task.
test("offline SDK tree navigation waits for children, denies late spawns and isolates owners", async () => {
  const first = await fixture();
  const other = await fixture();
  try {
    const manager = first.runtime.session.sessionManager;
    const root = manager.appendCustomEntry("fixture-root", {});
    manager.appendCustomEntry("fixture-leaf", {});
    await first.invoke("spawn_subagent", {
      prompt: "held-child",
      background: true,
      allowedTools: [],
    });
    const second = await other.invoke("spawn_subagent", {
      prompt: "held-child",
      background: true,
      allowedTools: [],
    });
    await withTimeout(
      Promise.all([first.started, other.started]),
      "offline children did not start",
    );
    let navigated = false;
    const transition = first.runtime.session.navigateTree(root).then((result) => {
      navigated = true;
      return result;
    });
    await withTimeout(first.aborted, "tree transition did not abort its child");
    expect(navigated).toBe(false);
    expect(
      (await first.invoke("spawn_subagent", { prompt: "late", background: true, allowedTools: [] }))
        .details,
    ).toMatchObject({ status: "error" });
    expect(first.requests).toBe(1);
    expect(other.signal?.aborted).toBe(false);
    expect(
      (await other.invoke("get_subagent_result", { id: (second.details as { id: string }).id }))
        .details,
    ).toMatchObject({ status: "running" });
    first.release();
    expect(await withTimeout(transition, "tree transition did not settle")).toMatchObject({
      cancelled: false,
    });
    expect((await first.invoke("list_subagents")).details).toMatchObject({ count: 0 });
    expect(
      (await first.invoke("spawn_subagent", { prompt: "fresh-child", allowedTools: [] })).details,
    ).toMatchObject({ status: "completed" });
    expect(first.requests).toBe(2);
    // Background cancellation never sends a message or wakes the owner.
    expect(first.runtime.session.messages).toHaveLength(0);
    expect(other.signal?.aborted).toBe(false);
    expect(first.errors).toEqual([]);
    expect(other.errors).toEqual([]);
  } finally {
    first.release();
    other.release();
    await first.close();
    await other.close();
  }
}, 15_000);

// WHEN another extension vetoes a transition, the unchanged SDK session SHALL remain usable.
test("offline SDK cancelled switch/fork/tree recover, and successful replacement rejects old tools", async () => {
  const f = await fixture();
  try {
    const session = f.runtime.session;
    const root = session.sessionManager.appendCustomEntry("fixture-root", {});
    session.sessionManager.appendCustomEntry("fixture-leaf", {});
    for (const reason of ["switch", "fork", "tree"] as const) {
      await f.invoke("spawn_subagent", { prompt: "before-veto", allowedTools: [] });
      f.cancelNext(reason);
      const result =
        reason === "switch"
          ? await f.runtime.newSession()
          : reason === "fork"
            ? await f.runtime.fork(root, { position: "at" })
            : await session.navigateTree(root);
      expect(result.cancelled).toBe(true);
      expect(f.runtime.session).toBe(session);
      expect(
        (await f.invoke("spawn_subagent", { prompt: "after-veto", allowedTools: [] })).details,
      ).toMatchObject({ status: "completed" });
    }
    f.cancelNext(undefined);
    const stale = session.getToolDefinition("spawn_subagent")!;
    const staleContext = session.extensionRunner.createToolContext("late", undefined);
    expect((await f.runtime.fork(root, { position: "at" })).cancelled).toBe(false);
    expect(f.runtime.session).not.toBe(session);
    expect(
      (
        await stale.execute(
          "late",
          { prompt: "late", allowedTools: [] },
          undefined,
          undefined,
          staleContext,
        )
      ).details,
    ).toMatchObject({ status: "error" });
    expect(
      (await f.invoke("spawn_subagent", { prompt: "after-fork", allowedTools: [] })).details,
    ).toMatchObject({ status: "completed" });
    expect((await f.runtime.newSession()).cancelled).toBe(false);
    expect(
      (await f.invoke("spawn_subagent", { prompt: "after-new", allowedTools: [] })).details,
    ).toMatchObject({ status: "completed" });
    expect(f.errors).toEqual([]);
  } finally {
    await f.close();
  }
}, 15_000);
