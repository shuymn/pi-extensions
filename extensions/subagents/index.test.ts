import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTypeboxMock } from "../../tests/support/typebox-mock";

let uuidCounter = 0;
mock.module("node:crypto", () => ({
  randomUUID: () => `id${String(++uuidCounter).padStart(6, "0")}-0000-4000-8000-000000000000`,
  randomBytes: (size: number) => Buffer.alloc(size),
}));

installTypeboxMock();

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[], options = {}) => ({ enum: values, ...options }),
}));

type Subscriber = (event: any) => void;
type SessionBehavior = {
  resultText?: string;
  promptError?: Error;
  promptStopReason?: string;
  promptErrorMessage?: string;
  blockPrompt?: boolean;
  initialMessages?: Array<{ role: string; content: unknown }>;
  disposeError?: Error;
};
type CreatedSession = any;

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate:
      | ((result: {
          content: Array<{ type: "text"; text: string }>;
          details: Record<string, unknown>;
        }) => void)
      | undefined,
    ctx: FakeContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }>;
};
type EventHandler = (event: unknown, ctx: FakeContext) => Promise<void> | void;
type FakeContext = ReturnType<typeof createContext>;

const createAgentSessionCalls: any[] = [];
const loaderInstances: any[] = [];
const createdSessions: CreatedSession[] = [];
const createdPis: any[] = [];
const tempDirs: string[] = [];
let nextBehaviors: SessionBehavior[] = [];

const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

const INVESTIGATION_TOOL_NAMES = [
  "tavily_search",
  "tavily_extract",
  "tavily_map",
  "tavily_crawl",
  "tavily_auth_status",
  "github_clone_workspace",
];
const SORTED_INVESTIGATION_TOOL_NAMES = [
  "github_clone_workspace",
  "tavily_auth_status",
  "tavily_crawl",
  "tavily_extract",
  "tavily_map",
  "tavily_search",
];
const DEFAULT_SUBAGENT_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  ...INVESTIGATION_TOOL_NAMES,
];
const READ_ONLY_SUBAGENT_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  ...INVESTIGATION_TOOL_NAMES,
];
const DELEGATION_TOOL_NAME = "spawn_subagent";
const SORTED_DELEGATING_INVESTIGATION_TOOL_NAMES = [
  ...SORTED_INVESTIGATION_TOOL_NAMES,
  DELEGATION_TOOL_NAME,
].sort();
const DEFAULT_DELEGATING_SUBAGENT_TOOL_NAMES = [
  ...DEFAULT_SUBAGENT_TOOL_NAMES,
  DELEGATION_TOOL_NAME,
];
const READ_ONLY_DELEGATING_SUBAGENT_TOOL_NAMES = [
  ...READ_ONLY_SUBAGENT_TOOL_NAMES,
  DELEGATION_TOOL_NAME,
];
const EXCLUDED_TOOL_NAMES = [
  "deep_research",
  "tavily_research",
  "workflow",
  "review",
  "todo",
  "get_subagent_result",
  "stop_subagent",
  "list_subagents",
  "ask_user_question",
  "structured_output",
];

function createSession(behavior: SessionBehavior) {
  const subscribers: Subscriber[] = [];
  let name = "";
  let aborted = false;
  let disposed = false;
  let releasePrompt: (() => void) | undefined;
  const promptStarted = Promise.withResolvers<void>();

  const session = {
    messages: [...(behavior.initialMessages ?? [])],
    get name() {
      return name;
    },
    get aborted() {
      return aborted;
    },
    get disposed() {
      return disposed;
    },
    get promptStarted() {
      return promptStarted.promise;
    },
    releasePrompt() {
      releasePrompt?.();
    },
    setSessionName(value: string) {
      name = value;
    },
    subscribe(subscriber: Subscriber) {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
    async prompt(prompt: string) {
      (session as any).lastPrompt = prompt;
      promptStarted.resolve();
      for (const subscriber of subscribers) {
        subscriber({ type: "message_start" });
      }
      for (const chunk of (behavior.resultText ?? "subagent result").match(/.{1,600}/gs) ?? []) {
        for (const subscriber of subscribers) {
          subscriber({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: chunk },
          });
        }
      }
      if (behavior.blockPrompt) {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      }
      if (behavior.promptError) throw behavior.promptError;
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: behavior.resultText ?? "subagent result" }],
        ...(behavior.promptStopReason ? { stopReason: behavior.promptStopReason } : {}),
        ...(behavior.promptErrorMessage !== undefined
          ? { errorMessage: behavior.promptErrorMessage }
          : {}),
      });
    },
    async abort() {
      aborted = true;
      releasePrompt?.();
    },
    dispose() {
      disposed = true;
      if (behavior.disposeError) throw behavior.disposeError;
    },
  };
  createdSessions.push(session);
  return session;
}

mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => "/agent-dir",
  createBashToolDefinition: (_cwd: string, _options?: unknown) => ({
    name: "bash",
    label: "bash",
    execute: async (..._args: unknown[]) => ({ content: [], details: undefined }),
  }),
  createLocalBashOperations: () => ({
    exec: async (_command: string, _cwd: string, _options: unknown) => ({ exitCode: 0 }),
  }),
  DefaultResourceLoader: class {
    options: unknown;
    reloaded = false;
    activeTools: string[] = [];
    allowedTools = new Set<string>();
    eventHandlers = new Map<string, Array<() => void>>();
    registeredTools = new Set<string>();
    constructor(options: unknown) {
      this.options = options;
      loaderInstances.push(this);
    }
    async reload() {
      this.reloaded = true;
      const options = this.options as {
        extensionFactories?: Array<(pi: unknown) => void>;
      };
      for (const factory of options.extensionFactories ?? []) {
        factory({
          registerTool: (tool: { name: string }) => {
            this.registeredTools.add(tool.name);
          },
          on: (eventName: string, handler: () => void) => {
            this.eventHandlers.set(eventName, [
              ...(this.eventHandlers.get(eventName) ?? []),
              handler,
            ]);
          },
          getActiveTools: () => [...this.activeTools],
          setActiveTools: (tools: string[]) => {
            this.activeTools = tools.filter(
              (tool) =>
                this.allowedTools.has(tool) &&
                (BUILTIN_TOOLS.has(tool) || this.registeredTools.has(tool)),
            );
          },
        });
      }
    }
  },
  SessionManager: {
    inMemory: (cwd: string) => ({ kind: "in-memory", cwd }),
  },
  SettingsManager: {
    create: (cwd: string, agentDir: string) => ({ cwd, agentDir }),
  },
  createAgentSession: async (options: any) => {
    createAgentSessionCalls.push(options);
    const loader = options.resourceLoader;
    loader.allowedTools = new Set(options.tools ?? []);
    // Register custom tools via the same path as extension-factory registered tools
    for (const customTool of options.customTools ?? []) {
      loader.registeredTools.add(customTool.name);
    }
    loader.activeTools = (options.tools ?? []).filter(
      (tool: string) => BUILTIN_TOOLS.has(tool) || loader.registeredTools.has(tool),
    );
    for (const handler of loader.eventHandlers.get("session_start") ?? []) {
      handler();
    }
    const session = createSession(nextBehaviors.shift() ?? {});
    (session as any).activeTools = loader.activeTools;
    (session as any).registeredTools = [...loader.registeredTools].sort();
    (session as any).customTools = options.customTools ?? [];
    return { session };
  },
}));

function createFakePi() {
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, EventHandler[]>();
  let thinkingLevel = "medium";

  const pi = {
    tools,
    events,
    setThinkingLevel(value: string) {
      thinkingLevel = value;
    },
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    on(eventName: string, handler: EventHandler) {
      events.set(eventName, [...(events.get(eventName) ?? []), handler]);
    },
    getThinkingLevel: () => thinkingLevel,
  };
  createdPis.push(pi);
  return pi;
}

type ContextOverrides = Partial<{
  cwd: string;
  modelRegistry: { id: string; find?: (provider: string, model: string) => unknown };
  model: unknown;
  getSystemPrompt: () => string;
}>;

function tempProjectSettings(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), `${JSON.stringify(settings)}\n`, "utf8");
  return dir;
}

function createContext(overrides: ContextOverrides = {}) {
  return {
    cwd: "/repo",
    modelRegistry: { id: "registry" },
    model: { name: "model" },
    getSystemPrompt: () => "parent system prompt",
    ...overrides,
  };
}

async function loadExtension() {
  return (await import("./index")).default;
}

async function waitForCreatedSession(index = 0): Promise<CreatedSession> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (createdSessions[index]) return createdSessions[index];
    await Promise.resolve();
  }
  throw new Error(`session ${index} was not created`);
}

function findDelegationTool(session: CreatedSession): ToolDefinition {
  const tool = session.customTools.find(
    (candidate: ToolDefinition) => candidate.name === DELEGATION_TOOL_NAME,
  );
  if (!tool) throw new Error("spawn_subagent tool not found");
  return tool;
}

async function cleanupRecords() {
  for (const session of createdSessions) session.releasePrompt();
  for (const pi of createdPis) {
    const handler = pi.events.get("session_shutdown")?.[0];
    if (handler) await handler({}, createContext());
  }
  createdPis.splice(0);
}

afterEach(async () => {
  await cleanupRecords();
  uuidCounter = 0;
  nextBehaviors = [];
  createAgentSessionCalls.splice(0);
  loaderInstances.splice(0);
  createdSessions.splice(0);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("subagents extension", () => {
  test("registers four subagent tools and shutdown cleanup hook", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();

    extension(pi as never);

    expect([...pi.tools.keys()].sort()).toEqual([
      "get_subagent_result",
      "list_subagents",
      "spawn_subagent",
      "stop_subagent",
    ]);
    expect([...pi.events.keys()]).toEqual(["session_shutdown"]);
    expect(pi.tools.get("spawn_subagent")!.parameters).toMatchObject({
      type: "object",
      properties: {
        prompt: { type: "string" },
        background: { type: "boolean", optional: true },
        readOnly: { type: "boolean", optional: true },
      },
    });
    expect(pi.tools.get("spawn_subagent")!.parameters).toMatchObject({
      properties: {
        modelTier: { enum: ["medium", "small"], optional: true },
      },
    });
    expect(pi.tools.get("spawn_subagent")!.description).toContain(
      "Default subagents receive read, grep, find, ls, bash, edit, write, tavily_search, tavily_extract, tavily_map, tavily_crawl, tavily_auth_status, github_clone_workspace, and spawn_subagent",
    );
    expect(pi.tools.get("spawn_subagent")!.description).toContain(
      "Top-level calls inherit the current model unless modelTier is explicitly set",
    );
    expect(pi.tools.get("spawn_subagent")!.description).toContain(
      "delegated calls from an isolated session default omitted modelTier to medium",
    );
    expect(pi.tools.get("spawn_subagent")!.description).toContain(
      "Reserve small for bounded, easy-to-check investigation whose output will be verified before use",
    );
    expect(pi.tools.get("spawn_subagent")!.description).toContain(
      "within one additional delegation level",
    );
    expect(pi.tools.get("spawn_subagent")!.description).toContain(
      "Use get_subagent_result to check status or retrieve the result.",
    );
    expect(pi.tools.get("spawn_subagent")!.description).not.toContain("notifies when complete");
    expect(
      (pi.tools.get("spawn_subagent")!.parameters as any).properties.background.description,
    ).toContain("use get_subagent_result to check status or retrieve the result");
    expect(
      (pi.tools.get("spawn_subagent")!.parameters as any).properties.modelTier.description,
    ).toContain(
      'Use "small" only for bounded, easy-to-check investigation such as candidate discovery, file search, enumeration, or collecting possible counterexamples; verify results before relying on them.',
    );
  });

  test("foreground spawn runs an isolated subagent session and returns streamed result", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    pi.setThinkingLevel("high");
    extension(pi as never);
    nextBehaviors = [{ resultText: "final answer" }];
    const updates: string[] = [];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Investigate this", description: "Investigation" },
        undefined,
        (update: { content: Array<{ type: "text"; text: string }> }) =>
          updates.push(update.content[0].text),
        createContext(),
      );

    expect(result).toEqual({
      content: [{ type: "text", text: "final answer" }],
      details: { id: "id000001", status: "completed" },
    });
    expect(updates).toEqual(["Subagent id000001 running...\n\nfinal answer"]);
    expect(createdSessions[0].name).toBe("subagent#id000001");
    expect(createdSessions[0].disposed).toBe(true);
    expect(createdSessions[0].registeredTools).toEqual(SORTED_DELEGATING_INVESTIGATION_TOOL_NAMES);
    expect(createdSessions[0].activeTools).toEqual(DEFAULT_DELEGATING_SUBAGENT_TOOL_NAMES);
    expect(createAgentSessionCalls[0]).toMatchObject({
      cwd: "/repo",
      agentDir: "/agent-dir",
      thinkingLevel: "high",
      tools: DEFAULT_DELEGATING_SUBAGENT_TOOL_NAMES,
      model: { name: "model" },
      modelRegistry: { id: "registry" },
    });
    expect(
      createAgentSessionCalls[0].customTools.map((tool: { name: string }) => tool.name),
    ).toEqual([...INVESTIGATION_TOOL_NAMES, DELEGATION_TOOL_NAME]);
    for (const excluded of EXCLUDED_TOOL_NAMES) {
      expect(createAgentSessionCalls[0].tools).not.toContain(excluded);
      expect(createdSessions[0].registeredTools).not.toContain(excluded);
    }
    expect(loaderInstances[0].reloaded).toBe(true);
    expect(loaderInstances[0].options.noExtensions).toBe(true);
    expect(loaderInstances[0].options.extensionFactories).toEqual([]);
    expect(loaderInstances[0].options.systemPromptOverride()).toContain("parent system prompt");
    expect(loaderInstances[0].options.systemPromptOverride()).toContain("Working directory: /repo");
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      "Default sessions have read, grep, find, ls, bash, edit, write, tavily_search, tavily_extract, tavily_map, tavily_crawl, tavily_auth_status, github_clone_workspace, and spawn_subagent.",
    );
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      "When an independent focused check would materially improve quality or confidence, you may use spawn_subagent.",
    );
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      "Verify and integrate delegated results before relying on them.",
    );
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      "Use small only for bounded, easy-to-check investigation such as candidate discovery, file search, enumeration, or collecting possible counterexamples.",
    );
    expect(loaderInstances[0].options.systemPromptOverride()).not.toContain(
      "Do not call or simulate subagents recursively.",
    );
  });

  test("readOnly spawn restricts tools and adds read-only system prompt rule", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "read only result" }];

    await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Inspect", readOnly: true },
        undefined,
        undefined,
        createContext(),
      );

    expect(createAgentSessionCalls[0].tools).toEqual(READ_ONLY_DELEGATING_SUBAGENT_TOOL_NAMES);
    expect(
      createAgentSessionCalls[0].customTools.map((tool: { name: string }) => tool.name),
    ).toEqual([...INVESTIGATION_TOOL_NAMES, "bash", DELEGATION_TOOL_NAME]);
    expect(createdSessions[0].registeredTools).toEqual([
      "bash",
      ...SORTED_DELEGATING_INVESTIGATION_TOOL_NAMES,
    ]);
    expect(createdSessions[0].activeTools).toEqual(READ_ONLY_DELEGATING_SUBAGENT_TOOL_NAMES);
    expect(createAgentSessionCalls[0].tools).not.toContain("edit");
    expect(createAgentSessionCalls[0].tools).not.toContain("write");
    expect(loaderInstances[0].options.extensionFactories).toEqual([]);
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      "This session is read-only. Bash commands are sandboxed: repo writes are denied by the OS sandbox. Write scratch files only under /tmp or $TMPDIR. Do not attempt to edit or write files in the repository.",
    );
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      "Default sessions have read, grep, find, ls, bash, edit, write, tavily_search, tavily_extract, tavily_map, tavily_crawl, tavily_auth_status, github_clone_workspace, and spawn_subagent.",
    );
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      "Read-only sessions have read, grep, find, ls, bash, tavily_search, tavily_extract, tavily_map, tavily_crawl, tavily_auth_status, github_clone_workspace, and spawn_subagent only.",
    );
  });

  test("first-level sessions can spawn one nested session that cannot spawn further", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [
      { resultText: "top-level waiting", blockPrompt: true },
      { resultText: "nested answer" },
    ];

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Coordinate" }, undefined, undefined, createContext());
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;

    const nestedTool = findDelegationTool(firstSession);
    const nestedResult = await nestedTool.execute(
      "nested-call",
      { prompt: "Check independently" },
      undefined,
      undefined,
      createContext(),
    );

    expect(nestedResult).toEqual({
      content: [{ type: "text", text: "nested answer" }],
      details: { id: "id000002", status: "completed" },
    });
    expect(createAgentSessionCalls[1]).toMatchObject({
      model: { name: "model" },
      thinkingLevel: "medium",
    });
    expect(createAgentSessionCalls[1].tools).toEqual(DEFAULT_SUBAGENT_TOOL_NAMES);
    expect(createAgentSessionCalls[1].tools).not.toContain(DELEGATION_TOOL_NAME);
    expect(createdSessions[1].registeredTools).toEqual(SORTED_INVESTIGATION_TOOL_NAMES);
    expect(createdSessions[1].activeTools).toEqual(DEFAULT_SUBAGENT_TOOL_NAMES);
    expect(loaderInstances[1].options.systemPromptOverride()).toContain(
      "No further delegation tool is available.",
    );
    expect(loaderInstances[1].options.systemPromptOverride()).not.toContain(
      "When an independent focused check would materially improve quality or confidence",
    );
    expect(loaderInstances[1].options.systemPromptOverride()).not.toContain(
      "Do not call or simulate subagents recursively.",
    );

    firstSession.releasePrompt();
    await topLevel;
  });

  test("delegated spawn rejects background mode without creating another session", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "top-level waiting", blockPrompt: true }];

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Coordinate" }, undefined, undefined, createContext());
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;

    const nestedTool = findDelegationTool(firstSession);
    expect(nestedTool.description).toContain(
      "Background mode is not available from delegated sessions.",
    );
    expect((nestedTool.parameters as any).properties.background.description).toContain(
      "Background mode is not available from delegated sessions.",
    );

    const result = await nestedTool.execute(
      "nested-call",
      { prompt: "Background check", background: true },
      undefined,
      undefined,
      createContext(),
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Background mode is not available for delegated spawn_subagent calls. Run the delegated task in foreground mode instead.",
        },
      ],
      details: { status: "rejected", background: false },
    });
    expect(createdSessions).toHaveLength(1);
    expect(createAgentSessionCalls).toHaveLength(1);

    firstSession.releasePrompt();
    await topLevel;
  });

  test("nested sessions inherit read-only enforcement from their owner", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [
      { resultText: "top-level waiting", blockPrompt: true },
      { resultText: "nested read-only answer" },
    ];

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Read-only coordinate", readOnly: true },
        undefined,
        undefined,
        createContext(),
      );
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;

    const nestedTool = findDelegationTool(firstSession);
    expect(nestedTool.description).toContain(
      "Spawned sessions are read-only because the calling session is read-only",
    );
    expect(nestedTool.description).not.toContain(
      "Default subagents receive read, grep, find, ls, bash, edit, write",
    );
    expect((nestedTool.parameters as any).properties.readOnly.description).toContain(
      "read-only regardless of this setting",
    );

    const nestedResult = await nestedTool.execute(
      "nested-call",
      { prompt: "Inspect safely", readOnly: false },
      undefined,
      undefined,
      createContext(),
    );

    expect(nestedResult.details).toEqual({ id: "id000002", status: "completed" });
    expect(createAgentSessionCalls[1].tools).toEqual(READ_ONLY_SUBAGENT_TOOL_NAMES);
    expect(
      createAgentSessionCalls[1].customTools.map((tool: { name: string }) => tool.name),
    ).toEqual([...INVESTIGATION_TOOL_NAMES, "bash"]);
    expect(createAgentSessionCalls[1].tools).not.toContain("edit");
    expect(createAgentSessionCalls[1].tools).not.toContain("write");
    expect(createAgentSessionCalls[1].tools).not.toContain(DELEGATION_TOOL_NAME);

    firstSession.releasePrompt();
    await topLevel;
  });

  test("nested modelTier defaults to configured medium and accepts small", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    pi.setThinkingLevel("high");
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: {
        modelTiers: {
          medium: "test/medium-model:low",
          small: "test/small-model:minimal",
        },
      },
    });
    const mediumModel = { name: "medium model" };
    const smallModel = { name: "small model" };
    const findCalls: string[] = [];
    const ctx = createContext({
      cwd,
      modelRegistry: {
        id: "registry",
        find(provider: string, model: string) {
          findCalls.push(`${provider}/${model}`);
          if (provider === "test" && model === "medium-model") return mediumModel;
          if (provider === "test" && model === "small-model") return smallModel;
          return undefined;
        },
      },
    });
    nextBehaviors = [
      { resultText: "top-level waiting", blockPrompt: true },
      { resultText: "medium nested answer" },
      { resultText: "small nested answer" },
    ];

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Coordinate" }, undefined, undefined, ctx);
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;
    const nestedTool = findDelegationTool(firstSession);

    const defaultTier = await nestedTool.execute(
      "nested-call-1",
      { prompt: "Default tier check" },
      undefined,
      undefined,
      ctx,
    );
    const smallTier = await nestedTool.execute(
      "nested-call-2",
      { prompt: "Small tier check", modelTier: "small" },
      undefined,
      undefined,
      ctx,
    );

    expect(defaultTier.details).toEqual({ id: "id000002", status: "completed" });
    expect(smallTier.details).toEqual({ id: "id000003", status: "completed" });
    expect(createAgentSessionCalls[1]).toMatchObject({
      model: mediumModel,
      thinkingLevel: "low",
    });
    expect(createAgentSessionCalls[2]).toMatchObject({
      model: smallModel,
      thinkingLevel: "minimal",
    });
    expect(findCalls).toEqual(["test/medium-model", "test/small-model"]);

    firstSession.releasePrompt();
    await topLevel;
  });

  test("top-level explicit modelTier selects configured model", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    pi.setThinkingLevel("high");
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: { modelTiers: { medium: "test/medium-model:low" } },
    });
    const mediumModel = { name: "medium model" };
    const ctx = createContext({
      cwd,
      modelRegistry: {
        id: "registry",
        find: (provider: string, model: string) =>
          provider === "test" && model === "medium-model" ? mediumModel : undefined,
      },
    });
    nextBehaviors = [{ resultText: "medium answer" }];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Use configured tier", modelTier: "medium" },
        undefined,
        undefined,
        ctx,
      );

    expect(result.details).toEqual({ id: "id000001", status: "completed" });
    expect(createAgentSessionCalls[0]).toMatchObject({
      model: mediumModel,
      thinkingLevel: "low",
    });
  });

  test("modelTier arrays fall back on retryable runtime errors", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    pi.setThinkingLevel("high");
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: {
        modelTiers: {
          medium: ["test/first-model:low", "test/second-model:minimal"],
        },
      },
    });
    const firstModel = { name: "first model" };
    const secondModel = { name: "second model" };
    const ctx = createContext({
      cwd,
      modelRegistry: {
        id: "registry",
        find(provider: string, model: string) {
          if (provider === "test" && model === "first-model") return firstModel;
          if (provider === "test" && model === "second-model") return secondModel;
          return undefined;
        },
      },
    });
    nextBehaviors = [
      {
        resultText: "first failed",
        promptStopReason: "error",
        promptErrorMessage: "429 rate limit",
      },
      { resultText: "second answer" },
    ];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Use configured fallback", modelTier: "medium" },
        undefined,
        undefined,
        ctx,
      );

    expect(result).toEqual({
      content: [{ type: "text", text: "second answer" }],
      details: { id: "id000001", status: "completed" },
    });
    expect(createAgentSessionCalls).toHaveLength(2);
    expect(createAgentSessionCalls[0]).toMatchObject({
      model: firstModel,
      thinkingLevel: "low",
    });
    expect(createAgentSessionCalls[1]).toMatchObject({
      model: secondModel,
      thinkingLevel: "minimal",
    });
    expect(createdSessions[0].disposed).toBe(true);
    expect(createdSessions[1].disposed).toBe(true);
  });

  test("modelTier comma-separated mappings fall back to inherited model after candidates are exhausted", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    pi.setThinkingLevel("xhigh");
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: {
        modelTiers: {
          small: "test/first-small:minimal, test/second-small:low",
        },
      },
    });
    const inheritedModel = { name: "inherited model" };
    const firstModel = { name: "first small" };
    const secondModel = { name: "second small" };
    const ctx = createContext({
      cwd,
      model: inheritedModel,
      modelRegistry: {
        id: "registry",
        find(provider: string, model: string) {
          if (provider === "test" && model === "first-small") return firstModel;
          if (provider === "test" && model === "second-small") return secondModel;
          return undefined;
        },
      },
    });
    nextBehaviors = [
      {
        resultText: "first failed",
        promptStopReason: "error",
        promptErrorMessage: "503 service unavailable",
      },
      {
        resultText: "second failed",
        promptStopReason: "error",
        promptErrorMessage: "model unavailable",
      },
      { resultText: "inherited answer" },
    ];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Use comma-separated fallback", modelTier: "small" },
        undefined,
        undefined,
        ctx,
      );

    expect(result.details).toEqual({ id: "id000001", status: "completed" });
    expect(result.content[0].text).toBe("inherited answer");
    expect(createAgentSessionCalls).toHaveLength(3);
    expect(createAgentSessionCalls[0]).toMatchObject({
      model: firstModel,
      thinkingLevel: "minimal",
    });
    expect(createAgentSessionCalls[1]).toMatchObject({
      model: secondModel,
      thinkingLevel: "low",
    });
    expect(createAgentSessionCalls[2]).toMatchObject({
      model: inheritedModel,
      thinkingLevel: "xhigh",
    });
    expect(createdSessions[0].disposed).toBe(true);
    expect(createdSessions[1].disposed).toBe(true);
    expect(createdSessions[2].disposed).toBe(true);
  });

  test("modelTier runtime fallback stops on non-retryable errors", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: {
        modelTiers: {
          medium: ["test/first-model", "test/second-model"],
        },
      },
    });
    const firstModel = { name: "first model" };
    const secondModel = { name: "second model" };
    const ctx = createContext({
      cwd,
      modelRegistry: {
        id: "registry",
        find(provider: string, model: string) {
          if (provider === "test" && model === "first-model") return firstModel;
          if (provider === "test" && model === "second-model") return secondModel;
          return undefined;
        },
      },
    });
    nextBehaviors = [
      {
        resultText: "first failed",
        promptStopReason: "error",
        promptErrorMessage: "401 invalid api key",
      },
    ];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Do not fallback", modelTier: "medium" },
        undefined,
        undefined,
        ctx,
      );

    expect(result).toEqual({
      content: [{ type: "text", text: "Subagent error: 401 invalid api key" }],
      details: { id: "id000001", status: "error" },
    });
    expect(createAgentSessionCalls).toHaveLength(1);
    expect(createAgentSessionCalls[0]).toMatchObject({ model: firstModel });
    expect(createdSessions[0].disposed).toBe(true);
  });

  test("modelTier retry does not repeat the inherited model", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: {
        modelTiers: {
          medium: "test/inherited-model",
        },
      },
    });
    const inheritedModel = {
      provider: "test",
      id: "inherited-model",
      name: "inherited model",
    };
    const ctx = createContext({
      cwd,
      model: inheritedModel,
      modelRegistry: {
        id: "registry",
        find: (provider: string, model: string) =>
          provider === "test" && model === "inherited-model" ? inheritedModel : undefined,
      },
    });
    nextBehaviors = [
      {
        resultText: "same model failed",
        promptStopReason: "error",
        promptErrorMessage: "429 rate limit",
      },
    ];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Do not retry the same model", modelTier: "medium" },
        undefined,
        undefined,
        ctx,
      );

    expect(result).toEqual({
      content: [{ type: "text", text: "Subagent error: 429 rate limit" }],
      details: { id: "id000001", status: "error" },
    });
    expect(createAgentSessionCalls).toHaveLength(1);
    expect(createAgentSessionCalls[0]).toMatchObject({ model: inheritedModel });
    expect(createdSessions[0].disposed).toBe(true);
  });

  test("empty error messages are treated as failed subagent attempts", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [
      {
        resultText: "empty error failed",
        promptStopReason: "error",
        promptErrorMessage: "",
      },
    ];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Fail with empty error" }, undefined, undefined, createContext());

    expect(result).toEqual({
      content: [{ type: "text", text: "Subagent error: " }],
      details: { id: "id000001", status: "error" },
    });
    expect(createAgentSessionCalls).toHaveLength(1);
    expect(createdSessions[0].disposed).toBe(true);
  });

  test("nested modelTier fallback keeps the owning session model selection", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    pi.setThinkingLevel("high");
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: {
        modelTiers: {
          medium: "test/medium-model:low",
          small: "test/missing-small:minimal",
        },
      },
    });
    const rootModel = { name: "root model" };
    const mediumModel = { name: "medium model" };
    const ctx = createContext({
      cwd,
      model: rootModel,
      modelRegistry: {
        id: "registry",
        find: (provider: string, model: string) =>
          provider === "test" && model === "medium-model" ? mediumModel : undefined,
      },
    });
    nextBehaviors = [
      { resultText: "owner waiting", blockPrompt: true },
      { resultText: "fallback nested answer" },
    ];

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Coordinate with medium", modelTier: "medium" },
        undefined,
        undefined,
        ctx,
      );
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;

    const nestedResult = await findDelegationTool(firstSession).execute(
      "nested-call",
      { prompt: "Use missing small", modelTier: "small" },
      undefined,
      undefined,
      ctx,
    );

    expect(nestedResult.details).toEqual({ id: "id000002", status: "completed" });
    expect(createAgentSessionCalls[0]).toMatchObject({
      model: mediumModel,
      thinkingLevel: "low",
    });
    expect(createAgentSessionCalls[1]).toMatchObject({
      model: mediumModel,
      thinkingLevel: "low",
    });

    firstSession.releasePrompt();
    await topLevel;
  });

  test("missing, invalid, and unresolved modelTier mappings fall back to inherited model", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    pi.setThinkingLevel("xhigh");
    extension(pi as never);
    const cwd = tempProjectSettings({
      subagents: {
        modelTiers: {
          medium: "not-a-model-spec",
          small: "test/missing-model:low",
        },
      },
    });
    const inheritedModel = { name: "inherited model" };
    const findCalls: string[] = [];
    const ctx = createContext({
      cwd,
      model: inheritedModel,
      modelRegistry: {
        id: "registry",
        find(provider: string, model: string) {
          findCalls.push(`${provider}/${model}`);
          return undefined;
        },
      },
    });
    nextBehaviors = [
      { resultText: "top-level waiting", blockPrompt: true },
      { resultText: "invalid mapping answer" },
      { resultText: "unresolved mapping answer" },
    ];

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Coordinate" }, undefined, undefined, ctx);
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;
    const nestedTool = findDelegationTool(firstSession);

    const invalidMapping = await nestedTool.execute(
      "nested-call-1",
      { prompt: "Uses default medium" },
      undefined,
      undefined,
      ctx,
    );
    const unresolvedMapping = await nestedTool.execute(
      "nested-call-2",
      { prompt: "Uses missing small", modelTier: "small" },
      undefined,
      undefined,
      ctx,
    );

    expect(invalidMapping.details).toEqual({ id: "id000002", status: "completed" });
    expect(unresolvedMapping.details).toEqual({ id: "id000003", status: "completed" });
    expect(createAgentSessionCalls[1]).toMatchObject({
      model: inheritedModel,
      thinkingLevel: "xhigh",
    });
    expect(createAgentSessionCalls[2]).toMatchObject({
      model: inheritedModel,
      thinkingLevel: "xhigh",
    });
    expect(findCalls).toEqual(["test/missing-model"]);

    firstSession.releasePrompt();
    await topLevel;
  });

  test("unsupported modelTier values are rejected before creating a session", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    await expect(
      pi.tools
        .get("spawn_subagent")!
        .execute(
          "call",
          { prompt: "Bad tier", modelTier: "large" },
          undefined,
          undefined,
          createContext(),
        ),
    ).rejects.toThrow('modelTier must be "medium" or "small".');
    expect(createdSessions).toHaveLength(0);
    expect(createAgentSessionCalls).toHaveLength(0);
  });

  test("foreground spawn with an already-aborted signal stops before creating a session", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    const abortController = new AbortController();
    abortController.abort();

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Already stopped" },
        abortController.signal,
        undefined,
        createContext(),
      );

    expect(result).toEqual({
      content: [{ type: "text", text: "Subagent stopped before it started." }],
      details: { status: "stopped" },
    });
    expect(createdSessions).toHaveLength(0);
    expect(createAgentSessionCalls).toHaveLength(0);
  });

  test("delegated spawn rejects calls after its owning session is no longer active", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "owner complete" }];

    await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Owner", background: true },
        undefined,
        undefined,
        createContext(),
      );
    const ownerSession = await waitForCreatedSession(0);
    await pi.tools
      .get("get_subagent_result")!
      .execute("call", { id: "id000001", wait: true }, undefined, undefined, createContext());

    const result = await findDelegationTool(ownerSession).execute(
      "nested-call",
      { prompt: "Too late" },
      undefined,
      undefined,
      createContext(),
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Cannot spawn delegated task because the calling session is no longer active.",
        },
      ],
      details: { status: "error" },
    });
    expect(createdSessions).toHaveLength(1);
    expect(createAgentSessionCalls).toHaveLength(1);
  });

  test("owner abort propagates to active nested sessions", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [
      { resultText: "top-level partial", blockPrompt: true },
      { resultText: "nested partial", blockPrompt: true },
    ];
    const abortController = new AbortController();

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Coordinate long work" },
        abortController.signal,
        undefined,
        createContext(),
      );
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;
    const nested = findDelegationTool(firstSession).execute(
      "nested-call",
      { prompt: "Long nested check" },
      undefined,
      undefined,
      createContext(),
    );
    const nestedSession = await waitForCreatedSession(1);
    await nestedSession.promptStarted;

    abortController.abort();
    const [topLevelResult, nestedResult] = await Promise.all([topLevel, nested]);

    expect(firstSession.aborted).toBe(true);
    expect(nestedSession.aborted).toBe(true);
    expect(topLevelResult.details).toEqual({ id: "id000001", status: "stopped" });
    expect(nestedResult.details).toEqual({ id: "id000002", status: "stopped" });
  });

  test("session shutdown aborts and clears active nested sessions", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [
      { resultText: "top-level partial", blockPrompt: true },
      { resultText: "nested partial", blockPrompt: true },
    ];

    const topLevel = pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Coordinate long work" }, undefined, undefined, createContext());
    const firstSession = await waitForCreatedSession(0);
    await firstSession.promptStarted;
    const nested = findDelegationTool(firstSession).execute(
      "nested-call",
      { prompt: "Long nested check" },
      undefined,
      undefined,
      createContext(),
    );
    const nestedSession = await waitForCreatedSession(1);
    await nestedSession.promptStarted;

    await pi.events.get("session_shutdown")![0]({}, createContext());
    await Promise.all([topLevel, nested]);

    expect(firstSession.aborted).toBe(true);
    expect(nestedSession.aborted).toBe(true);
    expect(firstSession.disposed).toBe(true);
    expect(nestedSession.disposed).toBe(true);
    expect(
      await pi.tools
        .get("list_subagents")!
        .execute("call", {}, undefined, undefined, createContext()),
    ).toEqual({
      content: [{ type: "text", text: "No subagents in this session." }],
      details: { count: 0 },
    });
  });

  test("session shutdown clears records even when session disposal fails", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [
      { resultText: "partial", blockPrompt: true, disposeError: new Error("dispose boom") },
    ];
    await pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Long", background: true }, undefined, undefined, createContext());
    await createdSessions[0].promptStarted;

    await pi.events.get("session_shutdown")![0]({}, createContext());

    expect(createdSessions[0].aborted).toBe(true);
    expect(createdSessions[0].disposed).toBe(true);
    expect(
      await pi.tools
        .get("list_subagents")!
        .execute("call", {}, undefined, undefined, createContext()),
    ).toEqual({
      content: [{ type: "text", text: "No subagents in this session." }],
      details: { count: 0 },
    });
  });

  test("foreground spawn reports errors and removes completed records", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ promptError: new Error("boom") }];

    const result = await pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Fail" }, undefined, undefined, createContext());

    expect(result).toEqual({
      content: [{ type: "text", text: "Subagent error: boom" }],
      details: { id: "id000001", status: "error" },
    });
    expect(createdSessions[0].disposed).toBe(true);
    const list = await pi.tools
      .get("list_subagents")!
      .execute("call", {}, undefined, undefined, createContext());
    expect(list).toEqual({
      content: [{ type: "text", text: "No subagents in this session." }],
      details: { count: 0 },
    });
  });

  test("foreground parent abort stops the subagent", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "partial", blockPrompt: true }];
    const abortController = new AbortController();

    const promise = pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Long" }, abortController.signal, undefined, createContext());
    const session = await waitForCreatedSession();
    await session.promptStarted;
    abortController.abort();
    const result = await promise;

    expect(session.aborted).toBe(true);
    expect(result.details).toEqual({ id: "id000001", status: "stopped" });
    expect(result.content[0].text).toBe("Subagent stopped: stopped");
  });

  test("background spawn can be listed and retrieved after completion", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "background answer" }];

    const started = await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Work", description: "Background job", background: true },
        undefined,
        undefined,
        createContext(),
      );

    expect(started).toEqual({
      content: [
        {
          type: "text",
          text: "Subagent started in background.\nID: id000001\nDescription: Background job\n\nUse get_subagent_result with this ID to check status or retrieve the full result.",
        },
      ],
      details: { id: "id000001", status: "running", background: true },
    });
    expect(
      (
        await pi.tools
          .get("list_subagents")!
          .execute("call", {}, undefined, undefined, createContext())
      ).content[0].text,
    ).toContain("id000001 | running");

    const result = await pi.tools
      .get("get_subagent_result")!
      .execute("call", { id: "id000001", wait: true }, undefined, undefined, createContext());

    expect(result.content[0].text).toContain("Subagent id000001 | completed |");
    expect(result.content[0].text).toContain("Description: Background job");
    expect(result.content[0].text).toContain("background answer");
    expect(result.details).toEqual({});
  });

  test("get_subagent_result handles missing and still-running subagents", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    expect(
      await pi.tools
        .get("get_subagent_result")!
        .execute("call", { id: "missing" }, undefined, undefined, createContext()),
    ).toEqual({
      content: [{ type: "text", text: "Subagent not found: missing" }],
      details: {},
    });

    nextBehaviors = [{ resultText: "eventual", blockPrompt: true }];
    await pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Long", background: true }, undefined, undefined, createContext());
    await createdSessions[0].promptStarted;

    const running = await pi.tools
      .get("get_subagent_result")!
      .execute("call", { id: "id000001" }, undefined, undefined, createContext());
    expect(running.content[0].text).toContain("Subagent id000001 | running |");
    expect(running.content[0].text).toContain("Still running.");
    createdSessions[0].releasePrompt();
    await pi.tools
      .get("get_subagent_result")!
      .execute("call", { id: "id000001", wait: true }, undefined, undefined, createContext());
  });

  test("stop_subagent aborts a running background subagent and reports non-running records", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "partial", blockPrompt: true }];
    await pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Long", background: true }, undefined, undefined, createContext());
    await createdSessions[0].promptStarted;

    const stopped = await pi.tools
      .get("stop_subagent")!
      .execute("call", { id: "id000001" }, undefined, undefined, createContext());

    expect(createdSessions[0].aborted).toBe(true);
    expect(stopped).toEqual({
      content: [{ type: "text", text: "Stopped subagent id000001." }],
      details: { id: "id000001", status: "stopped" },
    });
    const secondStop = await pi.tools
      .get("stop_subagent")!
      .execute("call", { id: "id000001" }, undefined, undefined, createContext());
    expect(secondStop.content[0].text).toBe("Subagent id000001 is not running (status: stopped).");
    expect(
      await pi.tools
        .get("stop_subagent")!
        .execute("call", { id: "missing" }, undefined, undefined, createContext()),
    ).toEqual({
      content: [{ type: "text", text: "Subagent not found: missing" }],
      details: {},
    });
  });

  test("session shutdown aborts active subagents, disposes sessions, and clears records", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "partial", blockPrompt: true }];
    await pi.tools
      .get("spawn_subagent")!
      .execute("call", { prompt: "Long", background: true }, undefined, undefined, createContext());
    await createdSessions[0].promptStarted;

    await pi.events.get("session_shutdown")![0]({}, createContext());

    expect(createdSessions[0].aborted).toBe(true);
    expect(createdSessions[0].disposed).toBe(true);
    expect(
      await pi.tools
        .get("list_subagents")!
        .execute("call", {}, undefined, undefined, createContext()),
    ).toEqual({
      content: [{ type: "text", text: "No subagents in this session." }],
      details: { count: 0 },
    });
  });

  test("foreground update text is truncated", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);
    nextBehaviors = [{ resultText: "x".repeat(1300) }];
    const updates: string[] = [];

    await pi.tools
      .get("spawn_subagent")!
      .execute(
        "call",
        { prompt: "Long output" },
        undefined,
        (update: { content: Array<{ type: "text"; text: string }> }) =>
          updates.push(update.content[0].text),
        createContext(),
      );

    expect(updates.at(-1)).toContain("...(truncated; call get_subagent_result for full output)");
  });
});
