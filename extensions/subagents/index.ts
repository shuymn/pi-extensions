import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toCliExec } from "../../lib/cli";
import {
  createInvestigationToolset,
  type InvestigationToolset,
  isolatedAgentToolNames,
} from "../../lib/investigation-tools";
import { parseModelSpec, type ThinkingLevel } from "../../lib/model-spec";
import {
  createProtectedBashOperations,
  type ExecFn,
  resetSandboxState,
} from "../../lib/protected-bash";
import { getLatestAssistantMessageText } from "../../lib/session-messages";
import { projectSettingsPath, readExtensionSettings } from "../../lib/settings";

type SubagentStatus = "running" | "stopping" | "completed" | "error" | "stopped";

type ModelTier = (typeof MODEL_TIERS)[number];

type SubagentRecord = {
  id: string;
  description: string;
  status: SubagentStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  session?: AgentSession;
  promise: Promise<void>;
  abortController: AbortController;
  childIds: Set<string>;
};

type SpawnSubagentParams = {
  prompt: string;
  description?: string;
  background?: boolean;
  readOnly?: boolean;
  modelTier?: unknown;
};

type SpawnToolRuntime = {
  callerDelegationDepth: number;
  callerRecordId?: string;
  forceReadOnly: boolean;
  backgroundAllowed: boolean;
  modelFallback?: SubagentModelSelection;
};

type RunSubagentOptions = {
  id: string;
  prompt: string;
  abortSignal: AbortSignal;
  readOnly: boolean;
  delegationDepth: number;
  modelTier?: ModelTier;
  modelFallback?: SubagentModelSelection;
  investigationToolset: InvestigationToolset;
  onTextUpdate?: (text: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
};

type SubagentModelSelection = {
  model: ExtensionContext["model"];
  thinkingLevel: ThinkingLevel;
};

type SubagentSettings = {
  modelTiers?: unknown;
};

const SPAWN_SUBAGENT_TOOL_NAME = "spawn_subagent";
const MODEL_TIERS = ["medium", "small"] as const;
const MODEL_TIER_VALUES = new Set<string>(MODEL_TIERS);
const SUBAGENTS_SETTINGS_KEY = "subagents";
const MAX_DELEGATION_DEPTH = 1;

const records = new Map<string, SubagentRecord>();

function isActiveStatus(status: SubagentStatus): boolean {
  return status === "running" || status === "stopping";
}

function textResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

function makeId(): string {
  return randomUUID().slice(0, 8);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(truncated; call get_subagent_result for full output)`;
}

function formatToolList(tools: string[]): string {
  if (tools.length === 0) return "";
  if (tools.length === 1) return tools[0];
  return `${tools.slice(0, -1).join(", ")}, and ${tools.at(-1)}`;
}

function canDelegateFromDepth(delegationDepth: number): boolean {
  return delegationDepth < MAX_DELEGATION_DEPTH;
}

function getChildRecords(record: SubagentRecord): SubagentRecord[] {
  return [...record.childIds]
    .map((id) => records.get(id))
    .filter((child): child is SubagentRecord => child !== undefined);
}

async function stopRecordTree(record: SubagentRecord): Promise<void> {
  if (isActiveStatus(record.status)) {
    if (record.status === "running") record.status = "stopping";
    record.abortController.abort();
    await record.session?.abort?.().catch(() => {});
  }

  await Promise.all(getChildRecords(record).map((child) => stopRecordTree(child)));
}

async function stopOwnedSubagents(record: SubagentRecord): Promise<void> {
  const children = getChildRecords(record);
  await Promise.all(children.map((child) => stopRecordTree(child)));
  await Promise.allSettled(children.map((child) => child.promise));
}

function getLastAssistantText(session: AgentSession): string {
  return getLatestAssistantMessageText(session.messages)?.trim() ?? "";
}

function collectAssistantText(session: AgentSession, onUpdate?: (text: string) => void) {
  let current = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") current = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      current += event.assistantMessageEvent.delta;
      onUpdate?.(current);
    }
  });

  return {
    getText: () => current.trim() || getLastAssistantText(session),
    unsubscribe,
  };
}

function buildSystemPrompt(
  parentSystemPrompt: string,
  cwd: string,
  readOnly: boolean,
  toolset: InvestigationToolset,
  canDelegate: boolean,
): string {
  const extraTools = canDelegate ? [SPAWN_SUBAGENT_TOOL_NAME] : [];
  const defaultToolList = formatToolList(isolatedAgentToolNames(toolset, { extraTools }));
  const readOnlyToolList = formatToolList(
    isolatedAgentToolNames(toolset, { readOnly: true, extraTools }),
  );
  const delegationGuidance = canDelegate
    ? `- Prefer doing simple work directly.\n- When an independent focused check would materially improve quality or confidence, you may use ${SPAWN_SUBAGENT_TOOL_NAME}.\n- Verify and integrate delegated results before relying on them.\n- For delegated modelTier selection, medium is the default. Use small only for bounded, easy-to-check investigation such as candidate discovery, file search, enumeration, or collecting possible counterexamples.\n`
    : "- Complete the assigned task with the tools available in this session. No further delegation tool is available.\n";
  return `${parentSystemPrompt}

<delegated_task_context>
You are a general-purpose agent running in an isolated in-memory session.
Your job is to complete the assigned task accurately and autonomously, then return a concise final result.

Operational rules:
- Use only the tools available in this session.
- Default sessions have ${defaultToolList}.
- Read-only sessions have ${readOnlyToolList} only.
- Use absolute file paths in file references when practical.
- Be concise but complete in your final answer.
- Do not ask for outside work you can do yourself.
${delegationGuidance}${readOnly ? "- This session is read-only. Bash commands are sandboxed: repo writes are denied by the OS sandbox. Write scratch files only under /tmp or $TMPDIR. Do not attempt to edit or write files in the repository.\n" : ""}
Working directory: ${cwd}
</delegated_task_context>`;
}

function createProtectedBashToolDef(cwd: string, execFn: ExecFn): ToolDefinition {
  const protectedOps = createProtectedBashOperations(execFn, cwd);
  return {
    ...createBashToolDefinition(cwd, { operations: protectedOps }),
    name: "bash",
    label: "bash",
  } as ToolDefinition;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeModelTier(value: unknown): ModelTier | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && MODEL_TIER_VALUES.has(value)) return value as ModelTier;
  throw new Error('modelTier must be "medium" or "small".');
}

function readModelTierSpec(cwd: string, tier: ModelTier): unknown {
  const settings = readExtensionSettings<SubagentSettings>(SUBAGENTS_SETTINGS_KEY, {
    projectPath: projectSettingsPath(cwd),
  });
  const tiers = settings.modelTiers;
  if (!isPlainObject(tiers)) return undefined;
  return tiers[tier];
}

function resolveSubagentModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modelTier: ModelTier | undefined,
  fallback?: SubagentModelSelection,
): SubagentModelSelection {
  const inherited = fallback ?? {
    model: ctx.model,
    thinkingLevel: pi.getThinkingLevel(),
  };
  if (modelTier === undefined) return inherited;

  const spec = parseModelSpec(readModelTierSpec(ctx.cwd, modelTier));
  if (spec === undefined) return inherited;

  const model = ctx.modelRegistry.find(spec.provider, spec.model);
  if (model === undefined) return inherited;

  return {
    model,
    thinkingLevel: spec.thinkingLevel ?? inherited.thinkingLevel,
  };
}

function createSpawnSubagentParameters(runtime: SpawnToolRuntime) {
  const backgroundDescription = runtime.backgroundAllowed
    ? "Run in background and return immediately with an id; use get_subagent_result to check status or retrieve the result. Default: false."
    : "Background mode is not available from delegated sessions. Default: false.";
  const readOnlyDescription = runtime.forceReadOnly
    ? "The calling session is read-only, so spawned sessions are read-only regardless of this setting."
    : "When true, run the subagent with read-only inspection tools and sandboxed bash, without edit/write tools. Default: false.";

  return Type.Object({
    prompt: Type.String({
      description: "The complete task for the subagent to perform autonomously.",
    }),
    description: Type.Optional(
      Type.String({
        description: "Short description shown in status/result messages.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description: backgroundDescription,
      }),
    ),
    readOnly: Type.Optional(
      Type.Boolean({
        description: readOnlyDescription,
      }),
    ),
    modelTier: Type.Optional(
      StringEnum(MODEL_TIERS, {
        description:
          'Optional model tier for delegated work. Top-level calls inherit the current model unless set; delegated calls from an isolated session default to "medium" when omitted. Use "small" only for bounded, easy-to-check investigation such as candidate discovery, file search, enumeration, or collecting possible counterexamples; verify results before relying on them. Configure mappings under subagents.modelTiers in settings; missing or invalid mappings fall back to the current model.',
      }),
    ),
  });
}

function buildSpawnSubagentDescription(
  investigationToolset: InvestigationToolset,
  runtime: SpawnToolRuntime,
): string {
  const spawnedDepth = runtime.callerDelegationDepth + 1;
  const spawnedSessionCanDelegate = canDelegateFromDepth(spawnedDepth);
  const extraTools = spawnedSessionCanDelegate ? [SPAWN_SUBAGENT_TOOL_NAME] : [];
  const defaultSubagentToolList = formatToolList(
    isolatedAgentToolNames(investigationToolset, { extraTools }),
  );
  const readOnlySubagentToolList = formatToolList(
    isolatedAgentToolNames(investigationToolset, { readOnly: true, extraTools }),
  );
  const backgroundGuidance = runtime.backgroundAllowed
    ? "Foreground mode returns the result inline; background mode returns an id. Use get_subagent_result to check status or retrieve the result."
    : "Foreground mode returns the result inline. Background mode is not available from delegated sessions.";
  const delegationGuidance = spawnedSessionCanDelegate
    ? "The delegated session may use spawn_subagent for independent focused checks within one additional delegation level when doing so materially improves quality or confidence."
    : "The delegated session cannot delegate further.";
  const modelTierGuidance = runtime.callerRecordId
    ? "Omitted modelTier defaults to medium. Reserve small for bounded, easy-to-check investigation whose output will be verified before use."
    : "Top-level calls inherit the current model unless modelTier is explicitly set; delegated calls from an isolated session default omitted modelTier to medium. Reserve small for bounded, easy-to-check investigation whose output will be verified before use.";

  const toolGuidance = runtime.forceReadOnly
    ? `Spawned sessions are read-only because the calling session is read-only; they receive ${readOnlySubagentToolList}.`
    : `Default subagents receive ${defaultSubagentToolList}; read-only subagents receive ${readOnlySubagentToolList}.`;

  return (
    "Run a delegated task in a separate general-purpose agent session. " +
    "Use this for self-contained investigation or implementation work that benefits from an isolated context. " +
    `${toolGuidance} ` +
    `${delegationGuidance} ` +
    `${modelTierGuidance} ` +
    backgroundGuidance
  );
}

function createSpawnSubagentToolDefinition(
  pi: ExtensionAPI,
  ctxProvider: (ctx: ExtensionContext) => ExtensionContext,
  investigationToolset: InvestigationToolset,
  runtime: SpawnToolRuntime,
): ToolDefinition {
  return {
    name: SPAWN_SUBAGENT_TOOL_NAME,
    label: "Spawn Subagent",
    description: buildSpawnSubagentDescription(investigationToolset, runtime),
    parameters: createSpawnSubagentParameters(runtime),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeSpawnSubagent(
        pi,
        ctxProvider(ctx),
        investigationToolset,
        runtime,
        params as SpawnSubagentParams,
        signal,
        onUpdate,
      );
    },
  } as ToolDefinition;
}

async function runSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RunSubagentOptions,
): Promise<{ session: AgentSession; result: string }> {
  if (options.abortSignal.aborted) throw new Error("Subagent stopped before it started.");

  const agentDir = getAgentDir();
  const canDelegate = canDelegateFromDepth(options.delegationDepth);
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [],
    systemPromptOverride: () =>
      buildSystemPrompt(
        ctx.getSystemPrompt(),
        ctx.cwd,
        options.readOnly,
        options.investigationToolset,
        canDelegate,
      ),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const execFn: ExecFn = (command, args, opts) =>
    pi.exec(command, args, {
      cwd: opts?.cwd ?? ctx.cwd,
      timeout: opts?.timeout,
    });

  const modelSelection = resolveSubagentModel(pi, ctx, options.modelTier, options.modelFallback);
  const nestedSpawnTool = canDelegate
    ? createSpawnSubagentToolDefinition(pi, () => ctx, options.investigationToolset, {
        callerDelegationDepth: options.delegationDepth,
        callerRecordId: options.id,
        forceReadOnly: options.readOnly,
        backgroundAllowed: false,
        modelFallback: modelSelection,
      })
    : undefined;
  const extraTools = nestedSpawnTool ? [nestedSpawnTool.name] : [];
  const customTools: ToolDefinition[] = [
    ...options.investigationToolset.tools,
    ...(options.readOnly ? [createProtectedBashToolDef(ctx.cwd, execFn)] : []),
    ...(nestedSpawnTool ? [nestedSpawnTool] : []),
  ];

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: SettingsManager.create(ctx.cwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model: modelSelection.model,
    thinkingLevel: modelSelection.thinkingLevel,
    tools: isolatedAgentToolNames(options.investigationToolset, {
      readOnly: options.readOnly,
      extraTools,
    }),
    customTools,
    resourceLoader: loader,
  });

  session.setSessionName(`subagent#${options.id}`);

  options.onSessionCreated?.(session);

  const collector = collectAssistantText(session, options.onTextUpdate);
  const abort = () => session.abort().catch(() => {});
  options.abortSignal.addEventListener("abort", abort, { once: true });

  try {
    if (options.abortSignal.aborted) {
      await session.abort().catch(() => {});
      throw new Error("Subagent stopped before it started.");
    }

    await session.prompt(options.prompt);
    return { session, result: collector.getText() || "No output." };
  } finally {
    options.abortSignal.removeEventListener("abort", abort);
    collector.unsubscribe();
  }
}

function disposeRecordSession(record: SubagentRecord): void {
  const session = record.session;
  record.session = undefined;
  try {
    session?.dispose?.();
  } catch {}
}

async function executeSpawnSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  investigationToolset: InvestigationToolset,
  runtime: SpawnToolRuntime,
  params: SpawnSubagentParams,
  signal: AbortSignal | undefined,
  onUpdate:
    | ((result: {
        content: Array<{ type: "text"; text: string }>;
        details: Record<string, unknown>;
      }) => void)
    | undefined,
) {
  const requestedModelTier = normalizeModelTier(params.modelTier);
  const background = runtime.backgroundAllowed && (params.background ?? false);
  const attachParentAbort = !background;
  if (params.background && !runtime.backgroundAllowed) {
    return textResult(
      "Background mode is not available for delegated spawn_subagent calls. Run the delegated task in foreground mode instead.",
      { status: "rejected", background: false },
    );
  }

  if (attachParentAbort && signal?.aborted) {
    return textResult("Subagent stopped before it started.", { status: "stopped" });
  }

  const parentRecord = runtime.callerRecordId ? records.get(runtime.callerRecordId) : undefined;
  if (
    runtime.callerRecordId &&
    (parentRecord?.status !== "running" || parentRecord.abortController.signal.aborted)
  ) {
    return textResult(
      "Cannot spawn delegated task because the calling session is no longer active.",
      {
        status: "error",
      },
    );
  }

  const id = makeId();
  const description = params.description?.trim() || "Subagent task";
  const abortController = new AbortController();
  const parentAbort = () => abortController.abort();
  const ownerAbort = () => abortController.abort();
  if (attachParentAbort) signal?.addEventListener("abort", parentAbort, { once: true });
  parentRecord?.abortController.signal.addEventListener("abort", ownerAbort, { once: true });
  if (parentRecord?.abortController.signal.aborted) abortController.abort();

  const record: SubagentRecord = {
    id,
    description,
    status: "running",
    startedAt: Date.now(),
    promise: Promise.resolve(),
    abortController,
    childIds: new Set(),
  };
  records.set(id, record);
  parentRecord?.childIds.add(id);

  record.promise = (async () => {
    try {
      const { session, result } = await runSubagent(pi, ctx, {
        id,
        prompt: params.prompt,
        abortSignal: abortController.signal,
        readOnly: runtime.forceReadOnly || (params.readOnly ?? false),
        delegationDepth: runtime.callerDelegationDepth + 1,
        modelTier: requestedModelTier ?? (runtime.callerRecordId ? "medium" : undefined),
        modelFallback: runtime.modelFallback,
        investigationToolset,
        onTextUpdate: background
          ? undefined
          : (text) =>
              onUpdate?.(
                textResult(`Subagent ${id} running...\n\n${truncate(text, 1200)}`, {
                  id,
                  status: "running",
                }),
              ),
        onSessionCreated: (session) => {
          record.session = session;
        },
      });
      record.session = session;
      record.status = abortController.signal.aborted ? "stopped" : "completed";
      record.result = result;
      record.completedAt = Date.now();
    } catch (error) {
      record.status = abortController.signal.aborted ? "stopped" : "error";
      record.error = error instanceof Error ? error.message : String(error);
      record.completedAt = Date.now();
    } finally {
      try {
        await stopOwnedSubagents(record);
      } finally {
        disposeRecordSession(record);
        if (attachParentAbort) signal?.removeEventListener("abort", parentAbort);
        parentRecord?.abortController.signal.removeEventListener("abort", ownerAbort);
        parentRecord?.childIds.delete(id);
      }
    }
  })();

  if (background) {
    return textResult(
      `Subagent started in background.\nID: ${id}\nDescription: ${description}\n\nUse get_subagent_result with this ID to check status or retrieve the full result.`,
      { id, status: "running", background: true },
    );
  }

  await record.promise;
  const result =
    record.status === "completed"
      ? textResult(record.result ?? "No output.", {
          id,
          status: record.status,
        })
      : textResult(`Subagent ${record.status}: ${record.error ?? "stopped"}`, {
          id,
          status: record.status,
        });
  records.delete(id);
  return result;
}

export default function (pi: ExtensionAPI) {
  const investigationToolset = createInvestigationToolset({ exec: toCliExec(pi) });

  pi.registerTool(
    createSpawnSubagentToolDefinition(pi, (ctx) => ctx, investigationToolset, {
      callerDelegationDepth: -1,
      forceReadOnly: false,
      backgroundAllowed: true,
    }),
  );

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description: "Check status and retrieve the result of a background subagent.",
    parameters: Type.Object({
      id: Type.String({
        description: "The subagent id returned by the subagent tool.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "Wait for completion before returning. Default: false.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const record = records.get(params.id);
      if (!record) return textResult(`Subagent not found: ${params.id}`);

      if (params.wait && isActiveStatus(record.status)) {
        await record.promise;
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const header = `Subagent ${record.id} | ${record.status} | ${durationMs}ms\nDescription: ${record.description}\n`;

      if (record.status === "running") {
        return textResult(`${header}\nStill running.`);
      }
      if (record.status === "completed") {
        return textResult(`${header}\n${record.result ?? "No output."}`);
      }
      return textResult(`${header}\n${record.error ?? record.status}`);
    },
  });

  pi.registerTool({
    name: "stop_subagent",
    label: "Stop Subagent",
    description: "Stop a running background subagent by ID.",
    parameters: Type.Object({
      id: Type.String({
        description: "The subagent id returned by spawn_subagent.",
      }),
    }),
    async execute(_toolCallId, params) {
      const record = records.get(params.id);
      if (!record) return textResult(`Subagent not found: ${params.id}`);
      if (!isActiveStatus(record.status)) {
        return textResult(`Subagent ${record.id} is not running (status: ${record.status}).`, {
          id: record.id,
          status: record.status,
        });
      }

      await stopRecordTree(record);
      await record.promise;

      return textResult(`Stopped subagent ${record.id}.`, {
        id: record.id,
        status: record.status,
      });
    },
  });

  pi.registerTool({
    name: "list_subagents",
    label: "List Subagents",
    description: "List subagents created in this session with their current status and IDs.",
    parameters: Type.Object({}),
    async execute() {
      const list = [...records.values()].sort((a, b) => b.startedAt - a.startedAt);
      if (list.length === 0) return textResult("No subagents in this session.", { count: 0 });

      const lines = list.map((record) => {
        const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
        return `- ${record.id} | ${record.status} | ${durationMs}ms | ${record.description}`;
      });

      return textResult(`Subagents (${list.length}):\n${lines.join("\n")}`, {
        count: list.length,
      });
    },
  });

  pi.on("session_shutdown", async () => {
    const activeRecords = [...records.values()];
    try {
      await Promise.all(activeRecords.map((record) => stopRecordTree(record)));
      await Promise.allSettled(activeRecords.map((record) => record.promise));
    } finally {
      for (const record of activeRecords) disposeRecordSession(record);
      records.clear();
      await Promise.all([investigationToolset.cleanup(), resetSandboxState()]);
    }
  });
}
