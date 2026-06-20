import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowPromptReaderViewModel } from "./workflows-projection";
import { loadWorkflowPromptReaderViewModel } from "./workflows-prompt-reader-source";

const tempDirs: string[] = [];

function tempWorkflowRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-prompt-source-"));
  tempDirs.push(dir);
  return join(dir, ".pi", "workflows");
}

function fallback(): WorkflowPromptReaderViewModel {
  return {
    title: "risk scan",
    prompt: "manifest preview",
    source: "manifestPromptPreview",
    isFullPrompt: false,
  };
}

function writeTranscript(
  workflowRoot: string,
  runId: string,
  fileName: string,
  metadata: Record<string, unknown>,
): string {
  const transcriptsDir = join(workflowRoot, runId, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  const transcriptPath = join(transcriptsDir, fileName);
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ schemaVersion: 1, metadata, messages: [] }, null, 2)}\n`,
  );
  return transcriptPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow prompt reader source", () => {
  test("loads the full prompt from matching transcript metadata", async () => {
    const workflowRoot = tempWorkflowRoot();
    const runId = "wf_prompt_source_12345678";
    const transcriptPath = writeTranscript(workflowRoot, runId, "0002-risk-scan.json", {
      transcriptId: "0002-risk-scan",
      runId,
      prompt: "Full prompt\nwith all original instructions",
      sessionPrompt: "Session prompt wrapper",
    });

    const reader = await loadWorkflowPromptReaderViewModel({
      workflowRoot,
      runId,
      agentId: "agent_2",
      fallback: fallback(),
    });

    expect(reader).toEqual({
      title: "risk scan",
      prompt: "Full prompt\nwith all original instructions",
      source: "transcriptPrompt",
      isFullPrompt: true,
      transcriptPath,
    });
  });

  test("falls back to sessionPrompt when prompt is absent", async () => {
    const workflowRoot = tempWorkflowRoot();
    const runId = "wf_prompt_source_12345678";
    const transcriptPath = writeTranscript(workflowRoot, runId, "0001.json", {
      transcriptId: "0001",
      runId,
      sessionPrompt: "Session prompt only",
    });

    const reader = await loadWorkflowPromptReaderViewModel({
      workflowRoot,
      runId,
      agentId: "agent_1",
      fallback: fallback(),
    });

    expect(reader).toMatchObject({
      prompt: "Session prompt only",
      source: "transcriptSessionPrompt",
      isFullPrompt: true,
      transcriptPath,
    });
  });

  test("returns the manifest preview fallback when no transcript is available", async () => {
    const fallbackReader = fallback();

    await expect(
      loadWorkflowPromptReaderViewModel({
        workflowRoot: tempWorkflowRoot(),
        runId: "wf_missing_12345678",
        agentId: "agent_1",
        fallback: fallbackReader,
      }),
    ).resolves.toBe(fallbackReader);
  });
});
