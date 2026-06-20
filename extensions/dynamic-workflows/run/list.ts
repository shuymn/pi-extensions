import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowRunState, WorkflowRunStatus } from "./model";

const WORKFLOW_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type WorkflowRunManifestListOptions = {
  sessionId?: string;
};

export async function listWorkflowRunManifests(
  rootDir: string,
  options: WorkflowRunManifestListOptions = {},
): Promise<WorkflowRunState[]> {
  const entries = await readRootEntries(rootDir);

  const states = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => readManifest(join(rootDir, entry.name, "manifest.json"))),
  );

  return states
    .filter((state): state is WorkflowRunState => Boolean(state))
    .filter((state) => isSessionVisibleWorkflowRun(state, options.sessionId))
    .sort(compareWorkflowRunsNewestFirst);
}

export function isSessionVisibleWorkflowRun(
  state: Pick<WorkflowRunState, "sessionId">,
  sessionId?: string,
): boolean {
  if (!sessionId) return true;
  return state.sessionId === undefined || state.sessionId === sessionId;
}

async function readManifest(path: string): Promise<WorkflowRunState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isWorkflowRunState(value) ? value : undefined;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readRootEntries(rootDir: string): Promise<Dirent[]> {
  try {
    return await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

function compareWorkflowRunsNewestFirst(left: WorkflowRunState, right: WorkflowRunState): number {
  const rightTime = workflowRunSortTime(right);
  const leftTime = workflowRunSortTime(left);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return right.runId.localeCompare(left.runId);
}

function workflowRunSortTime(state: WorkflowRunState): number {
  return Date.parse(state.updatedAt) || Date.parse(state.startTime) || 0;
}

function isWorkflowRunState(value: unknown): value is WorkflowRunState {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.runId !== "string") return false;
  if (typeof value.taskId !== "string") return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return false;
  if (typeof value.cwd !== "string") return false;
  if (typeof value.workflowName !== "string") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (typeof value.status !== "string" || !isWorkflowRunStatus(value.status)) return false;
  if (value.scriptPath !== undefined && typeof value.scriptPath !== "string") return false;
  if (!Array.isArray(value.phases) || !value.phases.every(isWorkflowRunPhaseState)) return false;
  if (!Array.isArray(value.logs) || !value.logs.every((log) => typeof log === "string")) {
    return false;
  }
  if (!Array.isArray(value.agents) || !value.agents.every(isWorkflowRunAgentState)) return false;
  if (!isWorkflowRunProgress(value.workflowProgress)) return false;
  if (typeof value.agentCount !== "number") return false;
  if (typeof value.totalTokens !== "number") return false;
  if (typeof value.totalToolCalls !== "number") return false;
  if (typeof value.startTime !== "string") return false;
  if (typeof value.updatedAt !== "string") return false;
  if (value.durationMs !== undefined && typeof value.durationMs !== "number") return false;
  if (value.outputPath !== undefined && typeof value.outputPath !== "string") return false;
  if (value.resultPreview !== undefined && typeof value.resultPreview !== "string") return false;
  if (!Array.isArray(value.failures) || !value.failures.every(isWorkflowRunFailure)) return false;
  return true;
}

function isWorkflowRunPhaseState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.title !== "string") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (typeof value.status !== "string") return false;
  return ["pending", "running", "completed", "failed", "cancelled", "skipped"].includes(
    value.status,
  );
}

function isWorkflowRunAgentState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.label !== "string") return false;
  if (value.phase !== undefined && typeof value.phase !== "string") return false;
  if (typeof value.status !== "string") return false;
  if (!["queued", "running", "completed", "failed", "cancelled"].includes(value.status)) {
    return false;
  }
  if (typeof value.promptPreview !== "string") return false;
  if (value.resultPreview !== undefined && typeof value.resultPreview !== "string") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  if (typeof value.queuedAt !== "string") return false;
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false;
  if (value.completedAt !== undefined && typeof value.completedAt !== "string") return false;
  return true;
}

function isWorkflowRunProgress(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.currentPhase !== undefined && typeof value.currentPhase !== "string") return false;
  return (
    typeof value.queuedAgents === "number" &&
    typeof value.completedAgents === "number" &&
    typeof value.failedAgents === "number" &&
    typeof value.runningAgents === "number"
  );
}

function isWorkflowRunFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.message !== "string") return false;
  if (value.phase !== undefined && typeof value.phase !== "string") return false;
  if (value.agentLabel !== undefined && typeof value.agentLabel !== "string") return false;
  return typeof value.timestamp === "string";
}

function isWorkflowRunStatus(status: string): status is WorkflowRunStatus {
  return WORKFLOW_RUN_STATUSES.has(status as WorkflowRunStatus);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
