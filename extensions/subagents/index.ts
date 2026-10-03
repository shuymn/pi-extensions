import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { toCliExec } from "../../lib/cli";
import {
  type DelegatedSessionOptions,
  type DelegatedSessionResult,
  inheritDelegatedTool,
  runDelegatedSession,
} from "../../lib/delegated-session";
import {
  createInvestigationToolset,
  type InvestigationToolset,
} from "../../lib/investigation-tools";
import type { ThinkingLevel } from "../../lib/model-spec";

type Status = "running" | "stopping" | "completed" | "error" | "stopped";
type Selection = { model: ExtensionContext["model"]; thinkingLevel: ThinkingLevel };
type RecordState = {
  id: string;
  description: string;
  status: Status;
  startedAt: number;
  completedAt?: number;
  outcome?: DelegatedSessionResult;
  error?: string;
  session?: AgentSession;
  promise: Promise<void>;
  abortController: AbortController;
  childIds: Set<string>;
  usageReported?: boolean;
};
type SpawnPolicy = { forceReadOnly: boolean; backgroundAllowed: boolean };
type Runtime = SpawnPolicy & {
  records: Map<string, RecordState>;
  toolset: InvestigationToolset;
  closed: boolean;
  callerDelegationDepth: number;
  callerRecordId?: string;
  selection?: Selection;
  settings?: DelegatedSessionOptions["settings"];
  inheritedTools?: readonly ToolDefinition[];
};
type SpawnParams = {
  prompt: string;
  description?: string;
  background?: boolean;
  readOnly?: boolean;
  allowedTools?: string[];
  schema?: TSchema;
};
const MAX_DELEGATION_DEPTH = 1;
const SPAWN = "spawn_subagent";
const OUTPUT_SCHEMA = Type.Object(
  {
    status: Type.String(),
    id: Type.Optional(Type.String()),
    result: Type.Optional(Type.Unknown()),
    text: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    evidence: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);

function textResult(text: string, data: Record<string, unknown> = { status: "completed" }) {
  return {
    content: [{ type: "text" as const, text }],
    details: data,
    structuredContent: JSON.parse(JSON.stringify(data)) as JsonValue,
  };
}
function active(record: RecordState): boolean {
  return record.status === "running" || record.status === "stopping";
}
function children(runtime: Runtime, record: RecordState): RecordState[] {
  return [...record.childIds].flatMap((id) => {
    const child = runtime.records.get(id);
    return child ? [child] : [];
  });
}
async function stopTree(runtime: Runtime, record: RecordState): Promise<void> {
  if (active(record)) {
    record.status = "stopping";
    record.abortController.abort();
  }
  // Abort descendants before awaiting the owner: the owner's tool execution may be waiting on them.
  await Promise.all([
    record.session?.abort().catch(() => {}),
    ...children(runtime, record).map((child) => stopTree(runtime, child)),
  ]);
}
function availableTools(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
  declared: readonly AgentTool[],
  runtime: Runtime,
  readOnly: boolean,
): ToolDefinition[] {
  const metadata = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const callerTools =
    runtime.inheritedTools ??
    [...new Map([...declared, ...ctx.tools].map((tool) => [tool.name, tool])).values()].map(
      (tool) => inheritDelegatedTool(tool, metadata.get(tool.name)),
    );
  const detached = new Map(runtime.toolset.tools.map((tool) => [tool.name, tool]));
  return (
    callerTools
      // Background records belong to their owner; children have foreground delegation only.
      .filter(
        (tool) => !["get_subagent_result", "stop_subagent", "list_subagents"].includes(tool.name),
      )
      .filter(
        (tool) => tool.name !== SPAWN || runtime.callerDelegationDepth + 1 < MAX_DELEGATION_DEPTH,
      )
      .map((tool) => {
        const replacement = detached.get(tool.name);
        const source = metadata.get(tool.name)?.sourceInfo?.path;
        const ownedSource = resolve(
          import.meta.dirname,
          tool.name === "github_clone_workspace" ? "../add-dir/index.ts" : "../tavily/index.ts",
        );
        // Only the package's own implementations need detached resource ownership.
        // A caller's same-named override must retain its schema and callback.
        return replacement && source === ownedSource
          ? { ...replacement, exposure: tool.exposure, namespace: tool.namespace }
          : tool;
      })
      .filter(
        (tool) =>
          !readOnly ||
          tool.name === "bash" ||
          tool.name === SPAWN ||
          (tool.name !== "edit" &&
            tool.name !== "write" &&
            tool.annotations?.readOnlyHint === true),
      )
  );
}
function spawnTool(
  pi: ExtensionAPI,
  getRuntime: () => Runtime | undefined,
  policy: SpawnPolicy,
): ToolDefinition {
  let declared: readonly AgentTool[] = [];
  return {
    name: SPAWN,
    label: "Spawn Subagent",
    description:
      "Run a self-contained delegated task in an isolated session, inheriting the caller's model, thinking level and available tools. Session-owned background management is not inherited. Read-only children use protected bash and read-only tools. allowedTools restricts the child (including nested delegation); [] gives no task tools. One additional foreground delegation level is available only when spawn_subagent is allowed. Native model retries continue the same conversation; tasks are never restarted on failure.",
    annotations: { readOnlyHint: policy.forceReadOnly },
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Self-contained task, authorization boundaries, context and success conditions.",
      }),
      description: Type.Optional(Type.String({ description: "Short task description." })),
      background: Type.Optional(
        Type.Boolean({
          description: policy.backgroundAllowed
            ? "Return an id immediately; use get_subagent_result to retrieve the result. Default: false."
            : "Background mode is unavailable in delegated sessions.",
        }),
      ),
      readOnly: Type.Optional(
        Type.Boolean({
          description: policy.forceReadOnly
            ? "Read-only is enforced regardless of this setting."
            : "Use inspection tools and OS-sandboxed bash, without repository writes.",
        }),
      ),
      allowedTools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Child tool allowlist, bounded by the caller's available tools. Omit to inherit them; [] for no task tools.",
        }),
      ),
      schema: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON Schema for a required terminal structured_output result.",
        }),
      ),
    }),
    outputSchema: OUTPUT_SCHEMA,
    prepareLoadout(loadout) {
      // ctx.tools includes callable/deferred tools but excludes model-only declarations.
      declared = loadout.declared;
      return undefined;
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const runtime = getRuntime();
      if (!runtime || runtime.closed)
        return textResult(
          "Cannot spawn delegated task because the owning session is closing or closed.",
          {
            status: "error",
          },
        );
      return spawn(pi, ctx, declared, runtime, params as SpawnParams, signal, onUpdate);
    },
  } as ToolDefinition;
}

async function spawn(
  pi: ExtensionAPI,
  ctx: ExtensionToolContext,
  declared: readonly AgentTool[],
  runtime: Runtime,
  params: SpawnParams,
  signal: AbortSignal | undefined,
  onUpdate: ((result: ReturnType<typeof textResult>) => void) | undefined,
) {
  if (params.background && !runtime.backgroundAllowed)
    return textResult("Background mode is not available for delegated spawn_subagent calls.", {
      status: "rejected",
      background: false,
    });
  const background = params.background ?? false;
  if (!background && signal?.aborted)
    return textResult("Subagent stopped before it started.", { status: "stopped" });
  const owner = runtime.callerRecordId ? runtime.records.get(runtime.callerRecordId) : undefined;
  if (
    runtime.callerRecordId &&
    (owner?.status !== "running" || owner.abortController.signal.aborted)
  )
    return textResult(
      "Cannot spawn delegated task because the calling session is no longer active.",
      { status: "error" },
    );
  const readOnly = runtime.forceReadOnly || (params.readOnly ?? false);
  const available = availableTools(pi, ctx, declared, runtime, readOnly);
  const availableNames = new Set(available.map((tool) => tool.name));
  const denied = params.allowedTools?.find((name) => !availableNames.has(name));
  if (denied) throw new Error(`Subagent allowedTools includes unavailable tool: ${denied}`);
  const selected = new Set(params.allowedTools ?? availableNames);
  const selectedTools = available.filter((tool) => selected.has(tool.name));
  const selection = runtime.selection ?? { model: ctx.model, thinkingLevel: pi.getThinkingLevel() };
  const settings = runtime.settings ?? pi.getSettings();
  if (!selection.model) throw new Error("Select a model before spawning a subagent");
  const model = selection.model;
  const id = randomUUID().slice(0, 8);
  const record: RecordState = {
    id,
    description: params.description?.trim() || "Subagent task",
    status: "running",
    startedAt: Date.now(),
    promise: Promise.resolve(),
    abortController: new AbortController(),
    childIds: new Set(),
  };
  runtime.records.set(id, record);
  owner?.childIds.add(id);
  const abort = () => record.abortController.abort();
  if (!background) signal?.addEventListener("abort", abort, { once: true });
  owner?.abortController.signal.addEventListener("abort", abort, { once: true });
  if ((!background && signal?.aborted) || owner?.abortController.signal.aborted) abort();
  record.promise = (async () => {
    try {
      const childRuntime: Runtime = {
        ...runtime,
        callerDelegationDepth: runtime.callerDelegationDepth + 1,
        callerRecordId: id,
        forceReadOnly: readOnly,
        backgroundAllowed: false,
        selection,
        settings,
        inheritedTools: selectedTools,
      };
      const nested = selected.has(SPAWN)
        ? spawnTool(pi, () => (runtime.closed ? undefined : childRuntime), childRuntime)
        : undefined;
      record.outcome = await runDelegatedSession({
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        model,
        thinkingLevel: selection.thinkingLevel,
        settings,
        systemPrompt: ctx.getSystemPrompt(),
        prompt: params.prompt,
        name: `subagent#${id}`,
        allowedTools: [...selected],
        customTools: [
          ...selectedTools.filter((tool) => tool.name !== SPAWN),
          ...(nested ? [nested] : []),
        ],
        readOnly,
        schema: params.schema,
        signal: record.abortController.signal,
        exec: (command, args, opts) =>
          pi.exec(command, args, { cwd: opts?.cwd ?? ctx.cwd, timeout: opts?.timeout }),
        onText: background
          ? undefined
          : (text) =>
              !runtime.closed &&
              !record.abortController.signal.aborted &&
              onUpdate?.(
                textResult(
                  `Subagent ${id} running...\n\n${text.length > 1200 ? `${text.slice(0, 1200)}\n...(truncated; call get_subagent_result for full output)` : text}`,
                  { id, status: "running" },
                ),
              ),
        onSessionCreated: (session) => {
          record.session = session;
        },
        onSessionDisposed: () => {
          record.session = undefined;
        },
      });
      record.status =
        record.abortController.signal.aborted || record.outcome.status === "cancelled"
          ? "stopped"
          : record.outcome.status === "completed"
            ? "completed"
            : "error";
      record.error = record.outcome.error;
    } catch (error) {
      record.status = record.abortController.signal.aborted ? "stopped" : "error";
      record.error = error instanceof Error ? error.message : String(error);
    } finally {
      const owned = children(runtime, record);
      await Promise.all(owned.map((child) => stopTree(runtime, child)));
      await Promise.allSettled(owned.map((child) => child.promise));
      record.completedAt = Date.now();
      if (!background) signal?.removeEventListener("abort", abort);
      owner?.abortController.signal.removeEventListener("abort", abort);
      owner?.childIds.delete(id);
    }
  })();
  if (background)
    return textResult(
      `Subagent started in background.\nID: ${id}\nDescription: ${record.description}\n\nUse get_subagent_result to retrieve the result.`,
      { id, status: "running", background: true },
    );
  await record.promise;
  runtime.records.delete(id);
  return recordResult(record);
}

function recordResult(record: RecordState) {
  const data = { ...record.outcome, id: record.id, status: record.status, error: record.error };
  const result = textResult(
    record.status === "completed"
      ? record.outcome?.text || JSON.stringify(record.outcome?.result) || "No output."
      : `Subagent ${record.status}: ${record.error ?? record.status}`,
    data,
  );
  const usage = record.usageReported ? undefined : record.outcome?.usage;
  record.usageReported = true;
  return { ...result, ...(usage ? { usage } : {}), isError: record.status === "error" };
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Owned by this extension runtime, not by the imported module. Separate SDK sessions cannot
  // inspect, stop, or clean up one another's records or temporary workspaces.
  const policy: SpawnPolicy = { forceReadOnly: false, backgroundAllowed: true };
  let runtime: Runtime | undefined;
  let closing: Promise<void> | undefined;
  let shutdown = false;
  const getRuntime = () => {
    if (shutdown || closing || runtime?.closed) return undefined;
    runtime ??= {
      ...policy,
      records: new Map(),
      toolset: createInvestigationToolset({ exec: toCliExec(pi) }),
      closed: false,
      callerDelegationDepth: -1,
    };
    return runtime;
  };
  const closeOwner = (): Promise<void> => {
    if (closing) return closing;
    if (!runtime) return Promise.resolve();
    const owner = runtime;
    owner.closed = true;
    const owned = [...owner.records.values()];
    // Install the gate before abort listeners run; they may re-enter shutdown.
    closing = Promise.resolve()
      .then(async () => {
        await Promise.all(owned.map((record) => stopTree(owner, record)));
        await Promise.allSettled(owned.map((record) => record.promise));
        owner.records.clear();
        await owner.toolset.cleanup();
        runtime = undefined;
      })
      .finally(() => {
        closing = undefined;
      });
    return closing;
  };
  pi.registerTool(spawnTool(pi, getRuntime, policy));
  const exposure = "deferred";
  pi.registerTool({
    name: "get_subagent_result",
    exposure,
    label: "Get Subagent Result",
    description:
      "Check status and retrieve a background task's structured result, usage and evidence.",
    parameters: Type.Object({
      id: Type.String(),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion. Default: false." })),
    }),
    outputSchema: OUTPUT_SCHEMA,
    async execute(_id, params, signal) {
      const record = runtime?.records.get(params.id);
      if (!record)
        return textResult(`Subagent not found: ${params.id}`, {
          status: "not_found",
          id: params.id,
        });
      if (params.wait && active(record)) {
        // Cancelling the foreground waiter must not cancel independently owned work.
        signal?.throwIfAborted();
        let abort: (() => void) | undefined;
        try {
          await Promise.race([
            record.promise,
            new Promise<never>((_resolve, reject) => {
              if (!signal) return;
              abort = () => reject(signal.reason ?? new Error("Subagent wait aborted"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
        } finally {
          if (abort) signal?.removeEventListener("abort", abort);
        }
      }
      if (active(record))
        return textResult(
          `Subagent ${record.id} | ${record.status}\nDescription: ${record.description}\n\nStill running.`,
          { id: record.id, status: record.status },
        );
      const result = recordResult(record);
      return {
        ...result,
        content: [
          {
            type: "text" as const,
            text: `Subagent ${record.id} | ${record.status} | ${(record.completedAt ?? Date.now()) - record.startedAt}ms\nDescription: ${record.description}\n\n${result.content[0].text}`,
          },
        ],
      };
    },
  });
  pi.registerTool({
    name: "stop_subagent",
    exposure,
    label: "Stop Subagent",
    description:
      "Stop a background task and its descendants. Does not enqueue a follow-up or wake the parent.",
    parameters: Type.Object({ id: Type.String() }),
    outputSchema: OUTPUT_SCHEMA,
    async execute(_id, params) {
      const owner = runtime;
      const record = owner?.records.get(params.id);
      if (!owner || !record)
        return textResult(`Subagent not found: ${params.id}`, {
          status: "not_found",
          id: params.id,
        });
      if (!active(record))
        return textResult(`Subagent ${record.id} is not running (status: ${record.status}).`, {
          id: record.id,
          status: record.status,
        });
      await stopTree(owner, record);
      await record.promise;
      return textResult(`Stopped subagent ${record.id}.`, { id: record.id, status: record.status });
    },
  });
  pi.registerTool({
    name: "list_subagents",
    exposure,
    label: "List Subagents",
    description: "List tasks owned by this session, their status and IDs.",
    parameters: Type.Object({}),
    outputSchema: OUTPUT_SCHEMA,
    async execute() {
      const list = [...(runtime?.records.values() ?? [])].sort((a, b) => b.startedAt - a.startedAt);
      return textResult(
        list.length
          ? `Subagents (${list.length}):\n${list.map((record) => `- ${record.id} | ${record.status} | ${(record.completedAt ?? Date.now()) - record.startedAt}ms | ${record.description}`).join("\n")}`
          : "No subagents in this session.",
        {
          status: "completed",
          count: list.length,
          tasks: list.map(({ id, status, description }) => ({ id, status, description })),
        },
      );
    },
  });
  // Before-events can be cancelled by a later handler (with no cancellation event).
  // Retire this owner permanently, but let the next top-level call lazily acquire a fresh
  // owner if the live session continues. Nested closures retain the retired owner.
  pi.on("session_before_switch", closeOwner);
  pi.on("session_before_fork", closeOwner);
  pi.on("session_before_tree", closeOwner);
  pi.on("session_start", async () => {
    await closeOwner();
    shutdown = false;
    getRuntime();
  });
  pi.on("session_tree", async () => {
    await closeOwner();
    getRuntime();
  });
  pi.on("session_shutdown", async () => {
    shutdown = true;
    await closeOwner();
  });
}
