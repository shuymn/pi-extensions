import { createHash } from "node:crypto";

export const WORKFLOW_AGENT_JOURNAL_KEY_VERSION = "v1";

export type WorkflowAgentJournalKey = `${typeof WORKFLOW_AGENT_JOURNAL_KEY_VERSION}:${string}`;

export type WorkflowAgentJournalKeyInput = {
  prompt: string;
  schema?: unknown;
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  toolPolicy?: string;
  allowedTools?: string[];
  cwd: string;
};

export type WorkflowAgentJournalKeyPreimage = {
  keyVersion: typeof WORKFLOW_AGENT_JOURNAL_KEY_VERSION;
  prompt: string;
  schema: unknown;
  label: string | null;
  phase: string | null;
  agentType: string | null;
  model?: string;
  toolPolicy?: string;
  allowedTools?: string[];
  cwd: string;
};

export function createWorkflowAgentJournalKey(
  input: WorkflowAgentJournalKeyInput,
): WorkflowAgentJournalKey {
  const canonical = canonicalJson(createWorkflowAgentJournalKeyPreimage(input));
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${WORKFLOW_AGENT_JOURNAL_KEY_VERSION}:${digest}`;
}

export function createWorkflowAgentJournalKeyPreimage(
  input: WorkflowAgentJournalKeyInput,
): WorkflowAgentJournalKeyPreimage {
  return {
    keyVersion: WORKFLOW_AGENT_JOURNAL_KEY_VERSION,
    prompt: input.prompt,
    schema: input.schema ?? null,
    label: normalizeOptionalString(input.label),
    phase: normalizeOptionalString(input.phase),
    agentType: normalizeOptionalString(input.agentType),
    ...(input.model === undefined ? {} : { model: input.model }),
    // Omit toolPolicy when unset so default-policy keys stay byte-identical to
    // pre-toolPolicy runs and existing replay caches remain valid.
    ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
    ...(input.allowedTools === undefined ? {} : { allowedTools: input.allowedTools }),
    cwd: input.cwd,
  };
}

export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, new WeakSet<object>());
}

function normalizeOptionalString(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function serializeCanonicalJson(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("journal key input must not contain non-finite numbers.");
      return JSON.stringify(value);
    case "undefined":
      throw new TypeError("journal key input must not contain undefined values.");
    case "bigint":
    case "function":
    case "symbol":
      throw new TypeError(`journal key input must not contain ${typeof value} values.`);
    case "object":
      break;
  }

  if (seen.has(value)) throw new TypeError("journal key input must not contain cyclic values.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError("journal key input must not contain sparse arrays.");
        }
        items.push(serializeCanonicalJson(value[index], seen));
      }
      return `[${items.join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const child = record[key];
        return `${JSON.stringify(key)}:${serializeCanonicalJson(child, seen)}`;
      });
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}
