import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type WorkflowAgentTranscriptStatus = "completed" | "failed" | "cancelled";

export type WorkflowAgentTranscriptRunContext = {
  runId: string;
  taskId: string;
  workflowName?: string;
  transcriptsDir: string;
};

export type WorkflowAgentTranscriptError = {
  message: string;
  name?: string;
};

export type WorkflowAgentTranscriptMetadata = {
  transcriptId: string;
  runId: string;
  taskId: string;
  workflowName?: string;
  cwd: string;
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  requestedModel?: string;
  thinkingLevel?: string;
  requestedThinkingLevel?: string;
  isolation?: "worktree";
  hasSchema: boolean;
  status: WorkflowAgentTranscriptStatus;
  prompt: string;
  sessionPrompt: string;
  sessionName: string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  resultPreview?: string;
  error?: WorkflowAgentTranscriptError;
};

export type WorkflowAgentTranscript = {
  schemaVersion: 1;
  metadata: WorkflowAgentTranscriptMetadata;
  messages: unknown;
};

export type CreateWorkflowAgentTranscriptInput = {
  target: WorkflowAgentTranscriptRunContext & { transcriptId: string };
  cwd: string;
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  requestedModel?: string;
  thinkingLevel?: string;
  requestedThinkingLevel?: string;
  isolation?: "worktree";
  hasSchema: boolean;
  status: WorkflowAgentTranscriptStatus;
  prompt: string;
  sessionPrompt: string;
  sessionName: string;
  startedAt: Date;
  completedAt: Date;
  result?: unknown;
  error?: unknown;
  messages: unknown;
};

export function createWorkflowAgentTranscript(
  input: CreateWorkflowAgentTranscriptInput,
): WorkflowAgentTranscript {
  return {
    schemaVersion: 1,
    metadata: {
      transcriptId: input.target.transcriptId,
      runId: input.target.runId,
      taskId: input.target.taskId,
      ...(input.target.workflowName === undefined
        ? {}
        : { workflowName: input.target.workflowName }),
      cwd: input.cwd,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.phase === undefined ? {} : { phase: input.phase }),
      ...(input.agentType === undefined ? {} : { agentType: input.agentType }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.requestedModel === undefined ? {} : { requestedModel: input.requestedModel }),
      ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
      ...(input.requestedThinkingLevel === undefined
        ? {}
        : { requestedThinkingLevel: input.requestedThinkingLevel }),
      ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
      hasSchema: input.hasSchema,
      status: input.status,
      prompt: input.prompt,
      sessionPrompt: input.sessionPrompt,
      sessionName: input.sessionName,
      startedAt: input.startedAt.toISOString(),
      completedAt: input.completedAt.toISOString(),
      durationMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
      ...resultPreviewMetadata(input.result),
      ...(input.error === undefined ? {} : { error: workflowAgentTranscriptError(input.error) }),
    },
    messages: input.messages,
  };
}

export function createWorkflowAgentTranscriptId(index: number, label?: string): string {
  const prefix = String(index).padStart(4, "0");
  const suffix = sanitizeLabel(label);
  return suffix ? `${prefix}-${suffix}` : prefix;
}

export async function writeWorkflowAgentTranscript(
  transcriptsDir: string,
  transcript: WorkflowAgentTranscript,
): Promise<string> {
  await mkdir(transcriptsDir, { recursive: true });
  const path = join(transcriptsDir, `${transcript.metadata.transcriptId}.json`);
  const json = JSON.stringify(transcript, null, 2);
  if (json === undefined) throw new Error("workflow agent transcript must be JSON-serializable.");
  await writeFile(path, `${json}\n`);
  return path;
}

export function workflowAgentTranscriptError(error: unknown): WorkflowAgentTranscriptError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  return { message: String(error) };
}

export function workflowAgentTranscriptPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return text.length <= 800 ? text : `${text.slice(0, 800)}…`;
}

function resultPreviewMetadata(result: unknown): { resultPreview?: string } {
  const resultPreview = workflowAgentTranscriptPreview(result);
  return resultPreview === undefined ? {} : { resultPreview };
}

function sanitizeLabel(label: string | undefined): string {
  if (!label) return "";
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
