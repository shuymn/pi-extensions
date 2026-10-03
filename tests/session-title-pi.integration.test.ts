import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Model,
  type Provider,
  type ProviderAuth,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { withTimeout } from "./support/async";
import { isolateEnvVars } from "./support/env";

type Stream = Provider["streamSimple"];
type Request = {
  model: Parameters<Stream>[0];
  context: Parameters<Stream>[1];
  options: Parameters<Stream>[2];
};
const TITLE_PROVIDER = "session-title-offline";
const titleModel: Model<"session-title-offline-api"> = {
  id: "title-model",
  name: "Offline Title Model",
  provider: TITLE_PROVIDER,
  // Intentionally not in the global API dispatcher: only the session's native provider owns it.
  api: "session-title-offline-api",
  baseUrl: "https://offline.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};
const mainModel = { ...titleModel, id: "main-model", provider: "session-title-parent" };

function apiKeyAuth(resolve: NonNullable<ProviderAuth["apiKey"]>["resolve"]): ProviderAuth {
  return {
    apiKey: {
      name: "Offline authentication",
      // Availability checks must not perform request-time work.
      check: async () => ({ type: "api_key", source: "offline fixture" }),
      resolve,
    },
  };
}

function responseStream(model: Request["model"], message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  const response = { ...message, api: model.api, provider: model.provider, model: model.id };
  if (response.stopReason === "pending") throw new Error("Fixture response must be terminal");
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    stream.push({ type: "error", reason: response.stopReason, error: response });
  } else {
    stream.push({ type: "done", reason: response.stopReason, message: response });
  }
  stream.end();
  return stream;
}

function titleResponse(): AssistantMessage {
  return {
    ...fauxAssistantMessage(""),
    stopReason: "toolUse",
    content: [
      {
        type: "toolCall",
        id: "title-1",
        name: "set_session_title",
        arguments: { title: "ネイティブ認証の修正" },
      },
    ],
  };
}

async function flushBackgroundWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function fixture(
  options: {
    auth?: ProviderAuth;
    credentials?: InMemoryCredentialStore;
    stream?: Stream;
    modelSpec?: string;
  } = {},
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "session-title-pi-")));
  process.env.PI_CODING_AGENT_DIR = cwd;
  let session: AgentSession | undefined;
  const titleRequests: Request[] = [];
  const parentRequests: Request[] = [];
  const errors: string[] = [];
  const requested = Promise.withResolvers<Request>();
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "session-title": { model: options.modelSpec ?? `${TITLE_PROVIDER}/title-model:medium` },
      }),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const runtime = await ModelRuntime.create({
      credentials: options.credentials ?? new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const mainStream: Stream = (model, context, requestOptions) => {
      parentRequests.push({ model, context, options: requestOptions });
      return responseStream(model, fauxAssistantMessage("Parent completed offline."));
    };
    runtime.registerNativeProvider({
      id: mainModel.provider,
      name: "Offline Parent",
      auth: apiKeyAuth(async () => ({ auth: {} })),
      getModels: () => [mainModel],
      stream() {
        throw new Error("Fixture expects provider-neutral streamSimple");
      },
      streamSimple: mainStream,
    });
    const titleStream: Stream = (model, context, requestOptions) => {
      const request = { model, context, options: requestOptions };
      titleRequests.push(request);
      requested.resolve(request);
      return (
        options.stream?.(model, context, requestOptions) ?? responseStream(model, titleResponse())
      );
    };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [
        fileURLToPath(new URL("../extensions/session-title/index.ts", import.meta.url)),
      ],
      extensionFactories: [
        (pi) => {
          // Register through the real extension runtime, not the global API dispatcher.
          pi.registerProvider({
            id: TITLE_PROVIDER,
            name: "Offline Title Provider",
            auth: options.auth ?? apiKeyAuth(async () => ({ auth: {}, source: "keyless local" })),
            getModels: () => [titleModel],
            stream() {
              throw new Error("Fixture expects provider-neutral streamSimple");
            },
            streamSimple: titleStream,
          });
        },
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model: mainModel,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader: loader,
      tools: [],
    }));
    const current = session;
    await current.bindExtensions({ mode: "print", onError: (event) => errors.push(event.error) });
    return {
      session: current,
      runtime,
      titleRequests,
      parentRequests,
      errors,
      requested: requested.promise,
      async prompt() {
        await current.prompt("ネイティブ認証を修正してください");
        await flushBackgroundWork();
        expect(errors).toEqual([]);
      },
      async waitForTitle() {
        let waiting = true;
        try {
          await withTimeout(
            (async () => {
              while (waiting && !current.sessionName) await flushBackgroundWork();
            })(),
            "session title was not generated",
          );
        } finally {
          waiting = false;
        }
      },
      async shutdown() {
        await current.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await flushBackgroundWork();
      },
      async close() {
        await current.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await current.abort();
        current.dispose();
        rmSync(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

describe("session-title with the native Pi SDK", () => {
  isolateEnvVars(["PI_CODING_AGENT_DIR", "PI_SESSION_TITLE_TEST_PROFILE"]);

  test.each([
    ["keyless", undefined, "medium", "medium"],
    ["stored non-ASCII key", "鍵・offline", "off", undefined],
  ] as const)("WHEN title generation uses %s auth, native dispatch SHALL preserve auth and model settings without changing the conversation model", async (_label, key, thinking, reasoning) => {
    const credentials = new InMemoryCredentialStore();
    if (key) {
      await credentials.modify(TITLE_PROVIDER, async () => ({ type: "api_key", key }));
    }
    const h = await fixture({
      credentials,
      modelSpec: `${TITLE_PROVIDER}/title-model:${thinking}`,
      auth: apiKeyAuth(async ({ credential }) => ({ auth: { apiKey: credential?.key } })),
    });
    try {
      await h.prompt();
      await h.waitForTitle();
      expect(h.session.sessionName).toBe("ネイティブ認証の修正");
      expect(h.titleRequests).toHaveLength(1);
      const request = h.titleRequests[0]!;
      expect(request.model).toMatchObject({ provider: TITLE_PROVIDER, id: "title-model" });
      expect(request.options?.reasoning).toBe(reasoning);
      expect(request.options?.timeoutMs).toBe(15000);
      expect(request.options?.apiKey).toBe(key);
      expect(getCurrentTools(request.context.messages).map((tool) => tool.name)).toEqual([
        "set_session_title",
      ]);
      expect(request.context.messages.at(-1)).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "ネイティブ認証を修正してください" }],
      });
      expect(h.session.model?.provider).toBe(mainModel.provider);
      expect(h.parentRequests).toHaveLength(1);
      expect(getCurrentTools(h.parentRequests[0]!.context.messages)).toEqual([]);
      expect(JSON.stringify(h.session.messages)).not.toContain("set_session_title");
      expect(h.session.getLastAssistantText()).toBe("Parent completed offline.");
    } finally {
      await h.close();
    }
  });

  test("WHEN ambient auth supplies only headers, endpoint and provider env, title generation SHALL preserve all request-time auth fields", async () => {
    process.env.PI_SESSION_TITLE_TEST_PROFILE = "offline-profile";
    let resolutions = 0;
    const h = await fixture({
      auth: apiKeyAuth(async ({ ctx }) => {
        resolutions++;
        return {
          auth: { headers: { "x-session-auth": "ambient" }, baseUrl: "https://ambient.invalid" },
          env: { PROFILE: (await ctx.env("PI_SESSION_TITLE_TEST_PROFILE"))! },
          source: "ambient profile",
        };
      }),
    });
    try {
      expect(resolutions).toBe(0);
      await h.prompt();
      await h.waitForTitle();
      expect(resolutions).toBe(1);
      expect(h.titleRequests[0]!.model.baseUrl).toBe("https://ambient.invalid");
      expect(h.titleRequests[0]!.options).toMatchObject({
        headers: { "x-session-auth": "ambient" },
        env: { PROFILE: "offline-profile" },
      });
      expect(h.titleRequests[0]!.options?.apiKey).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  for (const failRefresh of [false, true]) {
    test(`WHEN OAuth refresh ${failRefresh ? "fails" : "returns header-only auth"}, title generation SHALL ${failRefresh ? "remain best-effort without falling back" : "use the refreshed native authentication"}`, async () => {
      const credentials = new InMemoryCredentialStore();
      await credentials.modify(TITLE_PROVIDER, async () => ({
        type: "oauth",
        access: "expired",
        refresh: "offline-refresh",
        expires: 0,
      }));
      let refreshes = 0;
      let ambientResolutions = 0;
      const h = await fixture({
        credentials,
        auth: {
          ...apiKeyAuth(async () => {
            ambientResolutions++;
            return { auth: { apiKey: "must-not-fallback" } };
          }),
          oauth: {
            name: "Offline OAuth",
            login: async () => {
              throw new Error("Offline login must not run");
            },
            refresh: async (credential) => {
              refreshes++;
              if (failRefresh) throw new Error("invalid_grant");
              return { ...credential, access: "refreshed", expires: Date.now() + 3600000 };
            },
            toAuth: async (credential) => ({
              headers: { Authorization: `Bearer ${credential.access}` },
            }),
          },
        },
      });
      try {
        expect(refreshes).toBe(0);
        await h.prompt();
        expect(refreshes).toBe(1);
        expect(ambientResolutions).toBe(0);
        if (failRefresh) {
          expect(h.session.sessionName).toBeUndefined();
          expect(h.titleRequests).toEqual([]);
        } else {
          await h.waitForTitle();
          expect(h.titleRequests[0]!.options?.headers).toMatchObject({
            Authorization: "Bearer refreshed",
          });
          expect(h.titleRequests[0]!.options?.apiKey).toBeUndefined();
          expect((await credentials.read(TITLE_PROVIDER))?.type).toBe("oauth");
        }
        expect(h.session.getLastAssistantText()).toBe("Parent completed offline.");
      } finally {
        await h.close();
      }
    });
  }

  test("WHEN the configured model is absent, title generation SHALL NOT silently select a different provider", async () => {
    const h = await fixture({ modelSpec: `${TITLE_PROVIDER}/missing-model` });
    try {
      await h.prompt();
      expect(h.titleRequests).toEqual([]);
      expect(h.parentRequests).toHaveLength(1);
      expect(h.session.sessionName).toBeUndefined();
      expect(h.session.model?.provider).toBe(mainModel.provider);
    } finally {
      await h.close();
    }
  });

  test("WHEN the native provider has no usable auth, title generation SHALL remain best-effort", async () => {
    const h = await fixture({ auth: apiKeyAuth(async () => undefined) });
    try {
      await h.prompt();
      expect(h.titleRequests).toEqual([]);
      expect(h.session.sessionName).toBeUndefined();
      expect(h.session.getLastAssistantText()).toBe("Parent completed offline.");
    } finally {
      await h.close();
    }
  });

  for (const stopReason of ["error", "aborted"] as const) {
    test(`WHEN a native stream terminates with ${stopReason}, title generation SHALL discard even valid partial title content`, async () => {
      const h = await fixture({
        stream: (model) =>
          responseStream(model, {
            ...titleResponse(),
            stopReason,
            errorMessage: "Offline provider failure",
          }),
      });
      try {
        await h.prompt();
        expect(h.titleRequests).toHaveLength(1);
        expect(h.session.sessionName).toBeUndefined();
      } finally {
        await h.close();
      }
    });
  }

  test("WHEN the session shuts down during request-time auth, title generation SHALL cancel auth and never dispatch the provider", async () => {
    const authStarted = Promise.withResolvers<AbortSignal>();
    const h = await fixture({
      auth: apiKeyAuth(async ({ signal }) => {
        authStarted.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        // Even a late auth resolution must not dispatch into the closed session.
        return { auth: {} };
      }),
    });
    try {
      await h.prompt();
      const signal = await withTimeout(authStarted.promise, "native auth did not start");
      expect(signal.aborted).toBe(false);
      await h.shutdown();
      expect(signal.aborted).toBe(true);
      expect(h.titleRequests).toEqual([]);
      expect(h.session.sessionName).toBeUndefined();
    } finally {
      await h.close();
    }
  });

  test("WHEN the session shuts down during native streaming, title generation SHALL abort that stream without naming the session", async () => {
    const finished = Promise.withResolvers<void>();
    const h = await fixture({
      stream: (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        options!.signal!.addEventListener(
          "abort",
          () => {
            const response = {
              ...titleResponse(),
              api: model.api,
              provider: model.provider,
              model: model.id,
              stopReason: "aborted" as const,
              errorMessage: "Cancelled",
            };
            stream.push({ type: "error", reason: "aborted", error: response });
            stream.end();
            finished.resolve();
          },
          { once: true },
        );
        return stream;
      },
    });
    try {
      await h.prompt();
      const request = await withTimeout(h.requested, "native stream did not start");
      expect(request.options?.signal?.aborted).toBe(false);
      await h.shutdown();
      await withTimeout(finished.promise, "native stream did not abort");
      expect(request.options?.signal?.aborted).toBe(true);
      expect(h.session.sessionName).toBeUndefined();
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
