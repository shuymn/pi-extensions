import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createBashToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRegistry,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { configureFallbackRouter, getFallbackRouterCandidates } from "./fallback-router";
import { createIsolatedModelRuntime } from "./isolated-model-runtime";
import type { ThinkingLevel } from "./model-spec";
import { createProtectedBashOperations, type ExecFn, resetSandboxState } from "./protected-bash";
import { getLatestAssistantMessageText } from "./session-messages";

export const DELEGATED_RESULT_TOOL = "structured_output";
const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

// The sandbox runtime is process-global. Lease its cleanup across all shared child runners,
// so one extension/session finishing cannot reset another child's active protected bash.
let sandboxUsers = 0;
let sandboxReset: Promise<void> = Promise.resolve();
async function acquireSandbox(): Promise<() => Promise<void>> {
  let barrier: Promise<void>;
  do {
    barrier = sandboxReset;
    await barrier;
  } while (barrier !== sandboxReset);
  sandboxUsers += 1;
  return async () => {
    sandboxUsers -= 1;
    if (sandboxUsers === 0) {
      sandboxReset = resetSandboxState();
      await sandboxReset;
    }
  };
}

/** Host-owned definitions are trusted code. Read-only custom tools must be explicitly annotated. */
export interface DelegatedSessionOptions {
  cwd: string;
  modelRegistry: ModelRegistry;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  prompt: string;
  allowedTools: readonly string[];
  customTools?: readonly ToolDefinition[];
  readOnly?: boolean;
  schema?: TSchema;
  /** Required only for read-only bash; never falls back to an unprotected executor. */
  exec?: ExecFn;
  signal?: AbortSignal;
  name?: string;
  /** In-memory override; otherwise snapshot effective settings without writing them. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  onText?: (text: string) => void;
  onEvent?: (event: AgentSessionEvent) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onSessionDisposed?: (session: AgentSession) => void;
}

export interface DelegatedSessionResult {
  status: "completed" | "failed" | "cancelled";
  result?: unknown;
  text: string;
  error?: string;
  usage: Usage;
  evidence: {
    messages: AgentMessage[];
    branch: SessionEntry[];
  };
}

function assistantText(session: AgentSession): string {
  return (
    getLatestAssistantMessageText(
      session.messages.filter((message) => message.role === "assistant"),
    )?.trim() ?? ""
  );
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(total: Usage, usage: Usage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    total[key] += usage[key];
  }
  for (const key of ["cacheWrite1h", "reasoning"] as const) {
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    total.cost[key] += usage.cost[key];
  }
}

function selectedToolDefinitions(options: DelegatedSessionOptions): ToolDefinition[] {
  const allowed = new Set(options.allowedTools);
  const definitions = new Map<string, ToolDefinition>();
  for (const tool of options.customTools ?? []) {
    if (definitions.has(tool.name)) throw new Error(`Duplicate delegated tool: ${tool.name}`);
    definitions.set(tool.name, tool);
  }
  if (allowed.has(DELEGATED_RESULT_TOOL) || definitions.has(DELEGATED_RESULT_TOOL)) {
    throw new Error(`${DELEGATED_RESULT_TOOL} is reserved for the terminal schema result`);
  }
  for (const name of allowed) {
    const custom = definitions.get(name);
    if (!BUILTIN_TOOLS.has(name) && !custom) {
      throw new Error(`Delegated allowedTools includes unavailable tool: ${name}`);
    }
    if (options.readOnly && name !== "bash") {
      if (
        name === "edit" ||
        name === "write" ||
        (custom ? custom.annotations?.readOnlyHint !== true : !READ_ONLY_TOOLS.has(name))
      ) {
        throw new Error(`Delegated read-only policy denies tool: ${name}`);
      }
    }
  }
  const selected = [...definitions.values()].filter((tool) => allowed.has(tool.name));
  if (options.readOnly && allowed.has("bash")) {
    if (!options.exec) throw new Error("Delegated read-only bash requires a protected executor");
    const index = selected.findIndex((tool) => tool.name === "bash");
    if (index !== -1) selected.splice(index, 1);
    selected.push({
      ...createBashToolDefinition(options.cwd, {
        operations: createProtectedBashOperations(options.exec, options.cwd),
      }),
      name: "bash",
      label: "bash",
    } as ToolDefinition);
  }
  return selected;
}

/**
 * Execute exactly one child conversation. Pi owns retries/continuations; this function never
 * restarts a task. All resources and settings are isolated and disposal is unconditional.
 * Returned evidence is in memory; hosts may persist/redact it using their own artifact policy.
 */
export async function runDelegatedSession(
  options: DelegatedSessionOptions,
): Promise<DelegatedSessionResult> {
  const outcome: DelegatedSessionResult = {
    status: "failed",
    text: "",
    usage: emptyUsage(),
    evidence: { messages: [], branch: [] },
  };
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let releaseSandbox: (() => Promise<void>) | undefined;
  let terminalResult: unknown;
  let hasTerminalResult = false;
  let streamedText = "";
  const abort = () => {
    void session?.abort().catch(() => {});
  };
  const manager = SessionManager.inMemory(options.cwd);
  try {
    if (options.signal?.aborted) throw new Error("Delegated session aborted before it started");
    const customTools = selectedToolDefinitions(options);
    if (options.readOnly && options.allowedTools.includes("bash"))
      releaseSandbox = await acquireSandbox();
    const allowed = new Set(options.allowedTools);
    if (options.schema) {
      allowed.add(DELEGATED_RESULT_TOOL);
      customTools.push({
        name: DELEGATED_RESULT_TOOL,
        exposure: "model-only",
        label: "Structured Output",
        description:
          "Submit the final schema-backed result. Call exactly once as the final action, without other tool calls in the same batch.",
        parameters: options.schema,
        async execute(_id, params) {
          if (hasTerminalResult) throw new Error("A terminal result has already been submitted");
          terminalResult = params;
          hasTerminalResult = true;
          return {
            content: [{ type: "text", text: "Recorded terminal result." }],
            details: params,
            terminate: true,
          };
        },
      } as ToolDefinition);
    }
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.inMemory(
      options.settings ?? SettingsManager.create(options.cwd, agentDir).getSettings(),
    );
    const loader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", (_event, ctx) => {
            const candidates = getFallbackRouterCandidates(options.modelRegistry);
            if (candidates) configureFallbackRouter(ctx.modelRegistry, candidates);
          });
          pi.on("tool_call", (event) => {
            if (!allowed.has(event.toolName))
              return { block: true, reason: `Delegated tool policy denies: ${event.toolName}` };
            if (hasTerminalResult)
              return { block: true, reason: "The terminal result has already been submitted" };
            // A terminal result cannot race sibling effects or rely on Pi's all-tools-terminate rule.
            if (event.toolName === DELEGATED_RESULT_TOOL) {
              const last = session?.messages
                .filter((message) => message.role === "assistant")
                .at(-1);
              if (
                last?.role === "assistant" &&
                last.content.filter((part) => part.type === "toolCall").length !== 1
              ) {
                return {
                  block: true,
                  reason: "Submit structured_output alone, without sibling tool calls",
                };
              }
            }
            return undefined;
          });
        },
      ],
      systemPromptOverride: () =>
        `${options.systemPrompt}\n\n<delegated_task_context>\nComplete the assigned task within its authorization boundaries. Return evidence and unresolved limits.\nAvailable tools: ${[...allowed].join(", ") || "none"}. Inherited tool descriptions grant no additional tools.\n${options.readOnly ? "This session is read-only. Do not mutate repository files. If bash is available, it enforces repository-write protection, not complete host/network isolation. Use temporary scratch files only for authorized investigation.\n" : ""}${options.schema ? "Finish by calling structured_output exactly once, alone, with the final machine-readable result.\n" : ""}Working directory: ${options.cwd}\n</delegated_task_context>`,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      sessionManager: manager,
      settingsManager,
      modelRuntime: await createIsolatedModelRuntime(options.modelRegistry),
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      tools: [...allowed],
      customTools,
      resourceLoader: loader,
    }));
    if (options.name) session.setSessionName(options.name);
    options.signal?.addEventListener("abort", abort, { once: true });
    unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") streamedText = "";
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        streamedText += event.assistantMessageEvent.delta;
        options.onText?.(streamedText);
      }
      if (
        event.type === "message_end" &&
        (event.message.role === "assistant" || event.message.role === "toolResult") &&
        event.message.usage
      ) {
        addUsage(outcome.usage, event.message.usage);
      }
      // Native summaries are billed outside assistant/tool message events.
      if (event.type === "compaction_end" && event.result?.usage) {
        addUsage(outcome.usage, event.result.usage);
      }
      options.onEvent?.(event);
    });
    await session.bindExtensions({});
    options.onSessionCreated?.(session);
    if (options.signal?.aborted) throw new Error("Delegated session aborted before it started");
    await session.prompt(options.prompt);
    const lastAssistant = session.messages.filter((message) => message.role === "assistant").at(-1);
    if (options.signal?.aborted || lastAssistant?.stopReason === "aborted") {
      outcome.status = "cancelled";
      throw new Error("Delegated session aborted");
    }
    if (lastAssistant?.stopReason === "error")
      throw new Error(lastAssistant.errorMessage ?? "Delegated model request failed");
    if (options.schema && !hasTerminalResult)
      throw new Error("Expected a schema-backed structured_output result, but none was submitted");
    outcome.status = "completed";
    outcome.result = options.schema
      ? terminalResult
      : assistantText(session) || streamedText.trim();
  } catch (error) {
    outcome.status =
      options.signal?.aborted || outcome.status === "cancelled" ? "cancelled" : "failed";
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe?.();
    if (session) {
      outcome.text = assistantText(session) || streamedText.trim();
      outcome.evidence = { messages: [...session.messages], branch: manager.getBranch() };
      try {
        try {
          session.dispose();
        } finally {
          options.onSessionDisposed?.(session);
        }
      } catch (error) {
        if (outcome.status === "completed") outcome.status = "failed";
        outcome.error ??= error instanceof Error ? error.message : String(error);
      }
    }
    try {
      await releaseSandbox?.();
    } catch (error) {
      if (outcome.status === "completed") outcome.status = "failed";
      outcome.error ??= error instanceof Error ? error.message : String(error);
    }
  }
  return outcome;
}
