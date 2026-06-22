import vm from "node:vm";
import { createWorkflowAgentJournalKey, type WorkflowAgentJournalKey } from "../journal/key";
import {
  createWorkflowJournalAgentId,
  type WorkflowJournalAgentId,
  type WorkflowJournalAgentIdFactory,
} from "../journal/model";
import type { WorkflowReplayCache } from "../journal/replay";
import { parseWorkflowScript, type WorkflowMeta } from "./parser";

export type JsonSchema = Record<string, unknown>;

export type WorkflowAgentTranscriptTarget = {
  transcriptId: string;
  runId: string;
  taskId: string;
  workflowName?: string;
  transcriptsDir: string;
};

export type WorkflowAgentOptions = {
  label?: string;
  phase?: string;
  schema?: JsonSchema;
  agentType?: string;
  model?: string;
  thinkingLevel?: string;
  isolation?: "worktree";
  signal?: AbortSignal;
  transcript?: WorkflowAgentTranscriptTarget;
};

export type WorkflowAgent = (
  prompt: string,
  options: WorkflowAgentOptions,
) => Promise<unknown> | unknown;

export type WorkflowAgentRuntimeEvent = {
  runAgentId: string;
  label: string;
  phase?: string;
  prompt: string;
  journalKey: WorkflowAgentJournalKey;
  journalAgentId: WorkflowJournalAgentId;
};

export type WorkflowAgentRuntimeControl = {
  signal: AbortSignal;
  get stopReason(): string | undefined;
  unregister(): void;
};

export type WorkflowAgentTranscriptTargetFactoryInput = WorkflowAgentRuntimeEvent & {
  agentIndex: number;
};

export type WorkflowAgentTranscriptTargetFactory = (
  input: WorkflowAgentTranscriptTargetFactoryInput,
) => WorkflowAgentTranscriptTarget | undefined;

export type WorkflowRuntimeOptions = {
  cwd: string;
  args?: unknown;
  agent: WorkflowAgent;
  signal?: AbortSignal;
  maxConcurrentAgents?: number;
  maxTotalAgents?: number;
  tokenBudget?: number;
  selectedModel?: string;
  selectedThinkingLevel?: string;
  journalAgentIdFactory?: WorkflowJournalAgentIdFactory;
  replayCache?: WorkflowReplayCache;
  transcriptTargetFactory?: WorkflowAgentTranscriptTargetFactory;
  agentControlFactory?: (event: WorkflowAgentRuntimeEvent) => WorkflowAgentRuntimeControl;
  onPhase?: (title: string) => void;
  onLog?: (message: string) => void;
  onAgentQueued?: (event: WorkflowAgentRuntimeEvent) => void;
  onAgentStart?: (event: WorkflowAgentRuntimeEvent) => void;
  onAgentStop?: (event: WorkflowAgentRuntimeEvent, reason: string) => void;
  onAgentEnd?: (event: WorkflowAgentRuntimeEvent & { result: unknown; error?: string }) => void;
};

export type WorkflowRunResult = {
  meta: WorkflowMeta;
  result: unknown;
  logs: string[];
  phases: string[];
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  durationMs: number;
};

type RuntimeState = {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  spentTokens: number;
};

const MAX_PARALLEL_ITEMS = 4096;
const WORKFLOW_LIMIT_ERROR_NAME = "WorkflowLimitError";
const DEFAULT_MAX_CONCURRENT_AGENTS = 4;
const DEFAULT_MAX_TOTAL_AGENTS = 64;

type RuntimeLimits = {
  maxConcurrentAgents: number;
  maxTotalAgents: number;
  tokenBudget: number | null;
};

export class WorkflowRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRuntimeError";
  }
}

class WorkflowLimitError extends WorkflowRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = WORKFLOW_LIMIT_ERROR_NAME;
  }
}

export async function runWorkflow(
  script: string,
  options: WorkflowRuntimeOptions,
): Promise<WorkflowRunResult> {
  const startedAt = Date.now();
  const parsed = parseWorkflowScript(script);
  const state: RuntimeState = {
    logs: [],
    phases: [],
    agentCount: 0,
    spentTokens: 0,
  };
  const limits = normalizeRuntimeLimits(options);
  const runWithAgentConcurrency = createLimiter(limits.maxConcurrentAgents);

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new WorkflowRuntimeError("Workflow was aborted.");
  };

  const log = (message: unknown): void => {
    const text = String(message);
    state.logs.push(text);
    options.onLog?.(text);
  };

  const phase = (title: unknown): void => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onPhase?.(text);
  };

  const agent = async (prompt: unknown, rawOptions: unknown = {}): Promise<unknown> => {
    throwIfAborted();
    const taskPrompt = requireString(prompt, "agent prompt");
    const agentOptions = normalizeAgentOptions(rawOptions);
    const assignedPhase = agentOptions.phase ?? state.currentPhase;
    reserveAgentSlot(state, limits);
    const agentIndex = state.agentCount;
    const runAgentId = `agent_${agentIndex}`;
    const label = agentOptions.label?.trim() || defaultAgentLabel(assignedPhase, agentIndex);
    const journalKey = createWorkflowAgentJournalKey({
      prompt: taskPrompt,
      schema: agentOptions.schema,
      label,
      phase: assignedPhase,
      agentType: agentOptions.agentType,
      model: agentOptions.model ?? options.selectedModel,
      thinkingLevel: agentOptions.thinkingLevel ?? options.selectedThinkingLevel,
      isolation: agentOptions.isolation,
      cwd: options.cwd,
    });
    const journalAgentId = options.journalAgentIdFactory?.() ?? createWorkflowJournalAgentId();
    const event: WorkflowAgentRuntimeEvent = {
      runAgentId,
      label,
      ...(assignedPhase === undefined ? {} : { phase: assignedPhase }),
      prompt: taskPrompt,
      journalKey,
      journalAgentId,
    };
    options.onAgentQueued?.(event);
    const replayResult = options.replayCache?.resultsByKey.get(journalKey);
    if (replayResult !== undefined) {
      options.onAgentStart?.(event);
      options.onAgentEnd?.({ ...event, result: replayResult.result });
      return replayResult.result;
    }

    const control = options.agentControlFactory?.(event);
    const combinedSignal = combineAbortSignals(options.signal, control?.signal);
    const agentSignal = combinedSignal.signal;
    const transcript = options.transcriptTargetFactory?.({ ...event, agentIndex });
    const effectiveOptions: WorkflowAgentOptions = {
      ...agentOptions,
      label,
      ...(assignedPhase === undefined ? {} : { phase: assignedPhase }),
      ...(agentSignal === undefined ? {} : { signal: agentSignal }),
      ...(transcript === undefined ? {} : { transcript }),
    };

    try {
      const rawResult = await runWithAgentConcurrency(async () => {
        throwIfAborted();
        throwIfAgentStopped(control);
        options.onAgentStart?.(event);
        return options.agent(taskPrompt, effectiveOptions);
      }, agentSignal);
      const result = toContextValue(context, rawResult, "agent result");
      throwIfAborted();
      throwIfAgentStopped(control);
      state.spentTokens += estimateTokens(result);
      throwIfTokenBudgetExceeded(state, limits);
      options.onAgentEnd?.({ ...event, result });
      return result;
    } catch (error) {
      if (options.signal?.aborted || isHardStopError(error)) throw error;
      if (control?.signal.aborted) {
        const reason = agentStopReason(control, error);
        options.onAgentStop?.(event, reason);
        return null;
      }
      const message = errorMessage(error);
      log(`agent ${label} failed: ${message}`);
      options.onAgentEnd?.({
        ...event,
        result: null,
        error: message,
      });
      return null;
    } finally {
      combinedSignal.cleanup();
      control?.unregister();
    }
  };

  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions.");
    if (thunks.length > MAX_PARALLEL_ITEMS) {
      throw new RangeError(`parallel() supports at most ${MAX_PARALLEL_ITEMS} branches.`);
    }
    return Promise.all(
      thunks.map(async (thunk, index) => {
        if (typeof thunk !== "function") {
          throw new TypeError(
            "parallel() expects functions, not promises. Wrap each branch as `() => agent(...)`.",
          );
        }
        try {
          throwIfAborted();
          return await thunk();
        } catch (error) {
          if (options.signal?.aborted || isHardStopError(error)) throw error;
          log(`parallel[${index}] failed: ${errorMessage(error)}`);
          return null;
        }
      }),
    );
  };

  const pipeline = async (
    items: unknown,
    ...stages: Array<(previous: unknown, original: unknown, index: number) => unknown>
  ): Promise<unknown[]> => {
    if (!Array.isArray(items))
      throw new TypeError("pipeline() expects an array as the first argument.");
    if (items.length > MAX_PARALLEL_ITEMS) {
      throw new RangeError(`pipeline() supports at most ${MAX_PARALLEL_ITEMS} items.`);
    }
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions.");
    }

    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of stages) {
          try {
            throwIfAborted();
            value = await stage(value, item, index);
            throwIfAborted();
          } catch (error) {
            if (options.signal?.aborted || isHardStopError(error)) throw error;
            log(`pipeline[${index}] failed: ${errorMessage(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  };

  let context!: vm.Context;
  const hostApi = Object.freeze(
    Object.assign(Object.create(null), {
      agent: safeHostFunction(async (...input: unknown[]) => agent(input[0], input[1])),
      parallel: safeHostFunction(async (thunks: unknown) => {
        const value = await parallel(thunks);
        return toContextValue(context, value, "parallel result");
      }),
      pipeline: safeHostFunction(async (items: unknown, ...stages: unknown[]) => {
        const value = await pipeline(
          items,
          ...(stages as Array<(previous: unknown, original: unknown, index: number) => unknown>),
        );
        return toContextValue(context, value, "pipeline result");
      }),
      phase: safeHostFunction(phase),
      log: safeHostFunction(log),
      budgetTotal: safeHostFunction(() => limits.tokenBudget),
      budgetSpent: safeHostFunction(() => state.spentTokens),
      budgetRemaining: safeHostFunction(() =>
        limits.tokenBudget === null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, limits.tokenBudget - state.spentTokens),
      ),
    }),
  );

  context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  Object.assign(context, {
    __workflowHost: hostApi,
    __workflowArgsJson: serializeForContext(options.args, "workflow args"),
    __workflowCwd: options.cwd,
  });
  installWorkflowGlobals(context);

  const wrapped = `(async () => {\n"use strict";\n${parsed.executableScript}\n})()`;
  const result = await new vm.Script(wrapped, {
    filename: `${parsed.meta.name || "workflow"}.js`,
  }).runInContext(context);

  assertJsonSerializable(result, "workflow result");

  return {
    meta: parsed.meta,
    result,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    totalTokens: state.spentTokens,
    totalToolCalls: 0,
    durationMs: Date.now() - startedAt,
  };
}

function installWorkflowGlobals(context: vm.Context): void {
  new vm.Script(
    `
      {
        const host = globalThis.__workflowHost;
        const workflowArgs = globalThis.__workflowArgsJson === undefined
          ? undefined
          : JSON.parse(globalThis.__workflowArgsJson);
        const workflowCwd = globalThis.__workflowCwd;
        const safeMath = Object.create(null);
        for (const key of Object.getOwnPropertyNames(Math)) {
          if (key !== "random") {
            Object.defineProperty(safeMath, key, Object.getOwnPropertyDescriptor(Math, key));
          }
        }
        Object.freeze(safeMath);

        function hostErrorMessage(error) {
          if (error && typeof error === "object" && typeof error.message === "string") {
            return error.message;
          }
          return String(error);
        }

        function hostErrorName(error) {
          if (error && typeof error === "object" && error.name === ${JSON.stringify(WORKFLOW_LIMIT_ERROR_NAME)}) {
            return error.name;
          }
          return undefined;
        }

        function throwContextError(error) {
          const contextError = new Error(hostErrorMessage(error));
          const name = hostErrorName(error);
          if (name !== undefined) contextError.name = name;
          throw contextError;
        }

        function callHost(callback) {
          try {
            const value = callback();
            return value && typeof value.then === "function" ? value.catch(throwContextError) : value;
          } catch (error) {
            throwContextError(error);
          }
        }

        Object.defineProperties(globalThis, {
          agent: {
            value: (...input) => callHost(() => host.agent(...input)),
            enumerable: true,
          },
          parallel: {
            value: (...input) => callHost(() => host.parallel(...input)),
            enumerable: true,
          },
          pipeline: {
            value: (...input) => callHost(() => host.pipeline(...input)),
            enumerable: true,
          },
          phase: {
            value: (title) => callHost(() => host.phase(title)),
            enumerable: true,
          },
          log: {
            value: (message) => callHost(() => host.log(message)),
            enumerable: true,
          },
          args: {
            value: workflowArgs,
            enumerable: true,
          },
          cwd: {
            value: workflowCwd,
            enumerable: true,
          },
          process: {
            value: Object.freeze({ cwd: () => workflowCwd }),
            enumerable: true,
          },
          budget: {
            value: Object.freeze({
              total: callHost(() => host.budgetTotal()),
              spent: () => callHost(() => host.budgetSpent()),
              remaining: () => callHost(() => host.budgetRemaining()),
            }),
            enumerable: true,
          },
          console: {
            value: Object.freeze({
              log: (...items) => callHost(() => host.log(items.map(String).join(" "))),
              info: (...items) => callHost(() => host.log(items.map(String).join(" "))),
              warn: (...items) => callHost(() => host.log("[warn] " + items.map(String).join(" "))),
              error: (...items) => callHost(() => host.log("[error] " + items.map(String).join(" "))),
            }),
            enumerable: true,
          },
          Date: {
            value: undefined,
          },
          Math: {
            value: safeMath,
          },
        });

        delete globalThis.SharedArrayBuffer;
        delete globalThis.Atomics;
        delete globalThis.__workflowHost;
        delete globalThis.__workflowArgsJson;
        delete globalThis.__workflowCwd;
      }
    `,
    { filename: "workflow-globals.js" },
  ).runInContext(context);
}

function safeHostFunction<T extends (...args: never[]) => unknown>(fn: T): T {
  const wrapper = ((...args: Parameters<T>) => fn(...(args as never[]))) as T;
  Object.defineProperty(wrapper, "constructor", {
    value: undefined,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.setPrototypeOf(wrapper, null);
  return Object.freeze(wrapper);
}

function toContextValue(context: vm.Context, value: unknown, label: string): unknown {
  const json = serializeForContext(value, label);
  if (json === undefined) return undefined;

  Object.assign(context, { __workflowValueJson: json });
  try {
    return new vm.Script("JSON.parse(globalThis.__workflowValueJson)").runInContext(context);
  } finally {
    delete (context as { __workflowValueJson?: string }).__workflowValueJson;
  }
}

function serializeForContext(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new WorkflowRuntimeError(`${label} must be JSON-serializable.`);
    }
    return json;
  } catch (error) {
    if (error instanceof WorkflowRuntimeError) throw error;
    const message = error instanceof Error ? ` ${error.message}` : "";
    throw new WorkflowRuntimeError(`${label} must be JSON-serializable.${message}`);
  }
}

function normalizeRuntimeLimits(
  options: Pick<WorkflowRuntimeOptions, "maxConcurrentAgents" | "maxTotalAgents" | "tokenBudget">,
): RuntimeLimits {
  return {
    maxConcurrentAgents: normalizePositiveInteger(
      options.maxConcurrentAgents,
      "maxConcurrentAgents",
      DEFAULT_MAX_CONCURRENT_AGENTS,
    ),
    maxTotalAgents: normalizePositiveInteger(
      options.maxTotalAgents,
      "maxTotalAgents",
      DEFAULT_MAX_TOTAL_AGENTS,
    ),
    tokenBudget: normalizeTokenBudget(options.tokenBudget),
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  label: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new WorkflowRuntimeError(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeTokenBudget(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkflowRuntimeError("tokenBudget must be a non-negative integer.");
  }
  return value;
}

function reserveAgentSlot(state: RuntimeState, limits: RuntimeLimits): void {
  throwIfTokenBudgetExhausted(state, limits);
  if (state.agentCount >= limits.maxTotalAgents) {
    throw new WorkflowLimitError(
      `workflow max total agents exceeded: ${state.agentCount + 1}/${limits.maxTotalAgents}`,
    );
  }
  state.agentCount += 1;
}

function throwIfTokenBudgetExhausted(state: RuntimeState, limits: RuntimeLimits): void {
  if (limits.tokenBudget !== null && state.spentTokens >= limits.tokenBudget) {
    throw new WorkflowLimitError(
      `workflow token budget exhausted: spent ${state.spentTokens}/${limits.tokenBudget}`,
    );
  }
}

function throwIfTokenBudgetExceeded(state: RuntimeState, limits: RuntimeLimits): void {
  if (limits.tokenBudget !== null && state.spentTokens > limits.tokenBudget) {
    throw new WorkflowLimitError(
      `workflow token budget exceeded: spent ${state.spentTokens}/${limits.tokenBudget}`,
    );
  }
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function runLimited<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    throwIfSignalAborted(signal);
    if (active >= limit) {
      await waitForLimiterSlot(queue, signal);
    }
    throwIfSignalAborted(signal);

    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

async function waitForLimiterSlot(queue: Array<() => void>, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let queued = true;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const resume = () => {
      if (!queued) return;
      queued = false;
      cleanup();
      resolve();
    };
    const abort = () => {
      if (!queued) return;
      queued = false;
      cleanup();
      const index = queue.indexOf(resume);
      if (index >= 0) queue.splice(index, 1);
      reject(abortError(signal));
    };

    queue.push(resume);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function combineAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): { signal?: AbortSignal; cleanup: () => void } {
  if (first === undefined || second === undefined) {
    return { signal: first ?? second, cleanup: () => {} };
  }

  const controller = new AbortController();
  const abortFirst = () => abort(first);
  const abortSecond = () => abort(second);
  const cleanup = () => {
    first.removeEventListener("abort", abortFirst);
    second.removeEventListener("abort", abortSecond);
  };
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    cleanup();
  };
  first.addEventListener("abort", abortFirst, { once: true });
  second.addEventListener("abort", abortSecond, { once: true });
  if (first.aborted) abort(first);
  if (second.aborted) abort(second);
  return { signal: controller.signal, cleanup };
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function throwIfAgentStopped(control: WorkflowAgentRuntimeControl | undefined): void {
  if (control?.signal.aborted) {
    throw new WorkflowRuntimeError(agentStopReason(control, control.signal.reason));
  }
}

function agentStopReason(control: WorkflowAgentRuntimeControl, fallback: unknown): string {
  return (
    control.stopReason ??
    errorMessage(control.signal.reason ?? fallback ?? "workflow agent stopped")
  );
}

function abortError(signal: AbortSignal | undefined): WorkflowRuntimeError {
  return new WorkflowRuntimeError(errorMessage(signal?.reason ?? "aborted"));
}

function normalizeAgentOptions(value: unknown): WorkflowAgentOptions {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new TypeError("agent options must be an object.");

  return {
    label: optionalString(value.label, "agent label"),
    phase: optionalString(value.phase, "agent phase"),
    schema:
      value.schema === undefined ? undefined : requirePlainObject(value.schema, "agent schema"),
    agentType: optionalString(value.agentType, "agent type"),
    model: optionalString(value.model, "agent model"),
    thinkingLevel: optionalString(value.thinkingLevel, "agent thinkingLevel"),
    isolation: value.isolation === undefined ? undefined : requireIsolation(value.isolation),
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function requirePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireIsolation(value: unknown): "worktree" {
  if (value !== "worktree") throw new TypeError("agent isolation must be 'worktree' when present.");
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function assertJsonSerializable(value: unknown, label: string): void {
  serializeForContext(value, label);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isPlainObject(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function isHardStopError(error: unknown): boolean {
  if (error instanceof WorkflowLimitError) return true;
  return isPlainObject(error) && error.name === WORKFLOW_LIMIT_ERROR_NAME;
}
