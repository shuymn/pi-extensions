import { AsyncLocalStorage } from "node:async_hooks";
import { types as utilTypes } from "node:util";
import vm from "node:vm";
import { Check as checkValue, Errors as valueErrors, Equal as valuesEqual } from "typebox/value";
import { formatModelSpecWithThinking, parseModelSpec } from "../../../lib/model-spec";
import { createWorkflowAgentJournalKey, type WorkflowAgentJournalKey } from "../journal/key";
import {
  createWorkflowJournalAgentId,
  type WorkflowJournalAgentId,
  type WorkflowJournalAgentIdFactory,
} from "../journal/model";
import type { WorkflowReplayCache } from "../journal/replay";
import { parseWorkflowScript, type WorkflowMeta } from "./parser";

export type JsonSchema = Record<string, unknown>;

/**
 * Per-agent execution tool policy. `readOnly` drops file-mutation tools
 * (edit/write) and runs bash through an OS-sandboxed, repo-write-denying shell
 * so investigation agents cannot mutate the workspace. Unset means the default
 * full coding toolset.
 */
export type WorkflowAgentToolPolicy = "readOnly";

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
  toolPolicy?: WorkflowAgentToolPolicy;
  allowedTools?: string[];
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
  model?: string;
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
  trustedRuntimeContext?: unknown;
  agent: WorkflowAgent;
  signal?: AbortSignal;
  maxConcurrentAgents?: number;
  maxTotalAgents?: number;
  tokenBudget?: number;
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
  onEstimatedResultTokensChange?: (estimatedResultTokens: number) => void;
};

export type WorkflowRunResult = {
  meta: WorkflowMeta;
  result: unknown;
  logs: string[];
  phases: string[];
  agentCount: number;
  estimatedResultTokens: number;
  durationMs: number;
};

type RuntimeState = {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number;
  estimatedResultTokens: number;
};

type ParallelBranchContext = {
  signal: AbortSignal;
  hardStop(error: unknown): void;
};

const MAX_PARALLEL_ITEMS = 4096;
const WORKFLOW_ABORT_ERROR_NAME = "WorkflowAbortError";
const WORKFLOW_LIMIT_ERROR_NAME = "WorkflowLimitError";
const WORKFLOW_CONTRACT_ERROR_NAME = "WorkflowContractError";
const DEFAULT_MAX_CONCURRENT_AGENTS = 16;
const DEFAULT_MAX_TOTAL_AGENTS = 1000;

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

class WorkflowAbortError extends WorkflowRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = WORKFLOW_ABORT_ERROR_NAME;
  }
}

class WorkflowLimitError extends WorkflowRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = WORKFLOW_LIMIT_ERROR_NAME;
  }
}

class WorkflowContractError extends WorkflowRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = WORKFLOW_CONTRACT_ERROR_NAME;
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
    estimatedResultTokens: 0,
  };
  const limits = normalizeRuntimeLimits(options);
  const runWithAgentConcurrency = createLimiter(limits.maxConcurrentAgents);
  const parallelBranchContext = new AsyncLocalStorage<ParallelBranchContext>();
  let hardStopError: unknown;

  const latchHardStop = (error: unknown): void => {
    if (hardStopError === undefined && isHardStopError(error)) hardStopError = error;
  };

  const throwIfHardStopped = (): void => {
    if (hardStopError !== undefined) throw hardStopError;
  };

  const propagateHardStop = (error: unknown): void => {
    if (!isHardStopError(error)) return;
    latchHardStop(error);
    parallelBranchContext.getStore()?.hardStop(error);
  };

  const runHostCall = <T>(callback: () => T): T => {
    throwIfHardStopped();
    try {
      const result = callback();
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          propagateHardStop(error);
          throw error;
        }) as T;
      }
      return result;
    } catch (error) {
      propagateHardStop(error);
      throw error;
    }
  };

  const throwIfAborted = () => {
    if (options.signal?.aborted) throw abortError(options.signal, "Workflow was aborted.");
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

  const recordEstimatedResultTokens = (result: unknown): void => {
    state.estimatedResultTokens += estimateTokens(result);
    options.onEstimatedResultTokensChange?.(state.estimatedResultTokens);
    throwIfTokenBudgetExceeded(state, limits);
  };

  const agent = (prompt: unknown, rawOptions: unknown = {}): Promise<unknown> => {
    throwIfAborted();
    const branchContext = parallelBranchContext.getStore();
    const branchSignal = branchContext?.signal;
    throwIfSignalAborted(branchSignal);
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
      model: agentOptions.model,
      ...(agentOptions.toolPolicy === undefined ? {} : { toolPolicy: agentOptions.toolPolicy }),
      ...(agentOptions.allowedTools === undefined
        ? {}
        : { allowedTools: agentOptions.allowedTools }),
      cwd: options.cwd,
    });
    const journalAgentId = options.journalAgentIdFactory?.() ?? createWorkflowJournalAgentId();
    const event: WorkflowAgentRuntimeEvent = {
      runAgentId,
      label,
      ...(assignedPhase === undefined ? {} : { phase: assignedPhase }),
      prompt: taskPrompt,
      ...(agentOptions.model === undefined ? {} : { model: agentOptions.model }),
      journalKey,
      journalAgentId,
    };
    options.onAgentQueued?.(event);
    const replayResult = options.replayCache?.resultsByKey.get(journalKey);
    if (replayResult !== undefined) {
      options.onAgentStart?.(event);
      const result = toContextValue(context, replayResult.result, "agent result");
      validateAgentResult(agentOptions.schema, result, label);
      recordEstimatedResultTokens(result);
      options.onAgentEnd?.({ ...event, result });
      return Promise.resolve(result);
    }

    const control = options.agentControlFactory?.(event);
    const combinedSignal = combineAbortSignals([options.signal, control?.signal, branchSignal]);
    const agentSignal = combinedSignal.signal;
    const transcript = options.transcriptTargetFactory?.({ ...event, agentIndex });
    const effectiveOptions: WorkflowAgentOptions = {
      ...agentOptions,
      label,
      ...(assignedPhase === undefined ? {} : { phase: assignedPhase }),
      ...(agentSignal === undefined ? {} : { signal: agentSignal }),
      ...(transcript === undefined ? {} : { transcript }),
    };

    return (async () => {
      try {
        const result = await runWithAgentConcurrency(async () => {
          try {
            throwIfAborted();
            throwIfAgentStopped(control);
            throwIfTokenBudgetExhausted(state, limits);
            options.onAgentStart?.(event);
            const rawResult = await options.agent(taskPrompt, effectiveOptions);
            const result = toContextValue(context, rawResult, "agent result");
            validateAgentResult(agentOptions.schema, result, label);
            throwIfAborted();
            throwIfSignalAborted(branchSignal);
            throwIfAgentStopped(control);
            recordEstimatedResultTokens(result);
            return result;
          } catch (error) {
            propagateHardStop(error);
            throw error;
          }
        }, agentSignal);
        options.onAgentEnd?.({ ...event, result });
        return result;
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal, "Workflow was aborted.");
        if (isHardStopError(error) && !isAbortError(error)) throw error;
        if (branchSignal?.aborted) throw abortError(branchSignal);
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
    })();
  };

  const parallel = async (thunks: unknown): Promise<unknown[]> => {
    if (!Array.isArray(thunks)) {
      throw new WorkflowContractError("parallel() expects an array of functions.");
    }
    if (thunks.length > MAX_PARALLEL_ITEMS) {
      throw new WorkflowContractError(
        `parallel() supports at most ${MAX_PARALLEL_ITEMS} branches.`,
      );
    }
    for (let index = 0; index < thunks.length; index += 1) {
      if (!(index in thunks) || typeof thunks[index] !== "function") {
        throw new WorkflowContractError(
          "parallel() expects functions, not promises. Wrap each branch as `() => agent(...)`.",
        );
      }
    }

    const parentBranchContext = parallelBranchContext.getStore();
    const branchControllers = thunks.map(() => new AbortController());
    let terminalError: unknown;
    const abortSiblings = (error: unknown): void => {
      if (terminalError !== undefined) return;
      latchHardStop(error);
      terminalError = error;
      for (const controller of branchControllers) controller.abort(error);
      parentBranchContext?.hardStop(error);
    };
    const branchSignals = branchControllers.map((controller) =>
      combineAbortSignals([parentBranchContext?.signal, controller.signal]),
    );
    const branches = thunks.map((thunk, index) => {
      const branchSignal = branchSignals[index]?.signal;
      if (branchSignal === undefined) {
        throw new WorkflowRuntimeError("parallel branch signal was not initialized.");
      }
      return parallelBranchContext.run(
        { signal: branchSignal, hardStop: abortSiblings },
        async () => {
          try {
            throwIfAborted();
            return await thunk();
          } catch (error) {
            if (options.signal?.aborted) {
              const abort = abortError(options.signal, "Workflow was aborted.");
              abortSiblings(abort);
              throw abort;
            }
            if (isHardStopError(error)) {
              abortSiblings(error);
              throw error;
            }
            log(`parallel[${index}] failed: ${errorMessage(error)}`);
            return null;
          }
        },
      );
    });

    const settled = await Promise.allSettled(branches);
    for (const combined of branchSignals) combined.cleanup();
    if (terminalError !== undefined) throw terminalError;
    const unexpectedRejection = settled.find((outcome) => outcome.status === "rejected");
    if (unexpectedRejection?.status === "rejected") throw unexpectedRejection.reason;
    return settled.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : null));
  };

  const pipeline = async (
    items: unknown,
    ...stages: Array<(previous: unknown, original: unknown, index: number) => unknown>
  ): Promise<unknown[]> => {
    if (!Array.isArray(items)) {
      throw new WorkflowContractError("pipeline() expects an array as the first argument.");
    }
    if (items.length > MAX_PARALLEL_ITEMS) {
      throw new WorkflowContractError(`pipeline() supports at most ${MAX_PARALLEL_ITEMS} items.`);
    }
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new WorkflowContractError("pipeline() stages must be functions.");
    }

    const itemThunks = Array.from({ length: items.length }, (_, index) => async () => {
      if (!(index in items)) return undefined;
      const item = items[index];
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
    });

    return parallel(itemThunks);
  };

  let context!: vm.Context;
  const hostApi = Object.freeze(
    Object.assign(Object.create(null), {
      agent: safeHostFunction((...input: unknown[]) =>
        runHostCall(() => agent(input[0], input[1])),
      ),
      parallel: safeHostFunction((thunks: unknown) =>
        runHostCall(async () => {
          const value = await parallel(thunks);
          return toContextValue(context, value, "parallel result");
        }),
      ),
      pipeline: safeHostFunction((items: unknown, ...stages: unknown[]) =>
        runHostCall(async () => {
          const value = await pipeline(
            items,
            ...(stages as Array<(previous: unknown, original: unknown, index: number) => unknown>),
          );
          return toContextValue(context, value, "pipeline result");
        }),
      ),
      phase: safeHostFunction((title: unknown) => runHostCall(() => phase(title))),
      log: safeHostFunction((message: unknown) => runHostCall(() => log(message))),
      budgetTotal: safeHostFunction(() => runHostCall(() => limits.tokenBudget)),
      budgetSpent: safeHostFunction(() => runHostCall(() => state.estimatedResultTokens)),
      budgetRemaining: safeHostFunction(() =>
        runHostCall(() =>
          limits.tokenBudget === null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, limits.tokenBudget - state.estimatedResultTokens),
        ),
      ),
    }),
  );

  context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  Object.assign(context, {
    __workflowHost: hostApi,
    __workflowArgsJson: serializeForContext(options.args, "workflow args"),
    __workflowTrustedRuntimeContextJson: serializeForContext(
      options.trustedRuntimeContext,
      "trusted workflow runtime context",
    ),
    __workflowCwd: options.cwd,
  });
  installWorkflowGlobals(context);

  const wrapped = `(async () => {\n"use strict";\n${parsed.executableScript}\n})()`;
  let result: unknown;
  try {
    result = await new vm.Script(wrapped, {
      filename: `${parsed.meta.name || "workflow"}.js`,
    }).runInContext(context);
  } catch (error) {
    if (hardStopError !== undefined) throw hardStopError;
    throw error;
  }
  throwIfHardStopped();

  assertJsonSerializable(result, "workflow result");

  return {
    meta: parsed.meta,
    result,
    logs: state.logs,
    phases: state.phases,
    agentCount: state.agentCount,
    estimatedResultTokens: state.estimatedResultTokens,
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
        const trustedWorkflowRuntimeContext =
          globalThis.__workflowTrustedRuntimeContextJson === undefined
            ? undefined
            : JSON.parse(globalThis.__workflowTrustedRuntimeContextJson);
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
          if (
            error &&
            typeof error === "object" &&
            (error.name === ${JSON.stringify(WORKFLOW_ABORT_ERROR_NAME)} ||
              error.name === ${JSON.stringify(WORKFLOW_LIMIT_ERROR_NAME)} ||
              error.name === ${JSON.stringify(WORKFLOW_CONTRACT_ERROR_NAME)})
          ) {
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
          trustedRuntimeContext: {
            value: trustedWorkflowRuntimeContext,
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
        delete globalThis.__workflowTrustedRuntimeContextJson;
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
      throw new WorkflowContractError(`${label} must be JSON-serializable.`);
    }
    return json;
  } catch (error) {
    if (error instanceof WorkflowContractError) throw error;
    const message = error instanceof Error ? ` ${error.message}` : "";
    throw new WorkflowContractError(`${label} must be JSON-serializable.${message}`);
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
    throw new WorkflowRuntimeError(
      "tokenBudget must be a non-negative estimated result-token budget.",
    );
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
  if (limits.tokenBudget !== null && state.estimatedResultTokens >= limits.tokenBudget) {
    throw new WorkflowLimitError(
      `workflow estimated result-token budget exhausted: estimated ${state.estimatedResultTokens}/${limits.tokenBudget}`,
    );
  }
}

function throwIfTokenBudgetExceeded(state: RuntimeState, limits: RuntimeLimits): void {
  if (limits.tokenBudget !== null && state.estimatedResultTokens > limits.tokenBudget) {
    throw new WorkflowLimitError(
      `workflow estimated result-token budget exceeded: estimated ${state.estimatedResultTokens}/${limits.tokenBudget}`,
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

function combineAbortSignals(inputs: Array<AbortSignal | undefined>): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const signals = inputs.filter((signal): signal is AbortSignal => signal !== undefined);
  if (signals.length <= 1) return { signal: signals[0], cleanup: () => {} };

  const controller = new AbortController();
  const listeners = signals.map((signal) => {
    const listener = () => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  const cleanup = () => {
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
  };
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    cleanup();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
  }
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

function abortError(
  signal: AbortSignal | undefined,
  fallback: string = "aborted",
): WorkflowAbortError {
  return new WorkflowAbortError(errorMessage(signal?.reason ?? fallback));
}

function normalizeAgentOptions(value: unknown): WorkflowAgentOptions {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw new WorkflowContractError("agent options must be an object.");
  }

  rejectUnsupportedAgentExecutionSelectors(value);

  return {
    label: optionalString(value.label, "agent label"),
    phase: optionalString(value.phase, "agent phase"),
    schema: value.schema === undefined ? undefined : normalizeAgentSchema(value.schema),
    agentType: optionalString(value.agentType, "agent type"),
    model: optionalModelSpec(value.model),
    toolPolicy: optionalToolPolicy(value.toolPolicy),
    allowedTools: optionalStringArray(value.allowedTools, "agent option `allowedTools`"),
  };
}

const SCHEMA_STRING_KEYWORDS = new Set([
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$recursiveRef",
  "$ref",
  "$schema",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "pattern",
  "title",
]);
const SCHEMA_BOOLEAN_KEYWORDS = new Set([
  "$recursiveAnchor",
  "deprecated",
  "readOnly",
  "uniqueItems",
  "writeOnly",
]);
const SCHEMA_NUMBER_KEYWORDS = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
  "multipleOf",
]);
const SCHEMA_COUNT_KEYWORDS = new Set([
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
]);
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYWORDS = new Set(["const", "default"]);
const SCHEMA_SINGLE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  ...SCHEMA_STRING_KEYWORDS,
  ...SCHEMA_BOOLEAN_KEYWORDS,
  ...SCHEMA_NUMBER_KEYWORDS,
  ...SCHEMA_COUNT_KEYWORDS,
  ...SCHEMA_MAP_KEYWORDS,
  ...SCHEMA_ARRAY_KEYWORDS,
  ...SCHEMA_VALUE_KEYWORDS,
  ...SCHEMA_SINGLE_KEYWORDS,
  "dependencies",
  "dependentRequired",
  "enum",
  "examples",
  "items",
  "required",
  "type",
]);

const SUPPORTED_SCHEMA_FORMATS = new Set([
  "date-time",
  "date",
  "duration",
  "email",
  "hostname",
  "idn-email",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "iri-reference",
  "iri",
  "json-pointer-uri-fragment",
  "json-pointer",
  "regex",
  "relative-json-pointer",
  "time",
  "uri-reference",
  "uri-template",
  "uri",
  "url",
  "uuid",
]);

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function normalizeAgentSchema(value: unknown): JsonSchema {
  const normalized = normalizeStrictJsonGraph(value, "agent schema");
  if (!isPlainObject(normalized)) {
    throw new WorkflowContractError("agent schema must be an object.");
  }
  assertSupportedSchema(normalized, "agent schema");
  return normalized;
}

function normalizeStrictJsonGraph(value: unknown, label: string): unknown {
  const ancestors = new Set<object>();

  const visit = (nested: unknown): unknown => {
    if (
      nested === null ||
      typeof nested === "string" ||
      typeof nested === "boolean" ||
      (typeof nested === "number" && Number.isFinite(nested))
    ) {
      return nested;
    }
    if (typeof nested !== "object") {
      throw new WorkflowContractError(`${label} must contain only JSON values.`);
    }
    if (utilTypes.isProxy(nested)) {
      throw new WorkflowContractError(`${label} must contain only plain JSON objects and arrays.`);
    }
    if (ancestors.has(nested)) {
      throw new WorkflowContractError(`${label} must not contain circular references.`);
    }
    rejectToJsonHook(nested, label);

    ancestors.add(nested);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(nested);
      const symbolKeys = Object.getOwnPropertySymbols(nested);
      if (symbolKeys.length > 0) {
        throw new WorkflowContractError(`${label} must contain only JSON values.`);
      }

      if (Array.isArray(nested)) {
        if (!hasIntrinsicPrototype(nested, "Array")) {
          throw new WorkflowContractError(
            `${label} must contain only plain JSON objects and arrays.`,
          );
        }
        const length = nested.length;
        const keys = Object.keys(descriptors).filter((key) => key !== "length");
        if (keys.length !== length || keys.some((key) => !isArrayIndex(key, length))) {
          throw new WorkflowContractError(`${label} must contain only JSON arrays.`);
        }
        return Array.from({ length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new WorkflowContractError(`${label} must not contain accessors.`);
          }
          return visit(descriptor.value);
        });
      }

      if (!isPlainJsonObject(nested)) {
        throw new WorkflowContractError(
          `${label} must contain only plain JSON objects and arrays.`,
        );
      }
      const normalized = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) {
          throw new WorkflowContractError(`${label} must contain only JSON values.`);
        }
        if (!("value" in descriptor)) {
          throw new WorkflowContractError(`${label} must not contain accessors.`);
        }
        normalized[key] = visit(descriptor.value);
      }
      return normalized;
    } finally {
      ancestors.delete(nested);
    }
  };

  return visit(value);
}

function rejectToJsonHook(value: object, label: string): void {
  let current: object | null = value;
  while (current !== null) {
    if (utilTypes.isProxy(current)) {
      throw new WorkflowContractError(`${label} must contain only plain JSON objects and arrays.`);
    }
    if (Object.getOwnPropertyDescriptor(current, "toJSON") !== undefined) {
      throw new WorkflowContractError(`${label} must not contain toJSON hooks.`);
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
}

function isPlainJsonObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || hasIntrinsicPrototype(value, "Object");
}

function hasIntrinsicPrototype(value: object, constructorName: "Array" | "Object"): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null || utilTypes.isProxy(prototype)) return false;
  const parent = Object.getPrototypeOf(prototype) as object | null;
  if (constructorName === "Object" && parent !== null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  if (descriptor === undefined || !("value" in descriptor)) return false;
  const constructorValue = descriptor.value;
  if (typeof constructorValue !== "function" || utilTypes.isProxy(constructorValue)) return false;
  return (
    Function.prototype.toString.call(constructorValue) ===
    `function ${constructorName}() { [native code] }`
  );
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function assertSchemaKeywordValue(keyword: string, value: unknown, path: string): void {
  const invalid = () => {
    throw new WorkflowContractError(`${path}.${keyword} has an unsupported value.`);
  };
  if (SCHEMA_STRING_KEYWORDS.has(keyword)) {
    if (typeof value !== "string") invalid();
    return;
  }
  if (SCHEMA_BOOLEAN_KEYWORDS.has(keyword)) {
    if (typeof value !== "boolean") invalid();
    return;
  }
  if (SCHEMA_NUMBER_KEYWORDS.has(keyword) || SCHEMA_COUNT_KEYWORDS.has(keyword)) {
    if (typeof value !== "number") invalid();
    return;
  }
  if (SCHEMA_MAP_KEYWORDS.has(keyword)) {
    if (!isPlainObject(value)) invalid();
    return;
  }
  if (SCHEMA_ARRAY_KEYWORDS.has(keyword) || keyword === "enum" || keyword === "examples") {
    if (!Array.isArray(value)) invalid();
    return;
  }
  if (SCHEMA_SINGLE_KEYWORDS.has(keyword)) {
    if (typeof value !== "boolean" && !isPlainObject(value)) invalid();
    return;
  }
  if (keyword === "items") {
    if (
      typeof value !== "boolean" &&
      !isPlainObject(value) &&
      !(
        Array.isArray(value) &&
        value.every((item) => typeof item === "boolean" || isPlainObject(item))
      )
    ) {
      invalid();
    }
    return;
  }
  if (keyword === "required") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) invalid();
    return;
  }
  if (keyword === "dependentRequired") {
    if (
      !isPlainObject(value) ||
      !Object.values(value).every(
        (items) => Array.isArray(items) && items.every((item) => typeof item === "string"),
      )
    ) {
      invalid();
    }
    return;
  }
  if (keyword === "dependencies") {
    if (
      !isPlainObject(value) ||
      !Object.values(value).every(
        (dependency) =>
          typeof dependency === "boolean" ||
          isPlainObject(dependency) ||
          (Array.isArray(dependency) && dependency.every((item) => typeof item === "string")),
      )
    ) {
      invalid();
    }
  }
}

function assertSupportedSchema(value: unknown, path: string): void {
  if (typeof value === "boolean") return;
  if (!isPlainObject(value)) {
    throw new WorkflowContractError(`${path} must be a JSON Schema object or boolean.`);
  }

  for (const [keyword, keywordValue] of Object.entries(value)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new WorkflowContractError(`${path} uses unsupported keyword \`${keyword}\`.`);
    }
    assertSchemaKeywordValue(keyword, keywordValue, path);
  }

  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (
      types.length === 0 ||
      types.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type)) ||
      new Set(types).size !== types.length
    ) {
      throw new WorkflowContractError(`${path}.type contains an unsupported JSON Schema type.`);
    }
  }
  if (typeof value.multipleOf === "number" && value.multipleOf <= 0) {
    throw new WorkflowContractError(`${path}.multipleOf must be greater than zero.`);
  }
  for (const keyword of SCHEMA_COUNT_KEYWORDS) {
    const count = value[keyword];
    if (typeof count === "number" && (!Number.isInteger(count) || count < 0)) {
      throw new WorkflowContractError(`${path}.${keyword} must be a non-negative integer.`);
    }
  }
  if (Array.isArray(value.required) && new Set(value.required).size !== value.required.length) {
    throw new WorkflowContractError(`${path}.required must contain unique property names.`);
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    if (Array.isArray(value[keyword]) && value[keyword].length === 0) {
      throw new WorkflowContractError(`${path}.${keyword} must not be empty.`);
    }
  }
  if (Array.isArray(value.enum)) {
    const enumValues = value.enum;
    if (enumValues.length === 0) {
      throw new WorkflowContractError(`${path}.enum must not be empty.`);
    }
    if (
      enumValues.some((candidate, index) =>
        enumValues.slice(0, index).some((previous) => valuesEqual(previous, candidate)),
      )
    ) {
      throw new WorkflowContractError(`${path}.enum must contain unique values.`);
    }
  }
  if (typeof value.pattern === "string") {
    try {
      new RegExp(value.pattern);
    } catch {
      throw new WorkflowContractError(`${path}.pattern must be a valid regular expression.`);
    }
  }
  if (typeof value.format === "string" && !SUPPORTED_SCHEMA_FORMATS.has(value.format)) {
    throw new WorkflowContractError(`${path}.format is not supported by the runtime validator.`);
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const schemas = value[keyword];
    if (isPlainObject(schemas)) {
      for (const [key, schema] of Object.entries(schemas)) {
        if (keyword === "patternProperties") {
          try {
            new RegExp(key);
          } catch {
            throw new WorkflowContractError(`${path}.${keyword} uses an invalid pattern: ${key}`);
          }
        }
        assertSupportedSchema(schema, `${path}.${keyword}.${key}`);
      }
    }
  }
  for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
    if (value[keyword] !== undefined) assertSupportedSchema(value[keyword], `${path}.${keyword}`);
  }
  const items = value.items;
  if (Array.isArray(items)) {
    items.forEach((schema, index) => {
      assertSupportedSchema(schema, `${path}.items[${index}]`);
    });
  } else if (items !== undefined) {
    assertSupportedSchema(items, `${path}.items`);
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const schemas = value[keyword];
    if (Array.isArray(schemas)) {
      schemas.forEach((schema, index) => {
        assertSupportedSchema(schema, `${path}.${keyword}[${index}]`);
      });
    }
  }
  if (isPlainObject(value.dependencies)) {
    for (const [key, dependency] of Object.entries(value.dependencies)) {
      if (!Array.isArray(dependency)) {
        assertSupportedSchema(dependency, `${path}.dependencies.${key}`);
      }
    }
  }
}

function validateAgentResult(schema: JsonSchema | undefined, result: unknown, label: string): void {
  if (schema === undefined) return;
  try {
    if (checkValue(schema as never, result)) return;
    const errors = valueErrors(schema as never, result) as Array<{
      instancePath?: string;
      message?: string;
    }>;
    const first = errors[0];
    const detail = first
      ? `${first.instancePath || "/"} ${first.message ?? "validation failed"}`
      : "validation failed";
    throw new WorkflowContractError(`agent ${label} result did not match its schema: ${detail}`);
  } catch (error) {
    if (error instanceof WorkflowContractError) throw error;
    throw new WorkflowContractError(
      `agent ${label} schema could not be validated: ${errorMessage(error)}`,
    );
  }
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new WorkflowContractError(`${label} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function optionalToolPolicy(value: unknown): WorkflowAgentToolPolicy | undefined {
  if (value === undefined) return undefined;
  if (value !== "readOnly") {
    throw new WorkflowContractError('agent option `toolPolicy` must be "readOnly" when provided.');
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new WorkflowContractError(`${label} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label);
}

function optionalModelSpec(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const spec = parseModelSpec(value);
  if (spec === undefined) {
    throw new WorkflowContractError(
      "agent option `model` must use provider/model or provider/model:effort.",
    );
  }
  return formatModelSpecWithThinking(spec);
}

function rejectUnsupportedAgentExecutionSelectors(value: Record<string, unknown>): void {
  const unsupported = ["thinkingLevel", "effort", "isolation"].find((key) => key in value);
  if (unsupported === undefined) return;
  throw new WorkflowContractError(
    `agent option \`${unsupported}\` is unsupported; use \`model: "provider/model[:effort]"\` for workflow agent model and effort selection.`,
  );
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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof WorkflowAbortError ||
    (isPlainObject(error) && error.name === WORKFLOW_ABORT_ERROR_NAME)
  );
}

function isHardStopError(error: unknown): boolean {
  if (isAbortError(error)) return true;
  if (error instanceof WorkflowLimitError || error instanceof WorkflowContractError) return true;
  return (
    isPlainObject(error) &&
    (error.name === WORKFLOW_LIMIT_ERROR_NAME || error.name === WORKFLOW_CONTRACT_ERROR_NAME)
  );
}
