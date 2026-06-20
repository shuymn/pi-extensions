import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorkflowAgentTranscriptId } from "./agent/transcript";
import type { WorkflowJournalAgentIdFactory } from "./journal/model";
import { WorkflowJournalRecorder } from "./journal/recorder";
import { loadWorkflowReplayCache, type WorkflowReplayCache } from "./journal/replay";
import { WorkflowJournalStore } from "./journal/store";
import {
  type WorkflowRunControllerRegistration,
  WorkflowRunControllerRegistry,
} from "./run/controllers";
import { createTaskId, createWorkflowRunId } from "./run/ids";
import { WorkflowManifestUpdater } from "./run/manifest";
import { createInitialWorkflowRunState, type WorkflowRunState } from "./run/model";
import { resolveWorkflowRoot } from "./run/root";
import { getWorkflowRunPaths, type WorkflowRunPaths, WorkflowRunStore } from "./run/store";
import {
  executableScriptCallsAgent,
  parseWorkflowScript,
  type WorkflowMeta,
} from "./runtime/parser";
import {
  runWorkflow,
  type WorkflowAgent,
  type WorkflowAgentOptions,
  type WorkflowRunResult,
} from "./runtime/runtime";
import { workflowCatalogForRoot } from "./saved/catalog";
import { createWorkflowCallComponent, createWorkflowResultComponent } from "./ui/render-tool";
import { refreshWorkflowWidget } from "./ui/workflow-widget";

const workflowToolSchema = Type.Object({
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Path to a workflow JavaScript file to execute. Relative paths are resolved from the session cwd. Takes precedence over script and name.",
    }),
  ),
  script: Type.Optional(
    Type.String({
      description:
        "Raw JavaScript workflow script. It must start with `export const meta = { name, description, phases }` and call agent() at least once. Used when scriptPath is omitted, before name.",
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Saved workflow name resolved from project .pi/workflows/*.js or loaded skill-packaged workflows/*.js by static meta.name parsing. Used when scriptPath and script are omitted.",
    }),
  ),
  args: Type.Optional(
    Type.Unsafe({
      description: "Optional JSON value exposed to the workflow script as global `args`.",
    }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description:
        "Optional previous workflow run id. When provided, load its journal as a replay cache and use its script if scriptPath, script, and name are omitted.",
    }),
  ),
});

export type WorkflowToolInput = {
  scriptPath?: string;
  script?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
};

export type WorkflowToolAgentEvent = {
  label: string;
  phase?: string;
  prompt: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
  error?: string;
};

export type WorkflowToolDetails = {
  status: "launched" | "running" | "completed" | "failed";
  runId?: string;
  taskId?: string;
  artifactDir?: string;
  outputPath?: string;
  resumeFromRunId?: string;
  workflowName: string;
  description?: string;
  phases: string[];
  logs: string[];
  agents: WorkflowToolAgentEvent[];
  agentCount: number;
  result?: unknown;
  durationMs?: number;
};

export type WorkflowCompletionStatus = "completed" | "failed" | "cancelled";

export type WorkflowUsageSummary = {
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs?: number;
};

export type WorkflowCompletionNotification = {
  runId: string;
  taskId: string;
  workflowName: string;
  status: WorkflowCompletionStatus;
  artifactDir: string;
  outputPath: string;
  resultPreview?: string;
  error?: string;
  usage: WorkflowUsageSummary;
};

export type WorkflowCompletionNotifier = (notification: WorkflowCompletionNotification) => void;

type BackgroundTask = () => Promise<void>;

export const defaultWorkflowRunControllerRegistry = new WorkflowRunControllerRegistry();

export type WorkflowAdditionalRootsProvider =
  | readonly string[]
  | ((ctx: ExtensionContext | undefined) => readonly string[]);

export type WorkflowToolOptions = {
  agent?: WorkflowAgent;
  agentFactory?: (ctx: ExtensionContext) => WorkflowAgent;
  cwd?: string;
  workflowRoot?: string;
  additionalWorkflowRoots?: WorkflowAdditionalRootsProvider;
  runIdFactory?: () => string;
  taskIdFactory?: () => string;
  backgroundScheduler?: (task: BackgroundTask) => void;
  controllerRegistry?: WorkflowRunControllerRegistry;
  completionNotifier?: WorkflowCompletionNotifier;
  selectedThinkingLevelFactory?: () => string | undefined;
  journalAgentIdFactory?: WorkflowJournalAgentIdFactory;
  maxConcurrentAgents?: number;
  maxTotalAgents?: number;
  tokenBudget?: number;
};

export function normalizeWorkflowToolInput(input: unknown): WorkflowToolInput {
  if (!input || typeof input !== "object") {
    throw new Error("workflow requires an object argument.");
  }

  const value = input as Record<string, unknown>;
  if (value.scriptPath !== undefined && typeof value.scriptPath !== "string") {
    throw new Error("workflow requires `scriptPath` to be a string when provided.");
  }
  if (value.script !== undefined && typeof value.script !== "string") {
    throw new Error("workflow requires `script` to be a string when provided.");
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    throw new Error("workflow requires `name` to be a string when provided.");
  }
  if (value.resumeFromRunId !== undefined && typeof value.resumeFromRunId !== "string") {
    throw new Error("workflow requires `resumeFromRunId` to be a string when provided.");
  }
  if (
    value.scriptPath === undefined &&
    value.script === undefined &&
    value.name === undefined &&
    value.resumeFromRunId === undefined
  ) {
    throw new Error(
      "workflow requires `scriptPath`, `script`, `name`, or `resumeFromRunId` to select a workflow script.",
    );
  }

  return {
    ...(value.args === undefined ? {} : { args: value.args }),
    ...(value.scriptPath === undefined ? {} : { scriptPath: value.scriptPath }),
    ...(value.script === undefined ? {} : { script: stripMarkdownFence(value.script) }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.resumeFromRunId === undefined ? {} : { resumeFromRunId: value.resumeFromRunId }),
  };
}

export function createWorkflowTool(options: WorkflowToolOptions = {}): ToolDefinition {
  return {
    name: "workflow",
    label: "Workflow",
    description:
      "Execute a deterministic JavaScript workflow that orchestrates isolated subagent work with agent(), parallel(), pipeline(), phase(), and log(). Use only when the user explicitly asks for workflow-style multi-agent orchestration.",
    promptSnippet:
      "Use workflow for explicit dynamic workflow or multi-agent fan-out requests. Provide one raw deterministic JavaScript script with export const meta first, then orchestrate with agent(), parallel(), pipeline(), phase(), and log().",
    promptGuidelines: [
      "Use workflow only when the user explicitly asks for a workflow, dynamic workflow, fan-out, or multi-agent orchestration, or when a loaded skill explicitly instructs you to use it.",
      "For workflow, a skill-packaged workflows/*.js file is discoverable but is not authorization by itself; the loaded skill instructions must explicitly say to launch workflow, /workflow, or workflow({ name }).",
      "For workflow, select the script source with precedence scriptPath > script > name. Pass raw JavaScript in script, a cwd-relative or absolute file in scriptPath, or a project saved / skill-packaged workflow meta.name in name.",
      "For workflow, do not wrap raw script in Markdown fences, although the tool will defensively strip one surrounding fence.",
      "For workflow, the first statement after comments/whitespace must be `export const meta = { name, description, phases }`; keep meta a plain literal object.",
      "For workflow, do not use TypeScript syntax, imports, require(), fs, shell, network, Date.now(), Math.random(), or argument-less new Date().",
      "For workflow, available globals are args, cwd, process.cwd(), phase(title), log(message), agent(prompt, options), parallel(thunks), pipeline(items, ...stages), and budget.",
      "For workflow, every script must call agent() at least once. Do not use workflow only to return a static object or declare phases.",
      "For workflow, parallel() takes functions, not promises: use `await parallel(items.map(item => () => agent(...)))`, never `await parallel(items.map(item => agent(...)))`.",
      "For workflow, pipeline(items, ...stages) runs each item through all stages independently; do not assume a global barrier between stages.",
      "For workflow, include short unique agent labels such as { label: 'repo inventory' } so progress and errors are readable.",
      "For workflow, failed agent(), parallel(), or pipeline() branches return null and log the failure unless the workflow is aborted or a hard runtime limit is reached.",
      "For workflow, return a compact JSON-serializable value. Use a final synthesis agent when combining several subagent results.",
    ],
    parameters: workflowToolSchema,
    prepareArguments: normalizeWorkflowToolInput,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("workflow launch was aborted.");

      const input = normalizeWorkflowToolInput(params);
      const agent = options.agent ?? options.agentFactory?.(ctx) ?? createUnconfiguredAgent();
      const cwd = options.cwd ?? ctx.cwd;
      const workflowRoot = options.workflowRoot ?? resolveWorkflowRoot(cwd);
      const workflowCatalog = workflowCatalogForRoot(
        workflowRoot,
        workflowAdditionalRoots(options.additionalWorkflowRoots, ctx),
      );
      const resumePaths =
        input.resumeFromRunId === undefined
          ? undefined
          : getWorkflowRunPaths(workflowRoot, input.resumeFromRunId);
      const script = await readWorkflowScriptForLaunch(input, {
        cwd,
        workflowCatalog,
        resumePaths,
      });
      const replayCache =
        resumePaths === undefined
          ? undefined
          : await loadWorkflowReplayCache(resumePaths.journalPath);
      const parsed = parseWorkflowScript(script);
      if (!executableScriptCallsAgent(parsed.executableScript)) {
        throw new Error("workflow scripts must call agent() at least once.");
      }

      const runId = options.runIdFactory?.() ?? createWorkflowRunId();
      const taskId = options.taskIdFactory?.() ?? createTaskId();
      const paths = getWorkflowRunPaths(workflowRoot, runId);
      const state = createInitialWorkflowRunState({
        runId,
        taskId,
        sessionId: getSessionId(ctx),
        cwd,
        workflowName: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases,
        scriptPath: paths.scriptPath,
      });
      const store = new WorkflowRunStore(workflowRoot);
      const createdPaths = await store.createRun({ state, script });
      const controllerRegistry = options.controllerRegistry ?? defaultWorkflowRunControllerRegistry;
      const controller = controllerRegistry.register(runId);

      scheduleBackgroundWorkflow({
        store,
        paths: createdPaths,
        script,
        args: input.args,
        cwd,
        agent,
        meta: parsed.meta,
        state,
        options,
        controller,
        ctx,
        replayCache,
        resumeFromRunId: input.resumeFromRunId,
      });
      refreshWorkflowWidget(ctx, state);

      const details = createLaunchDetails(parsed.meta, state, createdPaths, input.resumeFromRunId);
      return textResult(
        `Workflow ${parsed.meta.name} launched in background as ${runId}. Artifacts: ${createdPaths.runDir}`,
        details,
      );
    },
    renderCall(_args, theme) {
      return createWorkflowCallComponent(theme);
    },
    renderResult(result, _options, theme) {
      return createWorkflowResultComponent(result, theme);
    },
  } as ToolDefinition;
}

type ScheduleBackgroundWorkflowInput = {
  store: WorkflowRunStore;
  paths: WorkflowRunPaths;
  script: string;
  args?: unknown;
  cwd: string;
  agent: WorkflowAgent;
  meta: WorkflowMeta;
  state: WorkflowRunState;
  options: WorkflowToolOptions;
  controller: WorkflowRunControllerRegistration;
  ctx: ExtensionContext;
  replayCache?: WorkflowReplayCache;
  resumeFromRunId?: string;
};

function scheduleBackgroundWorkflow(input: ScheduleBackgroundWorkflowInput): void {
  const task = async () => {
    let manifest: WorkflowManifestUpdater | undefined;
    let journal: WorkflowJournalRecorder | undefined;

    try {
      const activeManifest = new WorkflowManifestUpdater(input.state, async (state) => {
        await input.store.writeManifest(state);
        refreshWorkflowWidget(input.ctx, state);
      });
      const activeJournal = new WorkflowJournalRecorder(
        new WorkflowJournalStore({ journalPath: input.paths.journalPath }),
      );
      manifest = activeManifest;
      journal = activeJournal;
      activeManifest.markRunning();
      const runResult = await runWorkflow(input.script, {
        cwd: input.cwd,
        args: input.args,
        agent: input.agent,
        signal: input.controller.signal,
        maxConcurrentAgents: input.options.maxConcurrentAgents,
        maxTotalAgents: input.options.maxTotalAgents,
        tokenBudget: input.options.tokenBudget,
        selectedModel: selectedModelId(input.ctx.model),
        selectedThinkingLevel: input.options.selectedThinkingLevelFactory?.(),
        journalAgentIdFactory: input.options.journalAgentIdFactory,
        replayCache: input.replayCache,
        transcriptTargetFactory: (event) => ({
          transcriptId: createWorkflowAgentTranscriptId(event.agentIndex, event.label),
          runId: input.state.runId,
          taskId: input.state.taskId,
          workflowName: input.state.workflowName,
          transcriptsDir: input.paths.transcriptsDir,
        }),
        agentControlFactory: (event) => input.controller.registerAgent(event.runAgentId),
        onPhase: (title) => activeManifest.phase(title),
        onLog: (message) => activeManifest.log(message),
        onAgentQueued: (event) => activeManifest.agentQueued(event),
        onAgentStart(event) {
          activeManifest.agentStarted(event);
          activeJournal.started(event);
        },
        onAgentStop(event, reason) {
          activeManifest.agentStopped(event, reason);
          activeJournal.stopped(event, reason);
        },
        onAgentEnd(event) {
          if (event.error) {
            activeManifest.agentFailed({ ...event, error: event.error });
            activeJournal.failed(event, event.error);
          } else {
            activeManifest.agentCompleted(event);
            activeJournal.result(event);
          }
        },
      });

      if (runResult.agentCount === 0) {
        throw new Error("workflow scripts must call agent() at least once.");
      }

      await finalizeCompletedWorkflowRun(input, activeManifest, activeJournal, runResult);
    } catch (error) {
      if (input.controller.signal.aborted) {
        const reason = cancellationReason(input.controller, error);
        if (manifest && journal)
          await finalizeCancelledWorkflowRun(input, manifest, journal, reason);
      } else if (manifest && journal) {
        await finalizeFailedWorkflowRun(input, manifest, journal, error);
      }
    } finally {
      input.controller.unregister();
    }
  };

  const scheduler = input.options.backgroundScheduler ?? defaultBackgroundScheduler;
  try {
    scheduler(task);
  } catch (error) {
    input.controller.unregister();
    throw error;
  }
}

async function finalizeCompletedWorkflowRun(
  input: ScheduleBackgroundWorkflowInput,
  manifest: WorkflowManifestUpdater,
  journal: WorkflowJournalRecorder,
  runResult: WorkflowRunResult,
): Promise<void> {
  const outputPath = await input.store
    .writeOutput(
      input.state.runId,
      createCompletedOutput(input.state, input.paths, runResult, input.resumeFromRunId),
    )
    .catch(() => undefined);
  const effectiveOutputPath = outputPath ?? input.paths.outputPath;
  manifest.complete({
    outputPath: effectiveOutputPath,
    result: runResult.result,
    durationMs: runResult.durationMs,
    totalTokens: runResult.totalTokens,
    totalToolCalls: runResult.totalToolCalls,
  });
  await manifest.flush().catch(() => undefined);
  await flushTerminalJournal(manifest, journal);
  notifyCompletion(input.options, {
    ...baseCompletionNotification(input, effectiveOutputPath),
    status: "completed",
    resultPreview: compactPreview(runResult.result),
    usage: usageFromRunResult(runResult),
  });
}

async function finalizeCancelledWorkflowRun(
  input: ScheduleBackgroundWorkflowInput,
  manifest: WorkflowManifestUpdater,
  journal: WorkflowJournalRecorder,
  reason: string,
): Promise<void> {
  const outputPath = await input.store
    .writeOutput(input.state.runId, createCancelledOutput(input.state, input.paths, reason))
    .catch(() => undefined);
  const effectiveOutputPath = outputPath ?? input.paths.outputPath;
  journal.stoppedActive(reason);
  manifest.cancel(reason, { outputPath: effectiveOutputPath });
  await manifest.flush().catch(() => undefined);
  await flushTerminalJournal(manifest, journal);
  notifyCompletion(input.options, {
    ...baseCompletionNotification(input, effectiveOutputPath),
    status: "cancelled",
    error: reason,
    usage: usageFromState(input.state),
  });
}

async function finalizeFailedWorkflowRun(
  input: ScheduleBackgroundWorkflowInput,
  manifest: WorkflowManifestUpdater,
  journal: WorkflowJournalRecorder,
  error: unknown,
): Promise<void> {
  const outputPath = await input.store
    .writeOutput(input.state.runId, createFailedOutput(input.state, input.paths, error))
    .catch(() => undefined);
  const effectiveOutputPath = outputPath ?? input.paths.outputPath;
  journal.failedActive(error);
  manifest.fail(error, { outputPath: effectiveOutputPath });
  await manifest.flush().catch(() => undefined);
  await flushTerminalJournal(manifest, journal);
  notifyCompletion(input.options, {
    ...baseCompletionNotification(input, effectiveOutputPath),
    status: "failed",
    error: errorMessage(error),
    usage: usageFromState(input.state),
  });
}

async function flushTerminalJournal(
  manifest: WorkflowManifestUpdater,
  journal: WorkflowJournalRecorder,
): Promise<void> {
  try {
    await journal.flush();
  } catch (error) {
    manifest.log(`journal persistence failed: ${errorMessage(error)}`);
    await manifest.flush().catch(() => undefined);
  }
}

function baseCompletionNotification(
  input: ScheduleBackgroundWorkflowInput,
  outputPath: string,
): Pick<
  WorkflowCompletionNotification,
  "runId" | "taskId" | "workflowName" | "artifactDir" | "outputPath"
> {
  return {
    runId: input.state.runId,
    taskId: input.state.taskId,
    workflowName: input.state.workflowName,
    artifactDir: input.paths.runDir,
    outputPath,
  };
}

function createLaunchDetails(
  meta: WorkflowMeta,
  state: WorkflowRunState,
  paths: WorkflowRunPaths,
  resumeFromRunId?: string,
): WorkflowToolDetails {
  return {
    status: "launched",
    runId: state.runId,
    taskId: state.taskId,
    artifactDir: paths.runDir,
    outputPath: paths.outputPath,
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    workflowName: meta.name,
    description: meta.description,
    phases: meta.phases.map((phase) => phase.title),
    logs: [],
    agents: [],
    agentCount: 0,
  };
}

function createCompletedOutput(
  state: WorkflowRunState,
  paths: WorkflowRunPaths,
  result: WorkflowRunResult,
  resumeFromRunId?: string,
): Record<string, unknown> {
  return {
    status: "completed",
    runId: state.runId,
    taskId: state.taskId,
    workflowName: result.meta.name,
    outputPath: paths.outputPath,
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
    result: result.result,
    logs: result.logs,
    phases: result.phases,
    agentCount: result.agentCount,
    durationMs: result.durationMs,
    totalTokens: result.totalTokens,
    totalToolCalls: result.totalToolCalls,
    usage: usageFromRunResult(result),
  };
}

function createFailedOutput(
  state: WorkflowRunState,
  paths: WorkflowRunPaths,
  error: unknown,
): Record<string, unknown> {
  return {
    status: "failed",
    runId: state.runId,
    taskId: state.taskId,
    workflowName: state.workflowName,
    outputPath: paths.outputPath,
    error: errorMessage(error),
  };
}

function createCancelledOutput(
  state: WorkflowRunState,
  paths: WorkflowRunPaths,
  reason: string,
): Record<string, unknown> {
  return {
    status: "cancelled",
    runId: state.runId,
    taskId: state.taskId,
    workflowName: state.workflowName,
    outputPath: paths.outputPath,
    reason,
    usage: usageFromState(state),
  };
}

export function createWorkflowCompletionNotifier(
  pi: Pick<ExtensionAPI, "sendMessage">,
): WorkflowCompletionNotifier {
  return (notification) => {
    pi.sendMessage(
      {
        customType: "dynamic-workflow-completion",
        content: formatWorkflowCompletionMessage(notification),
        display: true,
        details: notification,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };
}

function notifyCompletion(
  options: WorkflowToolOptions,
  notification: WorkflowCompletionNotification,
) {
  try {
    options.completionNotifier?.(notification);
  } catch {
    // Completion notification failures must not rewrite terminal workflow state.
  }
}

function formatWorkflowCompletionMessage(notification: WorkflowCompletionNotification): string {
  const status =
    notification.status === "completed"
      ? "完了"
      : notification.status === "cancelled"
        ? "キャンセル"
        : "失敗";
  const resultOrError = notification.error
    ? `\nエラー: ${notification.error}`
    : notification.resultPreview
      ? `\n結果: ${notification.resultPreview}`
      : "";
  return (
    [
      `/workflow: ワークフロー「${notification.workflowName}」が${status}しました。`,
      `runId: ${notification.runId}`,
      `output: ${notification.outputPath}`,
      `usage: agents=${notification.usage.agentCount}, tokens=${notification.usage.totalTokens}, toolCalls=${notification.usage.totalToolCalls}${notification.usage.durationMs === undefined ? "" : `, durationMs=${notification.usage.durationMs}`}`,
    ].join("\n") + resultOrError
  );
}

function defaultBackgroundScheduler(task: BackgroundTask): void {
  setTimeout(() => {
    void task();
  }, 0);
}

async function readWorkflowScriptForLaunch(
  input: WorkflowToolInput,
  options: {
    cwd: string;
    workflowCatalog: ReturnType<typeof workflowCatalogForRoot>;
    resumePaths?: WorkflowRunPaths;
  },
): Promise<string> {
  if (input.scriptPath !== undefined) {
    return await readWorkflowScriptPath(input.scriptPath, options.cwd);
  }
  if (input.script !== undefined) return input.script;
  if (input.name !== undefined) {
    return (await options.workflowCatalog.resolve(input.name)).script;
  }
  return await readWorkflowScriptForResume(options.resumePaths);
}

async function readWorkflowScriptPath(scriptPath: string, cwd: string): Promise<string> {
  const resolvedPath = resolve(cwd, scriptPath);
  try {
    return await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`workflow scriptPath is unavailable: ${resolvedPath}: ${errorMessage(error)}`);
  }
}

async function readWorkflowScriptForResume(paths: WorkflowRunPaths | undefined): Promise<string> {
  if (paths === undefined) {
    throw new Error(
      "workflow requires `scriptPath`, `script`, `name`, or `resumeFromRunId` to select a workflow script.",
    );
  }
  try {
    return await readFile(paths.scriptPath, "utf8");
  } catch (error) {
    throw new Error(
      `workflow resume run script is unavailable: ${paths.runDir}: ${errorMessage(error)}`,
    );
  }
}

function stripMarkdownFence(script: string): string {
  const text = script.trim();
  const match = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  return (match?.[1] ?? text).trim();
}

function createUnconfiguredAgent(): WorkflowAgent {
  return () => {
    throw new Error("workflow agent runner is not configured.");
  };
}

function workflowAdditionalRoots(
  provider: WorkflowAdditionalRootsProvider | undefined,
  ctx: ExtensionContext | undefined,
): string[] {
  const roots = typeof provider === "function" ? provider(ctx) : provider;
  return [...(roots ?? [])];
}

function textResult(detailsText: string, details: WorkflowToolDetails) {
  return {
    content: [{ type: "text" as const, text: detailsText }],
    details,
    terminate: true,
  };
}

function usageFromRunResult(result: WorkflowRunResult): WorkflowUsageSummary {
  return {
    agentCount: result.agentCount,
    totalTokens: result.totalTokens,
    totalToolCalls: result.totalToolCalls,
    durationMs: result.durationMs,
  };
}

function usageFromState(state: WorkflowRunState): WorkflowUsageSummary {
  return {
    agentCount: state.agentCount,
    totalTokens: state.totalTokens,
    totalToolCalls: state.totalToolCalls,
    durationMs: state.durationMs,
  };
}

function compactPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length <= 800 ? text : `${text.slice(0, 800)}…`;
}

function cancellationReason(controller: WorkflowRunControllerRegistration, error: unknown): string {
  return controller.stopReason ?? errorMessage(controller.signal.reason ?? error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId();
  } catch {
    return undefined;
  }
}

function selectedModelId(model: ExtensionContext["model"]): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as { provider?: unknown; id?: unknown };
  if (typeof candidate.provider === "string" && typeof candidate.id === "string") {
    return `${candidate.provider}/${candidate.id}`;
  }
  if (typeof candidate.id === "string") return candidate.id;
  return undefined;
}

export type WorkflowToolContext = Pick<ExtensionContext, "cwd">;
export type { WorkflowAgentOptions };
