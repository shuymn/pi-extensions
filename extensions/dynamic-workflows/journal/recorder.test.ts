import { describe, expect, test } from "bun:test";
import type { WorkflowAgentRuntimeEvent } from "../runtime/runtime";
import { WorkflowJournalRecorder } from "./recorder";
import type { WorkflowJournalStore } from "./store";

function event(): WorkflowAgentRuntimeEvent {
  return {
    runAgentId: "agent-1",
    label: "inspect",
    prompt: "inspect src",
    journalKey: "v1:1111111111111111111111111111111111111111111111111111111111111111",
    journalAgentId: "journal-agent-1",
  };
}

describe("workflow journal recorder", () => {
  test("clears remembered append errors after reporting them once", async () => {
    let failNext = true;
    const store = {
      appendStarted: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("append failed");
        }
      },
      flush: async () => {},
    } as unknown as WorkflowJournalStore;
    const recorder = new WorkflowJournalRecorder(store);

    recorder.started(event());
    await expect(recorder.flush()).rejects.toThrow("append failed");

    recorder.started({ ...event(), runAgentId: "agent-2", journalAgentId: "journal-agent-2" });
    await expect(recorder.flush()).resolves.toBeUndefined();
  });
});
