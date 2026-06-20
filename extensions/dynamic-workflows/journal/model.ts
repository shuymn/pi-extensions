import { randomBytes } from "node:crypto";
import type { WorkflowAgentJournalKey } from "./key";

export type WorkflowJournalAgentId = string;

export type WorkflowJournalError = {
  message: string;
  name?: string;
  stack?: string;
};

export type WorkflowJournalEvent =
  | {
      type: "started";
      key: WorkflowAgentJournalKey;
      agentId: WorkflowJournalAgentId;
    }
  | {
      type: "result";
      key: WorkflowAgentJournalKey;
      agentId: WorkflowJournalAgentId;
      result: unknown;
    }
  | {
      type: "failed";
      key: WorkflowAgentJournalKey;
      agentId: WorkflowJournalAgentId;
      error: WorkflowJournalError;
    }
  | {
      type: "stopped";
      key: WorkflowAgentJournalKey;
      agentId: WorkflowJournalAgentId;
      reason?: string;
    }
  | {
      type: "invalidated";
      key: WorkflowAgentJournalKey;
      previousAgentId: WorkflowJournalAgentId;
      reason: "restart-agent";
      at: number;
    };

export type WorkflowJournalAgentIdFactory = () => WorkflowJournalAgentId;

export function createWorkflowJournalAgentId(): WorkflowJournalAgentId {
  return randomBytes(8).toString("hex");
}

export function workflowJournalError(error: unknown): WorkflowJournalError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }

  return { message: String(error) };
}
