import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeUi } from "../../tests/support/fake-ui";
import { installTypeboxMock } from "../../tests/support/typebox-mock";

mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => "/agent-dir",
  DefaultResourceLoader: class {},
  SessionManager: { inMemory: (cwd: string) => ({ cwd }) },
  SettingsManager: { create: (cwd: string, agentDir: string) => ({ cwd, agentDir }) },
  createAgentSession: async () => {
    throw new Error("createAgentSession should not run during registration");
  },
  // index.ts transitively imports the workflow agent runner, which imports
  // lib/protected-bash; that module value-imports createLocalBashOperations.
  createBashToolDefinition: () => ({ name: "bash", label: "bash", execute: async () => ({}) }),
  createLocalBashOperations: () => ({ exec: async () => ({ exitCode: 0, output: "" }) }),
}));
mock.module("@earendil-works/pi-tui", () => ({
  Key: { up: "up", down: "down", enter: "enter", escape: "escape" },
  matchesKey: (data: string, key: string) => data === key,
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
  visibleWidth: (text: string) => text.length,
  wrapTextWithAnsi: (text: string, width: number) => {
    const lines: string[] = [];
    for (let index = 0; index < text.length; index += width) {
      lines.push(text.slice(index, index + width));
    }
    return lines.length === 0 ? [""] : lines;
  },
}));
installTypeboxMock();

type WorkflowToolOptions = {
  exec?: ToolsetConfig["exec"];
  completionNotifier?: (notification: unknown) => void;
  lifecycleNotifier?: (notification: {
    runId: string;
    taskId: string;
    workflowName: string;
    status: "started" | "completed" | "failed" | "cancelled";
    artifactDir: string;
    outputPath: string;
  }) => void;
  controllerRegistry: {
    register: (runId: string) => {
      signal: AbortSignal;
      stopReason?: string;
      trackCompletion: (completion: Promise<void>) => void;
      unregister: () => void;
    };
    get: (runId: string) => { signal: AbortSignal; stopReason?: string } | undefined;
    activeRunIds: () => string[];
  };
};
const workflowToolOptions: WorkflowToolOptions[] = [];
mock.module("./workflow-tool", () => ({
  createWorkflowCompletionNotifier:
    (pi: { sendMessage: (message: unknown, options: unknown) => void }) =>
    (notification: unknown) =>
      pi.sendMessage(notification, { triggerTurn: true }),
  createWorkflowTool: (options: WorkflowToolOptions) => {
    workflowToolOptions.push(options);
    return {
      name: "workflow",
      label: "Workflow",
      description: "Execute a deterministic JavaScript workflow.",
      parameters: {},
      async execute() {
        return { content: [{ type: "text", text: "mock workflow launched" }], details: {} };
      },
    };
  },
}));

type ToolsetConfig = {
  exec: (
    command: string,
    args: string[],
    options?: { timeout?: number; cwd?: string; signal?: AbortSignal },
  ) => Promise<unknown>;
};
const createInvestigationToolsetCalls: ToolsetConfig[] = [];
const cleanupCalls: boolean[] = [];
mock.module("../../lib/investigation-tools", () => ({
  createInvestigationToolset: (config: ToolsetConfig) => {
    createInvestigationToolsetCalls.push(config);
    return {
      toolNames: [
        "tavily_search",
        "tavily_extract",
        "tavily_map",
        "tavily_crawl",
        "tavily_auth_status",
        "github_clone_workspace",
      ],
      tools: [],
      cleanup: async () => {
        cleanupCalls.push(true);
      },
    };
  },
  isolatedAgentToolNames: (
    toolset: { toolNames: string[] },
    options: { readOnly?: boolean; extraTools?: readonly string[] } = {},
  ) => [
    ...(options.readOnly
      ? ["read", "grep", "find", "ls", "bash"]
      : ["read", "grep", "find", "ls", "bash", "edit", "write"]),
    ...toolset.toolNames,
    ...(options.extraTools ?? []),
  ],
}));

type ToolDefinition = { name: string; label: string; description: string };
type CommandDefinition = {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => Promise<unknown[] | null> | unknown[] | null;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};
type EventHandler = (event: unknown, ctx: unknown) => unknown;

const tempDirs: string[] = [];

async function loadExtension() {
  return (await import("./index")).default;
}

function createExtensionPi() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, EventHandler[]>();
  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  Object.assign(events, {
    emit(name: string, data: unknown) {
      emittedEvents.push({ name, data });
    },
  });
  const execCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const sentMessages: unknown[] = [];
  return {
    tools,
    commands,
    events,
    emittedEvents,
    execCalls,
    sentMessages,
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    on(name: string, handler: EventHandler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    async exec(command: string, args: string[], options: unknown = {}) {
      execCalls.push({ command, args, options });
      return { code: 0, stdout: "", stderr: "" };
    },
    sendMessage(message: unknown) {
      sentMessages.push(message);
    },
    getThinkingLevel: () => "medium",
    getCommands: () => [...commands.keys()].map((name) => ({ name })),
  };
}

function writeWorkflowFile(root: string, fileName: string, script: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, fileName);
  writeFileSync(path, script);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  createInvestigationToolsetCalls.splice(0);
  cleanupCalls.splice(0);
  workflowToolOptions.splice(0);
});

describe("dynamic workflows extension", () => {
  test("registers the workflow LLM Tool, workflow commands, and lifecycle hooks", async () => {
    const extension = await loadExtension();
    const pi = createExtensionPi();

    extension(pi as never);

    expect([...pi.tools.keys()]).toEqual(["workflow"]);
    expect(pi.tools.get("workflow")).toMatchObject({
      label: "Workflow",
      description: expect.stringContaining("deterministic JavaScript workflow"),
    });
    expect([...pi.commands.keys()]).toEqual(["workflows", "workflow", "ultracode"]);
    expect(pi.commands.get("workflows")?.description).toContain("dynamic workflow runs");
    expect(pi.commands.get("workflow")?.description).toContain("saved dynamic workflow");
    expect(pi.events.get("session_start")).toHaveLength(3);
    expect(pi.events.get("before_agent_start")).toHaveLength(2);

    expect(createInvestigationToolsetCalls).toHaveLength(1);
    await createInvestigationToolsetCalls[0].exec("tvly", ["auth", "--json"], { timeout: 1 });
    await workflowToolOptions.at(-1)!.exec!("git", ["status", "--porcelain"], {
      cwd: "/repo",
      timeout: 10_000,
    });
    expect(pi.execCalls).toEqual([
      { command: "tvly", args: ["auth", "--json"], options: { timeout: 1 } },
      {
        command: "git",
        args: ["status", "--porcelain"],
        options: { cwd: "/repo", timeout: 10_000 },
      },
    ]);

    const lifecycleNotifier = workflowToolOptions.at(-1)!.lifecycleNotifier!;
    lifecycleNotifier({
      runId: "wf_review_12345678",
      taskId: "task_review_12345678",
      workflowName: "review_flow",
      status: "started",
      artifactDir: "/repo/.pi/workflows/wf_review_12345678",
      outputPath: "/repo/.pi/workflows/wf_review_12345678/output.json",
    });
    lifecycleNotifier({
      runId: "wf_research_12345678",
      taskId: "task_research_12345678",
      workflowName: "research_flow",
      status: "completed",
      artifactDir: "/repo/.pi/workflows/wf_research_12345678",
      outputPath: "/repo/.pi/workflows/wf_research_12345678/output.json",
    });
    expect(pi.emittedEvents).toEqual([
      {
        name: "workflow:started",
        data: expect.objectContaining({
          name: "review",
          workflowName: "review_flow",
          status: "started",
        }),
      },
    ]);

    expect(pi.events.get("session_shutdown")).toHaveLength(1);
    await pi.events.get("session_shutdown")![0]({ type: "session_shutdown" }, { cwd: "/repo" });
    expect(cleanupCalls).toHaveLength(1);
  });

  test("session shutdown stops active workflow runs and waits before investigation cleanup", async () => {
    const extension = await loadExtension();
    const pi = createExtensionPi();
    extension(pi as never);

    const registry = workflowToolOptions.at(-1)!.controllerRegistry;
    const activeRun = registry.register("wf_active_12345678");
    let resolveCompletion!: () => void;
    activeRun.trackCompletion(
      new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      }),
    );

    const shutdown = pi.events.get("session_shutdown")![0](
      { type: "session_shutdown" },
      { cwd: "/repo" },
    ) as Promise<void>;
    await Promise.resolve();

    expect(registry.get("wf_active_12345678")?.signal.aborted).toBe(true);
    expect(registry.get("wf_active_12345678")?.stopReason).toBe(
      "session shutdown stopped workflow run: wf_active_12345678",
    );
    expect(cleanupCalls).toEqual([]);

    workflowToolOptions.at(-1)!.completionNotifier?.({ status: "cancelled" });
    expect(pi.sentMessages).toEqual([]);

    resolveCompletion();
    await shutdown;

    expect(cleanupCalls).toEqual([true]);
    expect(() => registry.register("wf_after_shutdown_12345678")).toThrow("shutting down");
  });

  test("injects optional ultracode policy only after /ultracode enables it", async () => {
    const extension = await loadExtension();
    const pi = createExtensionPi();
    const ui = createFakeUi();

    extension(pi as never);

    const disabledResults = await Promise.all(
      (pi.events.get("before_agent_start") ?? []).map((handler) =>
        handler(
          {
            type: "before_agent_start",
            prompt: "audit repo",
            systemPrompt: "base prompt",
            systemPromptOptions: {},
          },
          { cwd: "/repo", ui },
        ),
      ),
    );
    expect(disabledResults).toEqual([undefined, undefined]);

    await pi.commands.get("ultracode")!.handler("on", { ui });
    const enabledResults = await Promise.all(
      (pi.events.get("before_agent_start") ?? []).map((handler) =>
        handler(
          {
            type: "before_agent_start",
            prompt: "audit repo",
            systemPrompt: "base prompt",
            systemPromptOptions: {},
          },
          { cwd: "/repo", ui },
        ),
      ),
    );

    expect(enabledResults).toEqual([
      undefined,
      { systemPrompt: expect.stringContaining("ultracode policy mode is ON") },
    ]);
    expect((enabledResults[1] as { systemPrompt: string }).systemPrompt).toContain(
      "not automatically selected",
    );
  });

  test("exposes loaded skill-packaged workflows to /workflow completions", async () => {
    const extension = await loadExtension();
    const pi = createExtensionPi();
    const cwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-entry-"));
    const packageRoot = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-package-"));
    tempDirs.push(cwd, packageRoot);
    const skillBaseDir = join(packageRoot, "skills", "deep-research");
    writeWorkflowFile(
      join(skillBaseDir, "workflows"),
      "deep-research.js",
      `export const meta = { name: "deep-research", description: "Packaged deep research", phases: [{ title: "Research" }] };
return await agent("research");`,
    );

    extension(pi as never);
    await Promise.all(
      (pi.events.get("session_start") ?? []).map((handler) =>
        handler({ type: "session_start", reason: "startup" }, { cwd, ui: createFakeUi() }),
      ),
    );
    await Promise.all(
      (pi.events.get("before_agent_start") ?? []).map((handler) =>
        handler(
          {
            type: "before_agent_start",
            prompt: "run research",
            systemPrompt: "base",
            systemPromptOptions: {
              cwd,
              skills: [
                { name: "deep-research", description: "", filePath: "", baseDir: skillBaseDir },
              ],
            },
          },
          { cwd },
        ),
      ),
    );

    await expect(pi.commands.get("workflow")!.getArgumentCompletions!("deep")).resolves.toEqual([
      {
        value: "deep-research",
        label: "deep-research",
        description: "Packaged deep research",
      },
    ]);
  });
});
