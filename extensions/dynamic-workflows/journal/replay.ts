import { readFile } from "node:fs/promises";
import type { WorkflowAgentJournalKey } from "./key";
import type { WorkflowJournalAgentId, WorkflowJournalEvent } from "./model";

export type WorkflowReplayResult = {
  key: WorkflowAgentJournalKey;
  agentId: WorkflowJournalAgentId;
  result: unknown;
};

export type WorkflowReplayStartedOnly = {
  key: WorkflowAgentJournalKey;
  agentId: WorkflowJournalAgentId;
};

export type WorkflowReplayCache = {
  resultsByKey: Map<WorkflowAgentJournalKey, WorkflowReplayResult>;
  startedOnlyByAgentId: Map<WorkflowJournalAgentId, WorkflowReplayStartedOnly>;
  invalidatedAgentIds: Set<WorkflowJournalAgentId>;
};

export async function loadWorkflowReplayCache(journalPath: string): Promise<WorkflowReplayCache> {
  const events = await readWorkflowJournalEvents(journalPath);
  return buildWorkflowReplayCache(events);
}

export function buildWorkflowReplayCache(events: WorkflowJournalEvent[]): WorkflowReplayCache {
  const resultsByKey = new Map<WorkflowAgentJournalKey, WorkflowReplayResult>();
  const startedOnlyByAgentId = new Map<WorkflowJournalAgentId, WorkflowReplayStartedOnly>();
  const resultHistoryByKey = new Map<WorkflowAgentJournalKey, WorkflowReplayResult[]>();
  const invalidatedAgentIds = new Set<WorkflowJournalAgentId>();

  for (const event of events) {
    switch (event.type) {
      case "started": {
        startedOnlyByAgentId.set(event.agentId, { key: event.key, agentId: event.agentId });
        break;
      }
      case "result": {
        startedOnlyByAgentId.delete(event.agentId);
        const replayResult = {
          key: event.key,
          agentId: event.agentId,
          result: event.result,
        };
        rememberResult(resultHistoryByKey, replayResult);
        if (!invalidatedAgentIds.has(event.agentId)) {
          resultsByKey.set(event.key, replayResult);
        }
        break;
      }
      case "failed":
      case "stopped": {
        startedOnlyByAgentId.delete(event.agentId);
        break;
      }
      case "invalidated": {
        invalidatedAgentIds.add(event.previousAgentId);
        startedOnlyByAgentId.delete(event.previousAgentId);
        removeInvalidatedResult(resultsByKey, resultHistoryByKey, invalidatedAgentIds, event.key);
        break;
      }
    }
  }

  return { resultsByKey, startedOnlyByAgentId, invalidatedAgentIds };
}

async function readWorkflowJournalEvents(journalPath: string): Promise<WorkflowJournalEvent[]> {
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }

  const events: WorkflowJournalEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    try {
      events.push(parseWorkflowJournalEvent(JSON.parse(trimmedLine)));
    } catch {}
  }
  return events;
}

function parseWorkflowJournalEvent(value: unknown): WorkflowJournalEvent {
  if (!isRecord(value)) throw new Error("event must be an object");

  switch (value.type) {
    case "started":
      return {
        type: "started",
        key: requireJournalKey(value.key),
        agentId: requireString(value.agentId, "agentId"),
      };
    case "result":
      if (!("result" in value)) throw new Error("result event must include result");
      return {
        type: "result",
        key: requireJournalKey(value.key),
        agentId: requireString(value.agentId, "agentId"),
        result: value.result,
      };
    case "failed":
      return {
        type: "failed",
        key: requireJournalKey(value.key),
        agentId: requireString(value.agentId, "agentId"),
        error: requireJournalError(value.error),
      };
    case "stopped": {
      const reason = value.reason;
      return {
        type: "stopped",
        key: requireJournalKey(value.key),
        agentId: requireString(value.agentId, "agentId"),
        ...(reason === undefined ? {} : { reason: requireString(reason, "reason") }),
      };
    }
    case "invalidated":
      if (value.reason !== "restart-agent") {
        throw new Error("invalidated event reason must be restart-agent");
      }
      return {
        type: "invalidated",
        key: requireJournalKey(value.key),
        previousAgentId: requireString(value.previousAgentId, "previousAgentId"),
        reason: "restart-agent",
        at: requireFiniteNumber(value.at, "at"),
      };
    default:
      throw new Error("unknown workflow journal event type");
  }
}

function rememberResult(
  resultHistoryByKey: Map<WorkflowAgentJournalKey, WorkflowReplayResult[]>,
  result: WorkflowReplayResult,
): void {
  const results = resultHistoryByKey.get(result.key) ?? [];
  results.push(result);
  resultHistoryByKey.set(result.key, results);
}

function removeInvalidatedResult(
  resultsByKey: Map<WorkflowAgentJournalKey, WorkflowReplayResult>,
  resultHistoryByKey: Map<WorkflowAgentJournalKey, WorkflowReplayResult[]>,
  invalidatedAgentIds: Set<WorkflowJournalAgentId>,
  key: WorkflowAgentJournalKey,
): void {
  const active = resultsByKey.get(key);
  if (active && !invalidatedAgentIds.has(active.agentId)) return;

  const previousResults = resultHistoryByKey.get(key) ?? [];
  for (let index = previousResults.length - 1; index >= 0; index -= 1) {
    const candidate = previousResults[index];
    if (candidate && !invalidatedAgentIds.has(candidate.agentId)) {
      resultsByKey.set(key, candidate);
      return;
    }
  }
  resultsByKey.delete(key);
}

function requireJournalError(value: unknown): { message: string; name?: string; stack?: string } {
  if (!isRecord(value)) throw new Error("error must be an object");
  const message = requireString(value.message, "error.message");
  return {
    message,
    ...(value.name === undefined ? {} : { name: requireString(value.name, "error.name") }),
    ...(value.stack === undefined ? {} : { stack: requireString(value.stack, "error.stack") }),
  };
}

function requireJournalKey(value: unknown): WorkflowAgentJournalKey {
  const text = requireString(value, "key");
  if (!/^v1:[0-9a-f]{64}$/.test(text)) throw new Error("key must be a v1 journal key");
  return text as WorkflowAgentJournalKey;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
