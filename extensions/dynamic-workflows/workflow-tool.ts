import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CliExec } from "../../lib/cli";
import { createWorkflowAgentTranscriptId } from "./agent/transcript";
import type { WorkflowJournalAgentIdFactory } from "./journal/model";
import { WorkflowJournalRecorder } from "./journal/recorder";
import { loadWorkflowReplayCache, type WorkflowReplayCache } from "./journal/replay";
import { WorkflowJournalStore } from "./journal/store";
import { prepareReviewFlowLaunch, reauthorizeReviewFlowMutation } from "./review-authorization";
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
import { savedWorkflowSelection } from "./saved/launch-selection";
import type { SavedWorkflow, SavedWorkflowRootInput } from "./saved/resolver";
import { createWorkflowCallComponent, createWorkflowResultComponent } from "./ui/render-tool";
import { refreshWorkflowWidget } from "./ui/workflow-widget";

const PHASE_TITLE_EXAMPLE = 'phases: [{ title: "Inspect" }]';
const PHASE_DESCRIPTION_EXAMPLE = 'phases: [{ title: "Inspect", description: "..." }]';

const workflowToolSchema = Type.Object({
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Path to a workflow JavaScript file to execute. Relative paths are resolved from the session cwd. Takes precedence over script and name.",
    }),
  ),
  script: Type.Optional(
    Type.String({
      description: `Raw JavaScript workflow script. It must start with \`export const meta = { name, description, phases }\`; \`meta.phases\` entries must follow \`${PHASE_TITLE_EXAMPLE}\` or \`${PHASE_DESCRIPTION_EXAMPLE}\` (write actual JavaScript with \`title\`, not strings or \`name\`). Available globals are agent, parallel, pipeline, phase, log, args, cwd, process.cwd(), budget, and console. parallel() takes thunks such as \`[() => agent(...)]\`, never promises. agent(prompt, options) supports label, phase, schema, agentType, model in \`provider/model[:effort]\` form, \`toolPolicy: "readOnly"\`, and an optional \`allowedTools\` string array; thinkingLevel, effort, and isolation options are unsupported. Host globals, imports, eval, and code generation are forbidden. It must call agent() at least once. Used when scriptPath is omitted, before name.`,
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: `Saved workflow name resolved from project ${CONFIG_DIR_NAME}/workflows/*.js, loaded skill-packaged workflows/*.js, or extension-packaged workflows/*.js by static meta.name parsing. Used when scriptPath and script are omitted.`,
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
  estimatedResultTokens: number;
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

export type WorkflowLifecycleStatus = "started" | WorkflowCompletionStatus;

export type WorkflowLifecycleNotification = Omit<
  WorkflowCompletionNotification,
  "status" | "usage"
> & {
  status: WorkflowLifecycleStatus;
};

export type WorkflowLifecycleNotifier = (notification: WorkflowLifecycleNotification) => void;

type BackgroundTask = () => Promise<void>;

export const defaultWorkflowRunControllerRegistry = new WorkflowRunControllerRegistry();

export type WorkflowAdditionalRootsProvider =
  | readonly SavedWorkflowRootInput[]
  | ((ctx: ExtensionContext | undefined) => readonly SavedWorkflowRootInput[]);

export type WorkflowToolOptions = {
  exec?: CliExec;
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
  lifecycleNotifier?: WorkflowLifecycleNotifier;
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
      "Execute a deterministic JavaScript workflow that orchestrates isolated subagent work with agent(), parallel(), pipeline(), phase(), and log(). Use only for explicitly requested workflow-style orchestration. Launch review_flow with args files/staged/base/pr/noFix/instructions (precedence: files > pr > base > staged > working tree), or research_flow with task/depth/profile/outputFormat/citationFormat/maxSources.",
    parameters: workflowToolSchema,
    prepareArguments: normalizeWorkflowToolInput,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await launchWorkflowRun(options, ctx, params as WorkflowToolInput, signal);
      return textResult(
        `Workflow ${result.workflowName} launched in background as ${result.runId}. Artifacts: ${result.artifactDir}`,
        result.details,
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

/**
 * Structured result of launching a workflow run. Mirrors the identifiers and
 * `details` returned by the `workflow` LLM Tool so a programmatic caller and the
 * tool observe identical run artifacts and notification semantics.
 */
export type WorkflowLaunchResult = {
  runId: string;
  taskId: string;
  workflowName: string;
  artifactDir: string;
  outputPath: string;
  resumeFromRunId?: string;
  details: WorkflowToolDetails;
};

/**
 * A generic bound programmatic launcher for callers that need workflow
 * scheduling, storage, widget, and completion-notification behavior without
 * duplicating it.
 */
export type WorkflowLaunchBridge = (
  input: WorkflowToolInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) => Promise<WorkflowLaunchResult>;

/**
 * Launch a workflow run programmatically with the same scheduling, run-artifact
 * creation, widget refresh, and completion-notification behavior as the
 * `workflow` LLM Tool. Returns once initial run artifacts are written and the
 * run is scheduled in the background; it does not await completion.
 */
export async function launchWorkflowRun(
  options: WorkflowToolOptions,
  ctx: ExtensionContext,
  rawInput: WorkflowToolInput,
  signal?: AbortSignal,
): Promise<WorkflowLaunchResult> {
  if (signal?.aborted) throw new Error("workflow launch was aborted.");

  const preservedSavedWorkflow = snapshotSavedWorkflow(savedWorkflowSelection(rawInput));
  const input = normalizeWorkflowToolInput(rawInput);
  const runId = options.runIdFactory?.() ?? createWorkflowRunId();
  const taskId = options.taskIdFactory?.() ?? createTaskId();
  const controllerRegistry = options.controllerRegistry ?? defaultWorkflowRunControllerRegistry;
  const controller = controllerRegistry.register(runId);
  const lifecycle = createWorkflowLifecycleCompletion();
  controller.trackCompletion(lifecycle.completion);
  const stopForParentAbort = () => controller.stop("workflow launch was aborted.");
  signal?.addEventListener("abort", stopForParentAbort, { once: true });

  let prepared: ScheduleBackgroundWorkflowInput;
  try {
    const cwd = options.cwd ?? ctx.cwd;
    const effectiveCtx = workflowToolContextWithCwd(ctx, cwd);
    const agent =
      options.agent ?? options.agentFactory?.(effectiveCtx) ?? createUnconfiguredAgent();
    const workflowRoot = options.workflowRoot ?? resolveWorkflowRoot(cwd);
    const workflowCatalog = workflowCatalogForRoot(
      workflowRoot,
      workflowAdditionalRoots(options.additionalWorkflowRoots, effectiveCtx),
    );
    let args = snapshotWorkflowArgs(input.args);
    throwIfWorkflowLaunchStopped(controller);
    const resumePaths =
      input.resumeFromRunId === undefined
        ? undefined
        : getWorkflowRunPaths(workflowRoot, input.resumeFromRunId);
    const selectedWorkflow = await readWorkflowScriptForLaunch(input, {
      cwd,
      workflowCatalog,
      resumePaths,
      preservedSavedWorkflow,
    });
    throwIfWorkflowLaunchStopped(controller);
    const replayCache =
      resumePaths === undefined
        ? undefined
        : await loadWorkflowReplayCache(resumePaths.journalPath);
    throwIfWorkflowLaunchStopped(controller);
    const parsed = parseWorkflowScript(selectedWorkflow.script);
    if (!executableScriptCallsAgent(parsed.executableScript)) {
      throw new Error("workflow scripts must call agent() at least once.");
    }
    const reviewPreparation = await prepareReviewFlowLaunch({
      workflow: selectedWorkflow.savedWorkflow,
      args,
      exec: options.exec,
      cwd,
      signal: controller.signal,
    });
    args = reviewPreparation.args;
    const trustedRuntimeContext = reviewPreparation.trustedRuntimeContext;
    throwIfWorkflowLaunchStopped(controller);

    const paths = getWorkflowRunPaths(workflowRoot, runId);
    const state = createInitialWorkflowRunState({
      runId,
      taskId,
      sessionId: getSessionId(effectiveCtx),
      cwd,
      workflowName: parsed.meta.name,
      description: parsed.meta.description,
      phases: parsed.meta.phases,
      scriptPath: paths.scriptPath,
    });
    const store = new WorkflowRunStore(workflowRoot);
    const createdPaths = await store.createRun({ state, script: selectedWorkflow.script });
    prepared = {
      store,
      paths: createdPaths,
      script: selectedWorkflow.script,
      args,
      trustedRuntimeContext,
      cwd,
      agent,
      meta: parsed.meta,
      state,
      options,
      controller,
      ctx: effectiveCtx,
      replayCache,
      resumeFromRunId: input.resumeFromRunId,
    };
  } catch (error) {
    signal?.removeEventListener("abort", stopForParentAbort);
    finishWorkflowController(controller, lifecycle.settle);
    throw error;
  }

  const manifest = createWorkflowManifest(prepared);
  const journal = createWorkflowJournal(prepared.paths);
  let scheduled = false;
  try {
    try {
      refreshWorkflowWidget(prepared.ctx, prepared.state);
    } catch {
      // UI rendering is best-effort and must not strand a persisted queued run.
    }
    notifyLifecycle(options, {
      ...baseWorkflowNotification(prepared, prepared.paths.outputPath),
      status: "started",
    });

    if (controller.signal.aborted) {
      const reason = cancellationReason(controller, controller.signal.reason);
      await finalizeCancelledWorkflowRun(prepared, manifest, journal, reason);
      throw new Error(reason);
    }

    try {
      scheduleBackgroundWorkflow(prepared, manifest, journal, lifecycle.settle);
    } catch (error) {
      if (controller.signal.aborted) {
        await finalizeCancelledWorkflowRun(
          prepared,
          manifest,
          journal,
          cancellationReason(controller, error),
        );
      } else {
        await finalizeFailedWorkflowRun(prepared, manifest, journal, error);
      }
      throw error;
    }
    scheduled = true;
  } finally {
    signal?.removeEventListener("abort", stopForParentAbort);
    if (!scheduled) finishWorkflowController(controller, lifecycle.settle);
  }

  const details = createLaunchDetails(
    prepared.meta,
    prepared.state,
    prepared.paths,
    input.resumeFromRunId,
  );
  return {
    runId,
    taskId,
    workflowName: prepared.meta.name,
    artifactDir: prepared.paths.runDir,
    outputPath: prepared.paths.outputPath,
    ...(input.resumeFromRunId === undefined ? {} : { resumeFromRunId: input.resumeFromRunId }),
    details,
  };
}

/**
 * Build a launcher bound to the given options. dynamic-workflows constructs this
 * from the same options it uses for the `workflow` tool, so packaged-preset
 * callers share its agent runner, controller registry, completion notifier, and
 * packaged/skill roots.
 */
export function createWorkflowLaunchBridge(options: WorkflowToolOptions): WorkflowLaunchBridge {
  return (input, ctx, signal) => launchWorkflowRun(options, ctx, input, signal);
}

type ScheduleBackgroundWorkflowInput = {
  store: WorkflowRunStore;
  paths: WorkflowRunPaths;
  script: string;
  args?: unknown;
  trustedRuntimeContext?: unknown;
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

function reviewFlowAgentWithFreshMutationAuthorization(
  input: ScheduleBackgroundWorkflowInput,
): WorkflowAgent {
  return async (prompt, options) => {
    if (options.label !== "fix") return input.agent(prompt, options);
    const reviewFlow =
      input.trustedRuntimeContext && typeof input.trustedRuntimeContext === "object"
        ? (input.trustedRuntimeContext as { reviewFlow?: { prSelector?: unknown } }).reviewFlow
        : undefined;
    if (typeof reviewFlow?.prSelector !== "string") return input.agent(prompt, options);

    const authorized = await reauthorizeReviewFlowMutation({
      trustedRuntimeContext: input.trustedRuntimeContext,
      exec: input.options.exec,
      cwd: input.cwd,
      signal: input.controller.signal,
    });
    if (!authorized) {
      return {
        changes: [],
        notes: "Host reauthorization failed immediately before PR mutation; Fix was skipped.",
        mutationAuthorized: false,
      };
    }
    return input.agent(prompt, options);
  };
}

function scheduleBackgroundWorkflow(
  input: ScheduleBackgroundWorkflowInput,
  manifest: WorkflowManifestUpdater,
  journal: WorkflowJournalRecorder,
  settleCompletion: () => void,
): void {
  const task = async () => {
    try {
      manifest.markRunning();
      const runResult = await runWorkflow(input.script, {
        cwd: input.cwd,
        args: input.args,
        trustedRuntimeContext: input.trustedRuntimeContext,
        agent: reviewFlowAgentWithFreshMutationAuthorization(input),
        signal: input.controller.signal,
        maxConcurrentAgents: input.options.maxConcurrentAgents,
        maxTotalAgents: input.options.maxTotalAgents,
        tokenBudget: input.options.tokenBudget,
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
        onPhase: (title) => manifest.phase(title),
        onLog: (message) => manifest.log(message),
        onAgentQueued: (event) => manifest.agentQueued(event),
        onAgentStart(event) {
          manifest.agentStarted(event);
          journal.started(event);
        },
        onAgentStop(event, reason) {
          manifest.agentStopped(event, reason);
          journal.stopped(event, reason);
        },
        onAgentEnd(event) {
          if (event.error) {
            manifest.agentFailed({ ...event, error: event.error });
            journal.failed(event, event.error);
          } else {
            manifest.agentCompleted(event);
            journal.result(event);
          }
        },
        onEstimatedResultTokensChange(estimatedResultTokens) {
          manifest.updateEstimatedResultTokens(estimatedResultTokens);
        },
      });

      if (runResult.agentCount === 0) {
        throw new Error("workflow scripts must call agent() at least once.");
      }

      await finalizeCompletedWorkflowRun(input, manifest, journal, runResult);
    } catch (error) {
      if (input.controller.signal.aborted) {
        const reason = cancellationReason(input.controller, error);
        await finalizeCancelledWorkflowRun(input, manifest, journal, reason);
      } else {
        await finalizeFailedWorkflowRun(input, manifest, journal, error);
      }
    }
  };

  let scheduled = false;
  const trackedTask = async () => {
    await Promise.resolve();
    if (!scheduled) return;
    try {
      await task();
    } catch {
      // Background failures are already reflected in best-effort terminal artifacts.
    } finally {
      finishWorkflowController(input.controller, settleCompletion);
    }
  };

  const scheduler = input.options.backgroundScheduler ?? defaultBackgroundScheduler;
  scheduler(trackedTask);
  scheduled = true;
}

function createWorkflowManifest(input: ScheduleBackgroundWorkflowInput): WorkflowManifestUpdater {
  return new WorkflowManifestUpdater(input.state, async (state) => {
    await input.store.writeManifest(state);
    refreshWorkflowWidget(input.ctx, state);
  });
}

function createWorkflowJournal(paths: WorkflowRunPaths): WorkflowJournalRecorder {
  return new WorkflowJournalRecorder(new WorkflowJournalStore({ journalPath: paths.journalPath }));
}

function createWorkflowLifecycleCompletion(): {
  completion: Promise<void>;
  settle: () => void;
} {
  let settle!: () => void;
  const completion = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { completion, settle };
}

function finishWorkflowController(
  controller: WorkflowRunControllerRegistration,
  settleCompletion: () => void,
): void {
  try {
    controller.unregister();
  } catch {
    // Controller cleanup failures must not escape a background task.
  } finally {
    settleCompletion();
  }
}

function throwIfWorkflowLaunchStopped(controller: WorkflowRunControllerRegistration): void {
  if (!controller.signal.aborted) return;
  throw new Error(cancellationReason(controller, controller.signal.reason));
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
    estimatedResultTokens: runResult.estimatedResultTokens,
  });
  await manifest.flush().catch(() => undefined);
  await flushTerminalJournal(manifest, journal);
  notifyCompletion(input.options, {
    ...baseWorkflowNotification(input, effectiveOutputPath),
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
    ...baseWorkflowNotification(input, effectiveOutputPath),
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
    ...baseWorkflowNotification(input, effectiveOutputPath),
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

function baseWorkflowNotification(
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
    estimatedResultTokens: result.estimatedResultTokens,
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
  notifyLifecycle(options, notification);
  try {
    options.completionNotifier?.(notification);
  } catch {
    // Completion notification failures must not rewrite terminal workflow state.
  }
}

function notifyLifecycle(
  options: WorkflowToolOptions,
  notification: WorkflowLifecycleNotification,
): void {
  try {
    options.lifecycleNotifier?.(notification);
  } catch {
    // Lifecycle observers must not affect workflow launch or terminal state.
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
      `usage: agents=${notification.usage.agentCount}, estimatedResultTokens=${notification.usage.estimatedResultTokens}${notification.usage.durationMs === undefined ? "" : `, durationMs=${notification.usage.durationMs}`}`,
    ].join("\n") + resultOrError
  );
}

function defaultBackgroundScheduler(task: BackgroundTask): void {
  setTimeout(() => {
    void task();
  }, 0);
}

type SelectedWorkflowScript = {
  script: string;
  savedWorkflow?: SavedWorkflow;
};

async function readWorkflowScriptForLaunch(
  input: WorkflowToolInput,
  options: {
    cwd: string;
    workflowCatalog: ReturnType<typeof workflowCatalogForRoot>;
    resumePaths?: WorkflowRunPaths;
    preservedSavedWorkflow?: SavedWorkflow;
  },
): Promise<SelectedWorkflowScript> {
  if (options.preservedSavedWorkflow !== undefined) {
    return {
      script: options.preservedSavedWorkflow.script,
      savedWorkflow: options.preservedSavedWorkflow,
    };
  }
  if (input.scriptPath !== undefined) {
    return { script: await readWorkflowScriptPath(input.scriptPath, options.cwd) };
  }
  if (input.script !== undefined) return { script: input.script };
  if (input.name !== undefined) {
    const savedWorkflow = await options.workflowCatalog.resolve(input.name);
    return { script: savedWorkflow.script, savedWorkflow };
  }
  return { script: await readWorkflowScriptForResume(options.resumePaths) };
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

function snapshotSavedWorkflow(workflow: SavedWorkflow | undefined): SavedWorkflow | undefined {
  return workflow === undefined
    ? undefined
    : {
        ...workflow,
        phases: workflow.phases.map((phase) => ({ ...phase })),
      };
}

function snapshotWorkflowArgs(args: unknown): unknown {
  if (args === undefined) return undefined;
  try {
    const json = JSON.stringify(args);
    if (json === undefined) throw new Error("workflow args must be JSON-serializable.");
    return JSON.parse(json) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message === "workflow args must be JSON-serializable.") {
      throw error;
    }
    throw new Error(`workflow args must be JSON-serializable: ${errorMessage(error)}`);
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
): SavedWorkflowRootInput[] {
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
    estimatedResultTokens: result.estimatedResultTokens,
    durationMs: result.durationMs,
  };
}

function usageFromState(state: WorkflowRunState): WorkflowUsageSummary {
  return {
    agentCount: state.agentCount,
    estimatedResultTokens: state.estimatedResultTokens,
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

function workflowToolContextWithCwd(ctx: ExtensionContext, cwd: string): ExtensionContext {
  if (ctx.cwd === cwd) return ctx;
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === "cwd") return cwd;
      return Reflect.get(target, property, receiver);
    },
  });
}

export type WorkflowToolContext = Pick<ExtensionContext, "cwd">;
export type { WorkflowAgentOptions };
