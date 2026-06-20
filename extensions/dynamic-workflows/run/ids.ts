import { randomUUID } from "node:crypto";

export type IdGenerationOptions = {
  now?: () => number;
  random?: () => string;
};

export function createWorkflowRunId(options: IdGenerationOptions = {}): string {
  const timestamp = formatTimestamp(options.now?.() ?? Date.now());
  return `wf_${timestamp}_${randomSuffix(options)}`;
}

export function createTaskId(options: Pick<IdGenerationOptions, "random"> = {}): string {
  return `task_${randomSuffix(options)}`;
}

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");
}

function randomSuffix(options: Pick<IdGenerationOptions, "random">): string {
  return (options.random?.() ?? randomUUID()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
}
