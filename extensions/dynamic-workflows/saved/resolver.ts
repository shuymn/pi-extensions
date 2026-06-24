import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseWorkflowScript, type WorkflowMeta, WorkflowParseError } from "../runtime/parser";

/**
 * Provenance of a saved workflow. `project` is the project-local
 * `.pi/workflows` root, `skill` is a skill-packaged `workflows/` root, and
 * `extension` is an official workflow packaged with this Pi Extension package.
 * Provenance is surfaced so callers and users can distinguish overrides without
 * inspecting file paths, and so direct slash-command registration can stay
 * project-local. Provenance is never an authorization signal.
 */
export type WorkflowSource = "project" | "skill" | "extension";

export type WorkflowRootDescriptor = {
  path: string;
  source: WorkflowSource;
};

export type SavedWorkflow = WorkflowMeta & {
  path: string;
  fileName: string;
  script: string;
  source: WorkflowSource;
};

export type SavedWorkflowRootInput = string | WorkflowRootDescriptor;
export type SavedWorkflowRoots = SavedWorkflowRootInput | readonly SavedWorkflowRootInput[];

// Bare roots passed directly to the resolver keep the legacy project-local
// meaning. WorkflowCatalog maps bare additional roots to `skill` before calling
// this resolver; keep that provenance boundary explicit in both modules.
const DEFAULT_WORKFLOW_SOURCE: WorkflowSource = "project";

export async function listSavedWorkflows(
  workflowRoots: SavedWorkflowRoots,
): Promise<SavedWorkflow[]> {
  const workflows = (
    await Promise.all(
      normalizeSavedWorkflowRootDescriptors(workflowRoots).map(listSavedWorkflowsInRoot),
    )
  )
    .flat()
    .filter((workflow): workflow is SavedWorkflow => workflow !== undefined);

  return workflows.sort(compareSavedWorkflows);
}

export async function resolveSavedWorkflow(
  workflowRoots: SavedWorkflowRoots,
  name: string,
): Promise<SavedWorkflow> {
  for (const descriptor of normalizeSavedWorkflowRootDescriptors(workflowRoots)) {
    const workflows = (await listSavedWorkflowsInRoot(descriptor)).filter(
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
  descriptor: WorkflowRootDescriptor,
): Promise<Array<SavedWorkflow | undefined>> {
  const entries = await readWorkflowRootEntries(descriptor.path);
  return await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => readSavedWorkflow(descriptor, entry)),
  );
}

async function readSavedWorkflow(
  descriptor: WorkflowRootDescriptor,
  entry: Dirent,
): Promise<SavedWorkflow | undefined> {
  const path = join(descriptor.path, entry.name);
  const script = await readFile(path, "utf8");
  try {
    const parsed = parseWorkflowScript(script);
    return {
      ...parsed.meta,
      path,
      fileName: entry.name,
      script,
      source: descriptor.source,
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

/**
 * Normalize mixed string/descriptor root inputs into deduplicated descriptors.
 * The first occurrence of a path wins, so callers control precedence by order
 * (project roots first keeps project overrides authoritative). Bare string
 * roots default to the `project` source for backward compatibility. Catalog
 * callers that accept additional roots map bare strings to `skill` in
 * `buildWorkflowCatalogRoots`; callers that mix skill/extension roots should
 * pass explicit descriptors.
 */
export function normalizeSavedWorkflowRootDescriptors(
  workflowRoots: SavedWorkflowRoots,
): WorkflowRootDescriptor[] {
  const inputs: readonly SavedWorkflowRootInput[] = Array.isArray(workflowRoots)
    ? (workflowRoots as readonly SavedWorkflowRootInput[])
    : [workflowRoots as SavedWorkflowRootInput];

  const descriptors: WorkflowRootDescriptor[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const descriptor: WorkflowRootDescriptor =
      typeof input === "string" ? { path: input, source: DEFAULT_WORKFLOW_SOURCE } : input;
    if (descriptor.path.length === 0 || seen.has(descriptor.path)) continue;
    seen.add(descriptor.path);
    descriptors.push(descriptor);
  }
  return descriptors;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
