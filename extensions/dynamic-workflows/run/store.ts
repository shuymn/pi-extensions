import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeWorkflowRunState, type WorkflowRunState } from "./model";

export type WorkflowRunPaths = {
  rootDir: string;
  runDir: string;
  manifestPath: string;
  scriptPath: string;
  outputPath: string;
  journalPath: string;
  transcriptsDir: string;
};

export type CreateWorkflowRunInput = {
  state: WorkflowRunState;
  script: string;
};

export class WorkflowRunStore {
  constructor(private readonly rootDir: string) {}

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunPaths> {
    const paths = getWorkflowRunPaths(this.rootDir, input.state.runId);
    await mkdir(this.rootDir, { recursive: true });
    try {
      await mkdir(paths.runDir);
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new Error(`workflow run already exists: ${input.state.runId}`);
      }
      throw error;
    }

    await writeFileAtomic(paths.scriptPath, input.script);
    await writeFileAtomic(paths.manifestPath, serializeWorkflowRunState(input.state));
    return paths;
  }

  async writeManifest(state: WorkflowRunState): Promise<string> {
    const paths = getWorkflowRunPaths(this.rootDir, state.runId);
    await mkdir(paths.runDir, { recursive: true });
    await writeFileAtomic(paths.manifestPath, serializeWorkflowRunState(state));
    return paths.manifestPath;
  }

  async writeOutput(runId: string, output: unknown): Promise<string> {
    const paths = getWorkflowRunPaths(this.rootDir, runId);
    await mkdir(paths.runDir, { recursive: true });
    await writeFileAtomic(paths.outputPath, serializeJson(output, "workflow output"));
    return paths.outputPath;
  }
}

export function getWorkflowRunPaths(rootDir: string, runId: string): WorkflowRunPaths {
  assertSafeRunId(runId);
  const runDir = join(rootDir, runId);
  return {
    rootDir,
    runDir,
    manifestPath: join(runDir, "manifest.json"),
    scriptPath: join(runDir, "script.js"),
    outputPath: join(runDir, "output.json"),
    journalPath: join(runDir, "journal.jsonl"),
    transcriptsDir: join(runDir, "transcripts"),
  };
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new Error(`unsafe workflow run id: ${runId}`);
  }
}

function serializeJson(value: unknown, label: string): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new Error(`${label} must be JSON-serializable.`);
  return `${json}\n`;
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
