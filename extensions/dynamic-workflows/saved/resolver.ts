import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowScript, type WorkflowMeta, WorkflowParseError } from "../runtime/parser";

export type SavedWorkflow = WorkflowMeta & {
  path: string;
  fileName: string;
  script: string;
};

export type SavedWorkflowRoots = string | readonly string[];

export async function listSavedWorkflows(
  workflowRoots: SavedWorkflowRoots,
): Promise<SavedWorkflow[]> {
  const workflows = (
    await Promise.all(normalizeSavedWorkflowRoots(workflowRoots).map(listSavedWorkflowsInRoot))
  )
    .flat()
    .filter((workflow): workflow is SavedWorkflow => workflow !== undefined);

  return workflows.sort(compareSavedWorkflows);
}

export async function resolveSavedWorkflow(
  workflowRoots: SavedWorkflowRoots,
  name: string,
): Promise<SavedWorkflow> {
  for (const workflowRoot of normalizeSavedWorkflowRoots(workflowRoots)) {
    const workflows = (await listSavedWorkflowsInRoot(workflowRoot)).filter(
      (workflow): workflow is SavedWorkflow => workflow?.name === name,
    );
    if (workflows.length === 0) continue;
    if (workflows.length > 1) {
      throw new Error(
        `multiple saved workflows named ${name}: ${workflows.map((workflow) => workflow.path).join(", ")}`,
      );
    }
    const workflow = workflows[0];
    if (workflow !== undefined) return workflow;
  }

  throw new Error(`saved workflow not found: ${name}`);
}

async function listSavedWorkflowsInRoot(
  workflowRoot: string,
): Promise<Array<SavedWorkflow | undefined>> {
  const entries = await readWorkflowRootEntries(workflowRoot);
  return await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => readSavedWorkflow(workflowRoot, entry)),
  );
}

async function readSavedWorkflow(
  workflowRoot: string,
  entry: Dirent,
): Promise<SavedWorkflow | undefined> {
  const path = join(workflowRoot, entry.name);
  const script = await readFile(path, "utf8");
  try {
    const parsed = parseWorkflowScript(script);
    return {
      ...parsed.meta,
      path,
      fileName: entry.name,
      script,
    };
  } catch (error) {
    if (error instanceof WorkflowParseError) return undefined;
    throw error;
  }
}

async function readWorkflowRootEntries(workflowRoot: string): Promise<Dirent[]> {
  try {
    return await readdir(workflowRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

function compareSavedWorkflows(left: SavedWorkflow, right: SavedWorkflow): number {
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) return byName;
  const byFileName = left.fileName.localeCompare(right.fileName);
  return byFileName === 0 ? left.path.localeCompare(right.path) : byFileName;
}

export function mergeSavedWorkflowRoots(
  workflowRoot: string,
  additionalWorkflowRoots: readonly string[] = [],
): string[] {
  return normalizeSavedWorkflowRoots([workflowRoot, ...additionalWorkflowRoots]);
}

export function normalizeSavedWorkflowRoots(workflowRoots: SavedWorkflowRoots): string[] {
  const roots = Array.isArray(workflowRoots) ? workflowRoots : [workflowRoots];
  return [...new Set(roots.filter((root) => root.length > 0))];
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
