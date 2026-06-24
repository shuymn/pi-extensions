import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  type InvestigationToolset,
  isolatedAgentToolNames,
} from "../../../lib/investigation-tools";
import {
  formatModelSpecWithThinking,
  parseModelSpec,
  type ThinkingLevel,
} from "../../../lib/model-spec";
import { getLatestAssistantMessageText } from "../../../lib/session-messages";
import type { JsonSchema, WorkflowAgent, WorkflowAgentOptions } from "../runtime/runtime";
import { createWorkflowAgentTranscript, writeWorkflowAgentTranscript } from "./transcript";

type WorkflowInvestigationToolset = Pick<InvestigationToolset, "tools" | "toolNames">;

type WorkflowRunnerPi = Pick<ExtensionAPI, "getThinkingLevel">;
type WorkflowRunnerContext = Pick<
  ExtensionContext,
  "cwd" | "modelRegistry" | "model" | "getSystemPrompt"
>;

export type WorkflowAgentRunnerOptions = WorkflowAgentOptions & {
  signal?: AbortSignal;
};

export function createWorkflowAgentRunner(
  pi: WorkflowRunnerPi,
  ctx: WorkflowRunnerContext,
  investigationToolset: WorkflowInvestigationToolset,
): WorkflowAgent {
  return (prompt, options) =>
    runWorkflowSubagent(
      pi,
      ctx,
      investigationToolset,
      prompt,
      options as WorkflowAgentRunnerOptions,
    );
}

async function runWorkflowSubagent(
  pi: WorkflowRunnerPi,
  ctx: WorkflowRunnerContext,
  investigationToolset: WorkflowInvestigationToolset,
  prompt: string,
  options: WorkflowAgentRunnerOptions,
): Promise<unknown> {
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [],
    systemPromptOverride: () => buildWorkflowSubagentSystemPrompt(ctx.getSystemPrompt(), ctx.cwd),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const structuredOutputTool = options.schema
    ? createStructuredOutputTool(options.schema)
    : undefined;
  const tools = isolatedAgentToolNames(investigationToolset, {
    extraTools: structuredOutputTool ? [structuredOutputTool.name] : [],
  });
  const customTools = [
    ...investigationToolset.tools,
    ...(structuredOutputTool ? [structuredOutputTool] : []),
  ];

  const selection = resolveWorkflowSubagentModel(ctx, options.model, pi.getThinkingLevel());
  const runnerOptions: WorkflowAgentRunnerOptions =
    selection.normalizedModel === undefined
      ? options
      : { ...options, model: selection.normalizedModel };
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    settingsManager: SettingsManager.create(ctx.cwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model: selection.model,
    thinkingLevel: selection.thinkingLevel,
    tools,
    customTools,
    resourceLoader: loader,
  });

  const sessionName = `workflow#${runnerOptions.label ?? "agent"}`;
  const sessionPrompt = buildWorkflowSubagentPrompt(prompt, runnerOptions);
  const startedAt = new Date();
  session.setSessionName(sessionName);

  const collector = collectAssistantText(session);
  const abort = () => session.abort().catch(() => {});
  runnerOptions.signal?.addEventListener("abort", abort, { once: true });
  let outcome: WorkflowSubagentOutcome;
  let transcriptError: unknown;

  try {
    outcome = await runPromptAndCollectResult(session, sessionPrompt, collector, runnerOptions);
  } catch (error) {
    outcome = {
      status: runnerOptions.signal?.aborted ? "cancelled" : "failed",
      error,
    };
  }

  try {
    await persistWorkflowSubagentTranscript({
      ctx,
      options: runnerOptions,
      prompt,
      sessionPrompt,
      sessionName,
      session,
      thinkingLevel: selection.thinkingLevel,
      model: selection.modelId,
      outcome,
      startedAt,
      completedAt: new Date(),
    });
  } catch (error) {
    transcriptError = error;
  } finally {
    runnerOptions.signal?.removeEventListener("abort", abort);
    collector.unsubscribe();
    session.dispose?.();
  }

  if (outcome.status !== "completed") throw outcome.error;
  if (transcriptError !== undefined) {
    console.warn(
      `workflow subagent transcript persistence failed: ${errorMessage(transcriptError)}`,
    );
  }
  return outcome.result;
}

type WorkflowSubagentOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed" | "cancelled"; error: unknown };

async function runPromptAndCollectResult(
  session: AgentSession,
  sessionPrompt: string,
  collector: ReturnType<typeof collectAssistantText>,
  options: WorkflowAgentRunnerOptions,
): Promise<WorkflowSubagentOutcome> {
  if (options.signal?.aborted) {
    await session.abort().catch(() => {});
    throw new Error("aborted");
  }

  await session.prompt(sessionPrompt);

  if (options.signal?.aborted) throw new Error("aborted");
  if (options.schema) {
    const structuredOutput = findLatestStructuredOutputDetails(session.messages);
    if (structuredOutput === undefined) {
      throw new Error(
        "Workflow agent was expected to finish with structured_output, but none was found.",
      );
    }
    return { status: "completed", result: structuredOutput };
  }
  return { status: "completed", result: collector.getText() || "No output." };
}

async function persistWorkflowSubagentTranscript(input: {
  ctx: WorkflowRunnerContext;
  options: WorkflowAgentRunnerOptions;
  prompt: string;
  sessionPrompt: string;
  sessionName: string;
  session: AgentSession;
  thinkingLevel?: string;
  model?: string;
  outcome: WorkflowSubagentOutcome;
  startedAt: Date;
  completedAt: Date;
}): Promise<void> {
  const target = input.options.transcript;
  if (target === undefined) return;

  await writeWorkflowAgentTranscript(
    target.transcriptsDir,
    createWorkflowAgentTranscript({
      target,
      cwd: input.ctx.cwd,
      ...(input.options.label === undefined ? {} : { label: input.options.label }),
      ...(input.options.phase === undefined ? {} : { phase: input.options.phase }),
      ...(input.options.agentType === undefined ? {} : { agentType: input.options.agentType }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      hasSchema: input.options.schema !== undefined,
      status: input.outcome.status,
      prompt: input.prompt,
      sessionPrompt: input.sessionPrompt,
      sessionName: input.sessionName,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      ...(input.outcome.status === "completed"
        ? { result: input.outcome.result }
        : { error: input.outcome.error }),
      messages: input.session.messages,
    }),
  );
}

type WorkflowSubagentModelSelection = {
  model: WorkflowRunnerContext["model"];
  thinkingLevel: ThinkingLevel;
  modelId?: string;
  normalizedModel?: string;
};

function resolveWorkflowSubagentModel(
  ctx: WorkflowRunnerContext,
  requestedModel: string | undefined,
  parentThinkingLevel: ThinkingLevel,
): WorkflowSubagentModelSelection {
  if (requestedModel === undefined) {
    const model = ctx.model;
    return {
      model,
      thinkingLevel: parentThinkingLevel,
      modelId: currentModelId(model),
    };
  }

  const spec = parseModelSpec(requestedModel);
  if (spec === undefined) {
    throw new Error("workflow agent model must use provider/model or provider/model:effort.");
  }

  const normalizedModel = formatModelSpecWithThinking(spec);
  const model = ctx.modelRegistry.find(spec.provider, spec.model);
  if (model === undefined) {
    throw new Error(`workflow agent model not found: ${normalizedModel}`);
  }

  return {
    model,
    thinkingLevel: spec.thinkingLevel ?? parentThinkingLevel,
    modelId: currentModelId(model) ?? `${spec.provider}/${spec.model}`,
    normalizedModel,
  };
}

function currentModelId(model: WorkflowRunnerContext["model"]): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const candidate = model as { provider?: unknown; id?: unknown };
  if (typeof candidate.provider === "string" && typeof candidate.id === "string") {
    return `${candidate.provider}/${candidate.id}`;
  }
  if (typeof candidate.id === "string") return candidate.id;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildWorkflowSubagentSystemPrompt(parentSystemPrompt: string, cwd: string): string {
  return `${parentSystemPrompt}

<workflow_subagent_context>
You are a workflow subagent running in an isolated in-memory Pi session.
Complete the delegated workflow task autonomously, then return a concise final result.

Operational rules:
- Use only the tools available in this subagent session.
- Do not call or simulate subagents recursively.
- Do not invoke dynamic workflow tools recursively.
- Use absolute file paths in file references when practical.
- Be concise but complete in your final answer.
- Do not ask the parent agent to do work you can do yourself.
Working directory: ${cwd}
</workflow_subagent_context>`;
}

function buildWorkflowSubagentPrompt(prompt: string, options: WorkflowAgentRunnerOptions): string {
  const metadata = [
    options.phase ? `Workflow phase: ${options.phase}` : undefined,
    options.label ? `Workflow agent label: ${options.label}` : undefined,
    options.agentType ? `Workflow agent type: ${options.agentType}` : undefined,
    options.model ? `Workflow agent model: ${options.model}` : undefined,
  ].filter((line): line is string => line !== undefined);

  const structuredOutputInstruction = options.schema
    ? "You must finish by calling the structured_output tool exactly once with the final machine-readable result. Do not emit a prose-only final answer."
    : undefined;
  const header = [...metadata, structuredOutputInstruction]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return `${header}${header ? "\n\n" : ""}${prompt}`;
}

function collectAssistantText(session: AgentSession): {
  getText: () => string;
  unsubscribe: () => void;
} {
  let current = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") current = "";
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      current += event.assistantMessageEvent.delta;
    }
  });

  return {
    getText: () => current.trim() || getLatestAssistantMessageText(session.messages)?.trim() || "",
    unsubscribe,
  };
}

function createStructuredOutputTool(schema: JsonSchema): ToolDefinition {
  return {
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return the final machine-readable result for this workflow subagent. Use this as the last action when the workflow agent options include a schema.",
    promptSnippet: "Emit the final schema-backed workflow subagent result and end the turn",
    promptGuidelines: [
      "Use structured_output as the final action when it is available in a workflow subagent session.",
      "Do not emit a prose-only final answer after calling structured_output.",
    ],
    parameters: schema as TSchema,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text" as const, text: "Recorded structured workflow output." }],
        details: params,
        terminate: true,
      };
    },
  } as ToolDefinition;
}

function findLatestStructuredOutputDetails(messages: unknown): unknown | undefined {
  if (!messages || typeof messages !== "object") return undefined;

  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const value = findLatestStructuredOutputDetails(messages[index]);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  const record = messages as Record<string, unknown>;
  if (record.toolName === "structured_output" && "details" in record) return record.details;

  const values = Object.values(record);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = findLatestStructuredOutputDetails(values[index]);
    if (value !== undefined) return value;
  }
  return undefined;
}
