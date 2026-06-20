import type { WorkflowPhaseMeta } from "../runtime/parser";

export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type WorkflowPhaseStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type WorkflowAgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type WorkflowRunAgentState = {
  id: string;
  label: string;
  phase?: string;
  status: WorkflowAgentStatus;
  promptPreview: string;
  resultPreview?: string;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type WorkflowRunPhaseState = {
  title: string;
  description?: string;
  status: WorkflowPhaseStatus;
  startedAt?: string;
  completedAt?: string;
};

export type WorkflowRunFailure = {
  message: string;
  phase?: string;
  agentLabel?: string;
  timestamp: string;
};

export type WorkflowRunProgress = {
  currentPhase?: string;
  queuedAgents: number;
  completedAgents: number;
  failedAgents: number;
  runningAgents: number;
};

export type WorkflowRunState = {
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sessionId?: string;
  cwd: string;
  workflowName: string;
  description?: string;
  status: WorkflowRunStatus;
  scriptPath?: string;
  phases: WorkflowRunPhaseState[];
  logs: string[];
  agents: WorkflowRunAgentState[];
  workflowProgress: WorkflowRunProgress;
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  startTime: string;
  updatedAt: string;
  durationMs?: number;
  outputPath?: string;
  resultPreview?: string;
  failures: WorkflowRunFailure[];
};

export type CreateInitialWorkflowRunStateInput = {
  runId: string;
  taskId: string;
  sessionId?: string;
  cwd: string;
  workflowName: string;
  description?: string;
  phases: WorkflowPhaseMeta[];
  scriptPath?: string;
  startTime?: string;
};

export function createInitialWorkflowRunState(
  input: CreateInitialWorkflowRunStateInput,
): WorkflowRunState {
  const startTime = input.startTime ?? new Date().toISOString();

  return {
    schemaVersion: 1,
    runId: input.runId,
    taskId: input.taskId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    cwd: input.cwd,
    workflowName: input.workflowName,
    ...(input.description === undefined ? {} : { description: input.description }),
    status: "queued",
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    phases: input.phases.map((phase) => ({
      title: phase.title,
      ...(phase.description === undefined ? {} : { description: phase.description }),
      status: "pending" as const,
    })),
    logs: [],
    agents: [],
    workflowProgress: {
      currentPhase: undefined,
      queuedAgents: 0,
      completedAgents: 0,
      failedAgents: 0,
      runningAgents: 0,
    },
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    startTime,
    updatedAt: startTime,
    durationMs: undefined,
    outputPath: undefined,
    resultPreview: undefined,
    failures: [],
  };
}

export function serializeWorkflowRunState(state: WorkflowRunState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
