import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowAgentJournalKey } from "./key";
import { WorkflowJournalStore } from "./store";

const tempDirs: string[] = [];

function tempJournalPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-journal-"));
  tempDirs.push(dir);
  return join(dir, ".pi", "workflows", "wf_journal_12345678", "journal.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow journal store", () => {
  test("appends JSONL events in call order and supports all event shapes", async () => {
    const journalPath = tempJournalPath();
    const store = new WorkflowJournalStore({ journalPath });
    const firstKey =
      "v1:1111111111111111111111111111111111111111111111111111111111111111" as WorkflowAgentJournalKey;
    const secondKey =
      "v1:2222222222222222222222222222222222222222222222222222222222222222" as WorkflowAgentJournalKey;

    await Promise.all([
      store.appendStarted(firstKey, "agent-1"),
      store.appendResult(firstKey, "agent-1", { ok: true }),
      store.appendStarted(secondKey, "agent-2"),
      store.appendFailed(secondKey, "agent-2", { message: "boom", name: "Error" }),
      store.appendStopped(secondKey, "agent-3", "user stopped"),
      store.appendInvalidated(firstKey, "agent-1", { reason: "restart-agent", at: 4 }),
    ]);
    await store.flush();

    expect(readJournalLines(journalPath)).toEqual([
      { type: "started", key: firstKey, agentId: "agent-1" },
      { type: "result", key: firstKey, agentId: "agent-1", result: { ok: true } },
      { type: "started", key: secondKey, agentId: "agent-2" },
      {
        type: "failed",
        key: secondKey,
        agentId: "agent-2",
        error: { message: "boom", name: "Error" },
      },
      { type: "stopped", key: secondKey, agentId: "agent-3", reason: "user stopped" },
      {
        type: "invalidated",
        key: firstKey,
        previousAgentId: "agent-1",
        reason: "restart-agent",
        at: 4,
      },
    ]);
  });

  test("rejects lossy result events because they are not JSONL-representable", async () => {
    const store = new WorkflowJournalStore({ journalPath: tempJournalPath() });
    const key =
      "v1:1111111111111111111111111111111111111111111111111111111111111111" as WorkflowAgentJournalKey;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array<string | undefined>(2);
    sparse[1] = "hole";

    for (const result of [
      undefined,
      { nested: undefined },
      { nested: () => undefined },
      { nested: Symbol("value") },
      { nested: Number.NaN },
      [undefined],
      sparse,
      cyclic,
    ]) {
      await expect(store.appendResult(key, "agent-1", result)).rejects.toThrow(
        "workflow journal event must be JSON-serializable",
      );
    }
  });
});

function readJournalLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
