import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowAgentJournalKey } from "./key";
import type { WorkflowJournalAgentId, WorkflowJournalError, WorkflowJournalEvent } from "./model";

export type WorkflowJournalStoreOptions = {
  journalPath: string;
};

export class WorkflowJournalStore {
  readonly #journalPath: string;
  #pendingAppend = Promise.resolve();
  #dirEnsured = false;

  constructor(options: WorkflowJournalStoreOptions) {
    this.#journalPath = options.journalPath;
  }

  appendEvent(event: WorkflowJournalEvent): Promise<void> {
    let line: string;
    try {
      line = serializeJournalEvent(event);
    } catch (error) {
      return Promise.reject(error);
    }

    const nextAppend = this.#pendingAppend
      .catch(() => undefined)
      .then(async () => {
        await this.ensureDir();
        await appendLineAtomic(this.#journalPath, `${line}\n`);
      });
    this.#pendingAppend = nextAppend;
    return nextAppend;
  }

  async flush(): Promise<void> {
    await this.#pendingAppend;
  }

  appendStarted(key: WorkflowAgentJournalKey, agentId: WorkflowJournalAgentId): Promise<void> {
    return this.appendEvent({ type: "started", key, agentId });
  }

  appendResult(
    key: WorkflowAgentJournalKey,
    agentId: WorkflowJournalAgentId,
    result: unknown,
  ): Promise<void> {
    return this.appendEvent({ type: "result", key, agentId, result });
  }

  appendFailed(
    key: WorkflowAgentJournalKey,
    agentId: WorkflowJournalAgentId,
    error: WorkflowJournalError,
  ): Promise<void> {
    return this.appendEvent({ type: "failed", key, agentId, error });
  }

  appendStopped(
    key: WorkflowAgentJournalKey,
    agentId: WorkflowJournalAgentId,
    reason?: string,
  ): Promise<void> {
    return this.appendEvent({
      type: "stopped",
      key,
      agentId,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  appendInvalidated(
    key: WorkflowAgentJournalKey,
    previousAgentId: WorkflowJournalAgentId,
    input: { reason: "restart-agent"; at: number },
  ): Promise<void> {
    return this.appendEvent({
      type: "invalidated",
      key,
      previousAgentId,
      reason: input.reason,
      at: input.at,
    });
  }

  private async ensureDir(): Promise<void> {
    if (this.#dirEnsured) return;
    await mkdir(dirname(this.#journalPath), { recursive: true });
    this.#dirEnsured = true;
  }
}

async function appendLineAtomic(path: string, line: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const previous = await readFile(path, "utf8").catch((error: unknown) => {
    if (isFileNotFoundError(error)) return "";
    throw error;
  });

  try {
    await writeFile(tempPath, `${previous}${line}`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function serializeJournalEvent(event: WorkflowJournalEvent): string {
  validateJsonSerializable(event, "workflow journal event", new WeakSet<object>());
  const json = JSON.stringify(event);
  if (json === undefined) throw new Error("workflow journal event must be JSON-serializable.");
  return json;
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function validateJsonSerializable(value: unknown, label: string, seen: WeakSet<object>): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${label} must be JSON-serializable.`);
      }
      return;
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new Error(`${label} must be JSON-serializable.`);
    case "object":
      break;
  }

  if (seen.has(value)) throw new Error(`${label} must be JSON-serializable.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error(`${label} must be JSON-serializable.`);
        validateJsonSerializable(value[index], label, seen);
      }
      return;
    }

    for (const child of Object.values(value as Record<string, unknown>)) {
      validateJsonSerializable(child, label, seen);
    }
  } finally {
    seen.delete(value);
  }
}
