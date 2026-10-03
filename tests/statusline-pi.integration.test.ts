import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionMode,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";

type FooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;

async function fixture(mode: ExtensionMode = "tui") {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "statusline-pi-日本語-")));
  let session: AgentSession | undefined;
  let footer: ReturnType<FooterFactory> | undefined;
  const errors: string[] = [];
  const events: string[] = [];
  const requests: string[] = [];
  const branchListeners = new Set<() => void>();
  let installs = 0;
  let clears = 0;
  let renders = 0;
  let branch = "feature/日本語";
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "offline-fixture-only");
    const physical = modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
    modelRuntime.registerVirtualModel({
      provider: "statusline-fixture",
      id: "router",
      name: "Fixture Router",
      thinkingLevels: ["off", "high"],
      contextWindow: physical.contextWindow * 4,
      route: () => ({ model: physical, thinkingLevel: "high" }),
    });
    const virtual = modelRuntime.getModel("statusline-fixture", "router")!;
    // Keep Pi's model routing, transcript, usage accounting, and lifecycle real.
    // Only the physical provider's transport is replaced; no LLM or network is used.
    modelRuntime.getProvider(physical.provider)!.streamSimple = (model) => {
      requests.push(`${model.provider}/${model.id}`);
      const stream = createAssistantMessageEventStream();
      const response = {
        ...fauxAssistantMessage("Offline response."),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      response.usage.input = physical.contextWindow * 0.4;
      response.usage.totalTokens = response.usage.input;
      stream.push({ type: "done", reason: "stop", message: response });
      stream.end();
      return stream;
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
        fileURLToPath(new URL("../extensions/statusline/index.ts", import.meta.url)),
      ],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      settingsManager,
      modelRuntime,
      model: virtual,
      thinkingLevel: "high",
      sessionManager: SessionManager.inMemory(cwd),
      resourceLoader: loader,
      tools: [],
    }));
    const current = session;
    current.subscribe((event) => events.push(event.type));
    const baseUI = current.extensionRunner.getUIContext();
    const ui: ExtensionUIContext = {
      ...baseUI,
      setFooter(factory) {
        footer?.dispose?.();
        footer = undefined;
        if (!factory) {
          clears++;
          return;
        }
        installs++;
        // No terminal is started: only the renderer and its invalidation boundary are needed.
        footer = factory({ requestRender: () => renders++ } as unknown as TUI, baseUI.theme, {
          getGitBranch: () => branch,
          getExtensionStatuses: () => new Map(),
          onBranchChange(callback) {
            branchListeners.add(callback);
            return () => branchListeners.delete(callback);
          },
        });
      },
    };
    async function bind() {
      await current.bindExtensions({
        mode,
        uiContext: ui,
        onError: (event) => errors.push(event.error),
      });
      expect(errors).toEqual([]);
    }
    await bind();
    return {
      cwd,
      session: current,
      physical,
      virtual,
      requests,
      events,
      errors,
      branchListeners,
      bind,
      get installs() {
        return installs;
      },
      get clears() {
        return clears;
      },
      get renders() {
        return renders;
      },
      render(width = 240) {
        expect(footer).toBeDefined();
        const lines = footer!.render(width);
        expect(lines).toHaveLength(1);
        expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
        return stripTerminalSequences(lines[0]!);
      },
      changeBranch(value: string) {
        branch = value;
        for (const listener of branchListeners) listener();
      },
      async close() {
        await current.abort();
        await current.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        current.dispose();
        footer?.dispose?.();
        rmSync(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    footer?.dispose?.();
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

test("WHEN a virtual model routes a real SDK turn, the footer SHALL use Pi's physical context percentage and render one bounded line", async () => {
  const h = await fixture();
  try {
    expect(h.installs).toBe(1);
    expect(h.render()).toMatch(/^\d{1,2}:\d{2}:\d{2} \| /);
    expect(h.render()).toContain(`${basename(h.cwd)} on  feature/日本語 via Fixture Router・high`);
    expect(h.render()).not.toContain(" took ");

    await h.session.prompt("Reply offline.");
    await h.session.waitForIdle();
    expect(h.errors).toEqual([]);
    expect(h.events).toContain("agent_settled");
    expect(h.requests).toEqual([`${h.physical.provider}/${h.physical.id}`]);
    expect(h.session.model).toBe(h.virtual);
    const usage = h.session.getContextUsage()!;
    expect(usage.contextWindow).toBe(h.physical.contextWindow);
    expect(Math.round(usage.percent!)).toBe(40);
    expect(Math.round((usage.tokens! / h.virtual.contextWindow) * 100)).toBe(10);
    expect(h.render()).toMatch(/Fixture Router・high took \d+s \| ctx ● 40%$/);

    const beforeBranch = h.renders;
    h.changeBranch("main");
    expect(h.renders).toBeGreaterThan(beforeBranch);
    expect(h.render()).toContain(" on  main ");
    for (const width of [1, 8, 25, 60, 100]) h.render(width);

    const beforeModel = h.renders;
    await h.session.setModel(h.physical);
    expect(h.renders).toBeGreaterThan(beforeModel);
    expect(h.render()).toContain(`via ${h.physical.name}・high`);
    h.session.setThinkingLevel("off");
    expect(h.render()).toContain(`via ${h.physical.name}・off`);

    // Native compaction entries make Pi report unknown usage until a fresh response.
    h.session.sessionManager.appendCompaction("Offline summary", null, usage.tokens!);
    expect(h.session.getContextUsage()?.percent).toBeNull();
    expect(h.render()).not.toContain("ctx ●");

    // bindExtensions emits the SDK session_start event, resetting settled duration.
    await h.bind();
    expect(h.render()).not.toContain(" took ");
    expect(h.branchListeners.size).toBe(1);
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(h.clears).toBe(1);
    expect(h.branchListeners.size).toBe(0);
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);

for (const mode of ["rpc", "print", "json"] as const) {
  test(`WHEN Pi binds ${mode} mode with a UI adapter, statusline SHALL NOT install a terminal footer`, async () => {
    const h = await fixture(mode);
    try {
      expect(h.session.extensionRunner.createContext().mode).toBe(mode);
      expect(h.installs).toBe(0);
      expect(h.branchListeners.size).toBe(0);
      await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(h.clears).toBe(0);
      expect(h.errors).toEqual([]);
    } finally {
      await h.close();
    }
  }, 15000);
}
