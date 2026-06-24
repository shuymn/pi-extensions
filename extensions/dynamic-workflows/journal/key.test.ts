import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  createWorkflowAgentJournalKey,
  createWorkflowAgentJournalKeyPreimage,
  WORKFLOW_AGENT_JOURNAL_KEY_VERSION,
} from "./key";

const baseInput = {
  prompt: "Review auth",
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string" },
      score: { type: "number" },
    },
    required: ["verdict"],
  },
  label: "security",
  phase: "Review",
  agentType: "reviewer",
  cwd: "/repo",
};

describe("workflow agent journal key", () => {
  test("creates a stable versioned SHA-256 key from the effective agent call", () => {
    expect(createWorkflowAgentJournalKeyPreimage(baseInput)).toEqual({
      keyVersion: WORKFLOW_AGENT_JOURNAL_KEY_VERSION,
      prompt: "Review auth",
      schema: baseInput.schema,
      label: "security",
      phase: "Review",
      agentType: "reviewer",
      cwd: "/repo",
    });

    expect(createWorkflowAgentJournalKey(baseInput)).toBe(
      "v1:db3c85a9513adbd5af73c375faadbb2420b89b36b28d203cf347ad25c471f7df",
    );
  });

  test("canonicalizes object key order without changing array order", () => {
    const reordered = {
      cwd: "/repo",
      agentType: "reviewer",
      phase: "Review",
      label: "security",
      schema: {
        required: ["verdict"],
        properties: {
          score: { type: "number" },
          verdict: { type: "string" },
        },
        type: "object",
      },
      prompt: "Review auth",
    };

    expect(createWorkflowAgentJournalKey(reordered)).toBe(createWorkflowAgentJournalKey(baseInput));
    expect(
      createWorkflowAgentJournalKey({
        ...baseInput,
        schema: { ...baseInput.schema, required: ["score", "verdict"] },
      }),
    ).not.toBe(createWorkflowAgentJournalKey(baseInput));
  });

  test("changes when any effective key field changes", () => {
    const baseKey = createWorkflowAgentJournalKey(baseInput);
    const variants = [
      { prompt: "Review billing" },
      { schema: { type: "object", properties: { ok: { type: "boolean" } } } },
      { label: "correctness" },
      { phase: "Verify" },
      { agentType: "verifier" },
      { model: "openai/gpt-5:medium" },
      { cwd: "/other" },
    ];

    for (const variant of variants) {
      expect(createWorkflowAgentJournalKey({ ...baseInput, ...variant })).not.toBe(baseKey);
    }
  });

  test("records model selections", () => {
    const withModel = {
      ...baseInput,
      model: "openai/gpt-5:medium",
    };

    expect(createWorkflowAgentJournalKeyPreimage(withModel)).toMatchObject({
      model: "openai/gpt-5:medium",
    });
    expect(createWorkflowAgentJournalKey(withModel)).not.toBe(
      createWorkflowAgentJournalKey(baseInput),
    );
  });

  test("rejects non-canonical JSON inputs", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson({ cyclic })).toThrow("cyclic");
    const sparse = Array<string | undefined>(2);
    sparse[1] = "hole";

    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
    expect(() => canonicalJson({ value: undefined })).toThrow("undefined");
    expect(() => canonicalJson({ value: sparse })).toThrow("sparse");
    expect(() => canonicalJson({ value: () => undefined })).toThrow("function");
  });
});
