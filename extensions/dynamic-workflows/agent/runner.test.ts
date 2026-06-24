import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const createAgentSessionCalls: any[] = [];
const loaderInstances: any[] = [];
const createdSessions: any[] = [];
let nextResultText = "workflow subagent result";
let nextPromptError: Error | undefined;
let nextBashExecuteError: Error | undefined;
let nextStructuredOutput: unknown;
const tempDirs: string[] = [];

type Subscriber = (event: any) => void;

function createSession() {
  const subscribers: Subscriber[] = [];
  let name = "";
  let disposed = false;
  let aborted = false;
  const session = {
    messages: [] as any[],
    lastPrompt: "",
    get name() {
      return name;
    },
    get disposed() {
      return disposed;
    },
    get aborted() {
      return aborted;
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
      session.lastPrompt = prompt;
      for (const subscriber of subscribers) subscriber({ type: "message_start" });
      for (const subscriber of subscribers) {
        subscriber({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: nextResultText },
        });
      }
      if (nextPromptError) throw nextPromptError;
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: nextResultText }],
      });
      if (nextStructuredOutput !== undefined) {
        session.messages.push({
          role: "toolResult",
          toolName: "structured_output",
          details: nextStructuredOutput,
        });
      }
    },
    async abort() {
      aborted = true;
    },
    dispose() {
      disposed = true;
    },
  };
  createdSessions.push(session);
  return session;
}

mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/agent-dir",
  DefaultResourceLoader: class {
    options: any;
    reloaded = false;
    constructor(options: any) {
      this.options = options;
      loaderInstances.push(this);
    }
    async reload() {
      this.reloaded = true;
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
    return { session: createSession() };
  },
  createBashToolDefinition: (_cwd: string, options: any) => ({
    name: "bash",
    label: "bash",
    description: "sandboxed bash test tool",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    operations: options?.operations,
    execute: async () => {
      if (nextBashExecuteError) throw nextBashExecuteError;
      return { content: [{ type: "text", text: "bash result" }], details: undefined };
    },
  }),
  // Required because runner.ts transitively imports lib/protected-bash, which
  // value-imports createLocalBashOperations from this module.
  createLocalBashOperations: () => ({ exec: async () => ({ exitCode: 0, output: "" }) }),
}));

function createPi() {
  return {
    getThinkingLevel: () => "high",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
}

function createContext() {
  return {
    cwd: "/repo",
    modelRegistry: { id: "registry" },
    model: { id: "model" },
    getSystemPrompt: () => "parent system prompt",
  };
}

const INVESTIGATION_TOOL_NAMES = [
  "tavily_search",
  "tavily_extract",
  "tavily_map",
  "tavily_crawl",
  "tavily_auth_status",
  "github_clone_workspace",
];
const WORKFLOW_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  ...INVESTIGATION_TOOL_NAMES,
];
const READ_ONLY_WORKFLOW_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  ...INVESTIGATION_TOOL_NAMES,
];
const EXCLUDED_WORKFLOW_TOOL_NAMES = [
  "workflow",
  "review",
  "todo",
  "spawn_subagent",
  "ask_user_question",
  "deep_research",
  "tavily_research",
];

function createFakeInvestigationToolset() {
  return {
    toolNames: [...INVESTIGATION_TOOL_NAMES],
    tools: INVESTIGATION_TOOL_NAMES.map((name) => ({
      name,
      label: name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: `${name} result` }], details: {} }),
    })),
    cleanup: async () => {},
  };
}

function tempTranscriptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-agent-transcripts-"));
  tempDirs.push(dir);
  return join(dir, "transcripts");
}

async function loadRunnerModule() {
  return await import("./runner");
}

afterEach(() => {
  createAgentSessionCalls.splice(0);
  loaderInstances.splice(0);
  createdSessions.splice(0);
  nextResultText = "workflow subagent result";
  nextPromptError = undefined;
  nextBashExecuteError = undefined;
  nextStructuredOutput = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow subagent runner", () => {
  test("runs an isolated in-memory Pi subagent session and returns its final text", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    nextResultText = "final answer";

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    const result = await runner("Inspect src", { label: "inspect src", phase: "Review" });

    expect(result).toBe("final answer");
    expect(createdSessions[0].name).toBe("workflow#inspect src");
    expect(createdSessions[0].lastPrompt).toContain("Inspect src");
    expect(createdSessions[0].lastPrompt).toContain("Workflow phase: Review");
    expect(createdSessions[0].disposed).toBe(true);
    expect(createAgentSessionCalls[0]).toMatchObject({
      cwd: "/repo",
      agentDir: "/agent-dir",
      modelRegistry: { id: "registry" },
      model: { id: "model" },
      thinkingLevel: "high",
      tools: WORKFLOW_TOOL_NAMES,
      sessionManager: { kind: "in-memory", cwd: "/repo" },
    });
    expect(
      createAgentSessionCalls[0].customTools.map((tool: { name: string }) => tool.name),
    ).toEqual(INVESTIGATION_TOOL_NAMES);
    expect(createAgentSessionCalls[0].tools).not.toContain("structured_output");
    for (const excluded of EXCLUDED_WORKFLOW_TOOL_NAMES) {
      expect(createAgentSessionCalls[0].tools).not.toContain(excluded);
    }
    expect(loaderInstances[0].reloaded).toBe(true);
    expect(loaderInstances[0].options.noExtensions).toBe(true);
    expect(loaderInstances[0].options.noSkills).toBe(true);
    expect(loaderInstances[0].options.systemPromptOverride()).toContain("parent system prompt");
    expect(loaderInstances[0].options.systemPromptOverride()).toContain("Working directory: /repo");
  });

  test("read-only tool policy drops edit/write and shadows bash with a sandboxed tool", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    nextResultText = "inspected";

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    const result = await runner("Inspect without mutating", {
      label: "inspect",
      phase: "Investigate",
      toolPolicy: "readOnly",
    });

    expect(result).toBe("inspected");
    expect(createAgentSessionCalls[0].tools).toEqual(READ_ONLY_WORKFLOW_TOOL_NAMES);
    for (const mutating of ["edit", "write"]) {
      expect(createAgentSessionCalls[0].tools).not.toContain(mutating);
    }
    // The read-only bash tool is mounted as a custom tool so it shadows the
    // built-in bash inside the in-memory session.
    expect(
      createAgentSessionCalls[0].customTools.map((tool: { name: string }) => tool.name),
    ).toEqual([...INVESTIGATION_TOOL_NAMES, "bash"]);
    expect(createAgentSessionCalls[0].customTools.at(-1)).toMatchObject({ name: "bash" });
  });

  test("read-only bash surfaces sandbox errors as tool output", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    nextBashExecuteError = new Error("sandbox unavailable");

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    await runner("Inspect without mutating", {
      label: "inspect",
      phase: "Investigate",
      toolPolicy: "readOnly",
    });

    const bashTool = createAgentSessionCalls[0].customTools.find(
      (tool: { name: string }) => tool.name === "bash",
    );
    expect(bashTool).toBeDefined();
    await expect(bashTool.execute("call", {}, undefined, undefined, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "sandbox unavailable" }],
      details: undefined,
    });
  });

  test("read-only tool policy keeps structured_output available alongside the sandboxed bash", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    nextStructuredOutput = { verdict: "pass" };

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    const result = await runner("Return a verdict", {
      label: "verdict",
      toolPolicy: "readOnly",
      schema: { type: "object", properties: { verdict: { type: "string" } } },
    });

    expect(result).toEqual({ verdict: "pass" });
    expect(createAgentSessionCalls[0].tools).toEqual([
      ...READ_ONLY_WORKFLOW_TOOL_NAMES,
      "structured_output",
    ]);
    expect(
      createAgentSessionCalls[0].customTools.map((tool: { name: string }) => tool.name),
    ).toEqual([...INVESTIGATION_TOOL_NAMES, "bash", "structured_output"]);
  });

  test("persists subagent transcripts with minimal metadata", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const transcriptsDir = tempTranscriptsDir();
    nextResultText = "final answer";

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    const result = await runner("Inspect src", {
      label: "inspect src",
      phase: "Review",
      agentType: "reviewer",
      transcript: {
        transcriptId: "0001-inspect-src",
        runId: "wf_transcript_12345678",
        taskId: "task_transcript_12345678",
        workflowName: "transcript_smoke",
        transcriptsDir,
      },
    });

    expect(result).toBe("final answer");
    const transcript = JSON.parse(
      readFileSync(join(transcriptsDir, "0001-inspect-src.json"), "utf8"),
    );
    expect(transcript).toMatchObject({
      schemaVersion: 1,
      metadata: {
        transcriptId: "0001-inspect-src",
        runId: "wf_transcript_12345678",
        taskId: "task_transcript_12345678",
        workflowName: "transcript_smoke",
        cwd: "/repo",
        label: "inspect src",
        phase: "Review",
        agentType: "reviewer",
        model: "model",
        thinkingLevel: "high",
        hasSchema: false,
        status: "completed",
        prompt: "Inspect src",
        sessionName: "workflow#inspect src",
        resultPreview: "final answer",
        durationMs: expect.any(Number),
      },
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
        },
      ],
    });
    expect(transcript.metadata.sessionPrompt).toContain("Workflow agent label: inspect src");
    expect(transcript.metadata.startedAt).toEqual(expect.any(String));
    expect(transcript.metadata.completedAt).toEqual(expect.any(String));
  });

  test("records the model used to create the subagent session in transcripts", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const transcriptsDir = tempTranscriptsDir();
    nextResultText = "final answer";
    let modelReads = 0;
    const ctx = {
      cwd: "/repo",
      modelRegistry: { id: "registry" },
      get model() {
        modelReads += 1;
        return { id: modelReads === 1 ? "session-model" : "later-model" };
      },
      getSystemPrompt: () => "parent system prompt",
    };

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      ctx as never,
      createFakeInvestigationToolset() as never,
    );
    await runner("Inspect src", {
      label: "inspect src",
      transcript: {
        transcriptId: "0001-inspect-src",
        runId: "wf_transcript_12345678",
        taskId: "task_transcript_12345678",
        transcriptsDir,
      },
    });

    expect(createAgentSessionCalls[0].model).toEqual({ id: "session-model" });
    const transcript = JSON.parse(
      readFileSync(join(transcriptsDir, "0001-inspect-src.json"), "utf8"),
    );
    expect(transcript.metadata.model).toBe("session-model");
  });

  test("uses requested provider/model:effort instead of the parent session model", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const transcriptsDir = tempTranscriptsDir();
    const selectedModel = { provider: "openai", id: "gpt-5" };
    const findCalls: Array<{ provider: string; model: string }> = [];
    const ctx = {
      cwd: "/repo",
      modelRegistry: {
        id: "registry",
        find(provider: string, model: string) {
          findCalls.push({ provider, model });
          return selectedModel;
        },
      },
      model: { provider: "anthropic", id: "claude-parent" },
      getSystemPrompt: () => "parent system prompt",
    };

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      ctx as never,
      createFakeInvestigationToolset() as never,
    );
    await runner("Inspect src", {
      label: "inspect src",
      model: " openai/gpt-5:LOW ",
      transcript: {
        transcriptId: "0001-inspect-src",
        runId: "wf_transcript_12345678",
        taskId: "task_transcript_12345678",
        transcriptsDir,
      },
    });

    expect(findCalls).toEqual([{ provider: "openai", model: "gpt-5" }]);
    expect(createAgentSessionCalls[0]).toMatchObject({
      model: selectedModel,
      thinkingLevel: "low",
    });
    expect(createdSessions[0].lastPrompt).toContain("Workflow agent model: openai/gpt-5:low");
    const transcript = JSON.parse(
      readFileSync(join(transcriptsDir, "0001-inspect-src.json"), "utf8"),
    );
    expect(transcript.metadata).toMatchObject({
      model: "openai/gpt-5",
      thinkingLevel: "low",
    });
    expect(transcript.metadata.sessionPrompt).toContain("Workflow agent model: openai/gpt-5:low");
  });

  test("returns successful results when transcript persistence fails", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const transcriptsDir = tempTranscriptsDir();
    writeFileSync(transcriptsDir, "not a directory");
    nextResultText = "final answer";
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn as never;

    try {
      const runner = createWorkflowAgentRunner(
        createPi() as never,
        createContext() as never,
        createFakeInvestigationToolset() as never,
      );
      const result = await runner("Inspect src", {
        label: "inspect src",
        transcript: {
          transcriptId: "0001-inspect-src",
          runId: "wf_transcript_12345678",
          taskId: "task_transcript_12345678",
          transcriptsDir,
        },
      });

      expect(result).toBe("final answer");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("workflow subagent transcript persistence failed"),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("persists failed subagent transcripts before rethrowing", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const transcriptsDir = tempTranscriptsDir();
    nextPromptError = new Error("subagent exploded");

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    await expect(
      runner("Inspect src", {
        label: "inspect src",
        transcript: {
          transcriptId: "0001-inspect-src",
          runId: "wf_transcript_12345678",
          taskId: "task_transcript_12345678",
          transcriptsDir,
        },
      }),
    ).rejects.toThrow("subagent exploded");

    const transcript = JSON.parse(
      readFileSync(join(transcriptsDir, "0001-inspect-src.json"), "utf8"),
    );
    expect(transcript).toMatchObject({
      metadata: {
        status: "failed",
        error: { message: "subagent exploded", name: "Error" },
      },
      messages: [],
    });
  });

  test("aborts the subagent session when the parent signal is aborted", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const controller = new AbortController();
    nextPromptError = new Error("aborted");

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    const promise = runner("Inspect src", {
      label: "inspect src",
      signal: controller.signal,
    } as never);
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
    expect(createdSessions[0].aborted).toBe(true);
    expect(createdSessions[0].disposed).toBe(true);
  });

  test("returns structured output details when agent options include a schema", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    nextStructuredOutput = { verdict: "pass" };

    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );
    const result = await runner("Return a verdict", {
      label: "verdict",
      schema,
    });

    expect(result).toEqual({ verdict: "pass" });
    expect(createdSessions[0].lastPrompt).toContain("structured_output");
    expect(createAgentSessionCalls[0].tools).toEqual([...WORKFLOW_TOOL_NAMES, "structured_output"]);
    expect(createAgentSessionCalls[0].tools.at(-1)).toBe("structured_output");
    expect(
      createAgentSessionCalls[0].customTools.map((tool: { name: string }) => tool.name),
    ).toEqual([...INVESTIGATION_TOOL_NAMES, "structured_output"]);
    expect(createAgentSessionCalls[0].customTools.at(-1)).toMatchObject({
      name: "structured_output",
      label: "Structured Output",
      parameters: schema,
    });
    const toolResult = await createAgentSessionCalls[0].customTools.at(-1).execute("call", {
      verdict: "pass",
    });
    expect(toolResult).toMatchObject({
      details: { verdict: "pass" },
      terminate: true,
    });
  });

  test("fails schema-backed agent calls when the subagent does not use structured_output", async () => {
    const { createWorkflowAgentRunner } = await loadRunnerModule();
    const runner = createWorkflowAgentRunner(
      createPi() as never,
      createContext() as never,
      createFakeInvestigationToolset() as never,
    );

    await expect(
      runner("Return a verdict", {
        label: "verdict",
        schema: { type: "object", properties: { verdict: { type: "string" } } },
      }),
    ).rejects.toThrow("structured_output");
    expect(createdSessions[0].disposed).toBe(true);
  });
});
