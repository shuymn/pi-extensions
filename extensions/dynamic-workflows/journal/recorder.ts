import type { WorkflowAgentRuntimeEvent } from "../runtime/runtime";
import type { WorkflowAgentJournalKey } from "./key";
import type { WorkflowJournalAgentId } from "./model";
import { workflowJournalError } from "./model";
import type { WorkflowJournalStore } from "./store";

type ActiveJournalAgent = {
  key: WorkflowAgentJournalKey;
  agentId: WorkflowJournalAgentId;
};

export class WorkflowJournalRecorder {
  readonly #store: WorkflowJournalStore;
  readonly #active = new Map<WorkflowJournalAgentId, ActiveJournalAgent>();
  readonly #pendingRecords = new Set<Promise<void>>();
  #firstAppendError: unknown;

  constructor(store: WorkflowJournalStore) {
    this.#store = store;
  }

  started(event: WorkflowAgentRuntimeEvent): void {
    this.#active.set(event.journalAgentId, {
      key: event.journalKey,
      agentId: event.journalAgentId,
    });
    this.record(() => this.#store.appendStarted(event.journalKey, event.journalAgentId));
  }

  result(event: WorkflowAgentRuntimeEvent & { result: unknown }): void {
    this.#active.delete(event.journalAgentId);
    this.record(() =>
      this.#store.appendResult(event.journalKey, event.journalAgentId, event.result),
    );
  }

  failed(event: WorkflowAgentRuntimeEvent, error: unknown): void {
    this.#active.delete(event.journalAgentId);
    this.record(() =>
      this.#store.appendFailed(event.journalKey, event.journalAgentId, workflowJournalError(error)),
    );
  }

  stopped(event: WorkflowAgentRuntimeEvent, reason?: string): void {
    this.#active.delete(event.journalAgentId);
    this.record(() => this.#store.appendStopped(event.journalKey, event.journalAgentId, reason));
  }

  stoppedActive(reason?: string): void {
    const active = [...this.#active.values()];
    this.#active.clear();
    for (const agent of active) {
      this.record(() => this.#store.appendStopped(agent.key, agent.agentId, reason));
    }
  }

  failedActive(error: unknown): void {
    const active = [...this.#active.values()];
    this.#active.clear();
    const journalError = workflowJournalError(error);
    for (const agent of active) {
      this.record(() => this.#store.appendFailed(agent.key, agent.agentId, journalError));
    }
  }

  invalidated(
    key: WorkflowAgentJournalKey,
    previousAgentId: WorkflowJournalAgentId,
    input: { reason: "restart-agent"; at: number },
  ): void {
    this.record(() => this.#store.appendInvalidated(key, previousAgentId, input));
  }

  async flush(): Promise<void> {
    const pending = [...this.#pendingRecords];
    const storeFlush = this.#store.flush().catch((error: unknown) => {
      this.rememberAppendError(error);
    });
    await Promise.all([...pending, storeFlush]);
    const appendError = this.#firstAppendError;
    this.#firstAppendError = undefined;
    if (appendError !== undefined) throw appendError;
  }

  private record(append: () => Promise<void>): void {
    let pending: Promise<void>;
    try {
      pending = append();
    } catch (error) {
      this.rememberAppendError(error);
      return;
    }
    const observed = pending.catch((error: unknown) => {
      this.rememberAppendError(error);
    });
    this.#pendingRecords.add(observed);
    void observed.finally(() => this.#pendingRecords.delete(observed));
  }

  private rememberAppendError(error: unknown): void {
    this.#firstAppendError ??= error;
  }
}
