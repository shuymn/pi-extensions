import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getWorkflowRunPaths } from "../run/store";
import type {
  WorkflowPromptReaderSource,
  WorkflowPromptReaderViewModel,
} from "./workflows-projection";

export type LoadWorkflowPromptReaderInput = {
  workflowRoot: string;
  runId: string;
  agentId: string;
  fallback: WorkflowPromptReaderViewModel;
};

export async function loadWorkflowPromptReaderViewModel(
  input: LoadWorkflowPromptReaderInput,
): Promise<WorkflowPromptReaderViewModel> {
  const prompt = await readWorkflowAgentPrompt(
    input.workflowRoot,
    input.runId,
    input.agentId,
  ).catch(() => undefined);
  if (prompt === undefined) return input.fallback;
  return {
    ...input.fallback,
    prompt: prompt.prompt,
    source: prompt.source,
    isFullPrompt: true,
    transcriptPath: prompt.transcriptPath,
  };
}

type LoadedWorkflowAgentPrompt = {
  prompt: string;
  source: WorkflowPromptReaderSource;
  transcriptPath: string;
};

async function readWorkflowAgentPrompt(
  workflowRoot: string,
  runId: string,
  agentId: string,
): Promise<LoadedWorkflowAgentPrompt | undefined> {
  const transcriptPrefix = agentIdToTranscriptPrefix(agentId);
  if (transcriptPrefix === undefined) return undefined;

  const paths = getWorkflowRunPaths(workflowRoot, runId);
  const transcriptPaths = await listCandidateTranscriptPaths(
    paths.transcriptsDir,
    transcriptPrefix,
  );
  for (const transcriptPath of transcriptPaths) {
    const prompt = await readPromptFromTranscript(transcriptPath, runId, transcriptPrefix).catch(
      () => undefined,
    );
    if (prompt !== undefined) return prompt;
  }
  return undefined;
}

async function listCandidateTranscriptPaths(
  transcriptsDir: string,
  transcriptPrefix: string,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(transcriptsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name === `${transcriptPrefix}.json` ||
        (name.startsWith(`${transcriptPrefix}-`) && name.endsWith(".json")),
    )
    .sort(compareTranscriptNames)
    .map((name) => join(transcriptsDir, name));
}

async function readPromptFromTranscript(
  transcriptPath: string,
  runId: string,
  transcriptPrefix: string,
): Promise<LoadedWorkflowAgentPrompt | undefined> {
  const value = JSON.parse(await readFile(transcriptPath, "utf8"));
  if (!isRecord(value) || !isRecord(value.metadata)) return undefined;
  const metadata = value.metadata;
  if (metadata.runId !== runId) return undefined;
  if (
    typeof metadata.transcriptId === "string" &&
    !isTranscriptIdMatch(metadata.transcriptId, transcriptPrefix)
  ) {
    return undefined;
  }

  if (typeof metadata.prompt === "string") {
    return { prompt: metadata.prompt, source: "transcriptPrompt", transcriptPath };
  }
  if (typeof metadata.sessionPrompt === "string") {
    return { prompt: metadata.sessionPrompt, source: "transcriptSessionPrompt", transcriptPath };
  }
  return undefined;
}

function agentIdToTranscriptPrefix(agentId: string): string | undefined {
  const match = agentId.match(/^agent_(\d+)$/);
  const rawIndex = match?.[1];
  if (rawIndex === undefined) return undefined;
  const index = Number.parseInt(rawIndex, 10);
  if (!Number.isSafeInteger(index) || index < 1) return undefined;
  return String(index).padStart(4, "0");
}

function compareTranscriptNames(left: string, right: string): number {
  const leftExact = exactTranscriptNameRank(left);
  const rightExact = exactTranscriptNameRank(right);
  if (leftExact !== rightExact) return leftExact - rightExact;
  return left.localeCompare(right);
}

function exactTranscriptNameRank(name: string): number {
  return /^\d{4}\.json$/.test(basename(name)) ? 0 : 1;
}

function isTranscriptIdMatch(transcriptId: string, transcriptPrefix: string): boolean {
  return transcriptId === transcriptPrefix || transcriptId.startsWith(`${transcriptPrefix}-`);
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
