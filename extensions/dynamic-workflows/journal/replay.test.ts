import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowAgentJournalKey } from "./key";
import { buildWorkflowReplayCache, loadWorkflowReplayCache } from "./replay";

const tempDirs: string[] = [];

function tempJournalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-replay-"));
  tempDirs.push(dir);
  return join(dir, "journal.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow journal replay cache", () => {
  test("loads an empty replay cache when the journal file does not exist", async () => {
    const cache = await loadWorkflowReplayCache(join(tempJournalPath(), "missing.jsonl"));

    expect(cache.resultsByKey.size).toBe(0);
    expect(cache.startedOnlyByAgentId.size).toBe(0);
    expect(cache.invalidatedAgentIds.size).toBe(0);
  });

  test("uses the latest non-invalidated result for each stable key", () => {
    const key = journalKey("1");
    const otherKey = journalKey("2");

    const cache = buildWorkflowReplayCache([
      { type: "started", key, agentId: "agent-1" },
      { type: "result", key, agentId: "agent-1", result: "first" },
      { type: "started", key, agentId: "agent-2" },
      { type: "result", key, agentId: "agent-2", result: "second" },
      { type: "started", key: otherKey, agentId: "agent-3" },
      { type: "result", key: otherKey, agentId: "agent-3", result: { ok: true } },
      { type: "invalidated", key, previousAgentId: "agent-2", reason: "restart-agent", at: 6 },
    ]);

    expect(cache.resultsByKey.get(key)).toEqual({ key, agentId: "agent-1", result: "first" });
    expect(cache.resultsByKey.get(otherKey)).toEqual({
      key: otherKey,
      agentId: "agent-3",
      result: { ok: true },
    });
    expect(cache.invalidatedAgentIds).toEqual(new Set(["agent-2"]));
  });

  test("tracks started-only agents as incomplete without hiding older completed results", () => {
    const key = journalKey("1");
    const cache = buildWorkflowReplayCache([
      { type: "started", key, agentId: "agent-1" },
      { type: "result", key, agentId: "agent-1", result: "done" },
      { type: "started", key, agentId: "agent-2" },
    ]);

    expect(cache.resultsByKey.get(key)).toEqual({ key, agentId: "agent-1", result: "done" });
    expect(cache.startedOnlyByAgentId.get("agent-2")).toEqual({ key, agentId: "agent-2" });
  });

  test("does not treat failed or stopped agents as cached or started-only", () => {
    const failedKey = journalKey("1");
    const stoppedKey = journalKey("2");
    const cache = buildWorkflowReplayCache([
      { type: "started", key: failedKey, agentId: "agent-1" },
      { type: "failed", key: failedKey, agentId: "agent-1", error: { message: "boom" } },
      { type: "started", key: stoppedKey, agentId: "agent-2" },
      { type: "stopped", key: stoppedKey, agentId: "agent-2", reason: "user stopped" },
    ]);

    expect(cache.resultsByKey.size).toBe(0);
    expect(cache.startedOnlyByAgentId.size).toBe(0);
  });

  test("loads JSONL from disk and skips malformed journal lines", async () => {
    const journalPath = tempJournalPath();
    const key = journalKey("1");
    writeFileSync(
      journalPath,
      `${[
        JSON.stringify({ type: "started", key, agentId: "agent-1" }),
        JSON.stringify({ type: "result", key, agentId: "agent-1", result: null }),
      ].join("\n")}\n`,
    );

    const cache = await loadWorkflowReplayCache(journalPath);
    expect(cache.resultsByKey.get(key)).toEqual({ key, agentId: "agent-1", result: null });

    writeFileSync(
      journalPath,
      `${[
        JSON.stringify({ type: "started", key, agentId: "agent-1" }),
        "{bad json}",
        JSON.stringify({ type: "result", key, agentId: "agent-1", result: "recovered" }),
      ].join("\n")}\n`,
    );
    const recoveredCache = await loadWorkflowReplayCache(journalPath);
    expect(recoveredCache.resultsByKey.get(key)).toEqual({
      key,
      agentId: "agent-1",
      result: "recovered",
    });
  });
});

function journalKey(suffix: string): WorkflowAgentJournalKey {
  return `v1:${suffix.padStart(64, "0")}` as WorkflowAgentJournalKey;
}
