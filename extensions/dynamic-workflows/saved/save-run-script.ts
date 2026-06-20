import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getWorkflowRunPaths } from "../run/store";
import { parseWorkflowScript } from "../runtime/parser";
import { workflowCatalogForRoot } from "./catalog";

export type SaveWorkflowRunScriptInput = {
  runId: string;
};

export type SaveWorkflowRunScriptOptions = {
  workflowRoot: string;
};

export type SavedWorkflowRunScript = {
  runId: string;
  name: string;
  path: string;
  sourcePath: string;
};

export async function saveWorkflowRunScript(
  input: SaveWorkflowRunScriptInput,
  options: SaveWorkflowRunScriptOptions,
): Promise<SavedWorkflowRunScript> {
  const paths = getWorkflowRunPaths(options.workflowRoot, input.runId);
  const script = await readWorkflowRunScript(paths.scriptPath, input.runId);
  const parsed = parseWorkflowScript(script);
  const savedPath = workflowCatalogForRoot(options.workflowRoot).savedScriptPath(parsed.meta.name);

  await mkdir(options.workflowRoot, { recursive: true });
  await writeFile(savedPath, script, "utf8");

  return {
    runId: input.runId,
    name: parsed.meta.name,
    path: savedPath,
    sourcePath: paths.scriptPath,
  };
}

export function savedWorkflowScriptPath(workflowRoot: string, name: string): string {
  assertSafeSavedWorkflowFileName(name);
  return join(workflowRoot, `${name}.js`);
}

async function readWorkflowRunScript(scriptPath: string, runId: string): Promise<string> {
  try {
    return await readFile(scriptPath, "utf8");
  } catch (error) {
    throw new Error(`workflow run script is unavailable: ${runId}: ${errorMessage(error)}`);
  }
}

function assertSafeSavedWorkflowFileName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\") ||
    basename(name) !== name
  ) {
    throw new Error(`unsafe saved workflow name: ${name}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
