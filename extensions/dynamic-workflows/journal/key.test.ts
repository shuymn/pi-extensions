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
  model: "anthropic/claude",
  thinkingLevel: "high",
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
      model: "anthropic/claude",
      thinkingLevel: "high",
      isolation: null,
      cwd: "/repo",
    });

    expect(createWorkflowAgentJournalKey(baseInput)).toBe(
      "v1:8ac245df948d72f823d57055486a13fce4fffaf3b0815c283b4487241e38bc46",
    );
  });

  test("canonicalizes object key order without changing array order", () => {
    const reordered = {
      cwd: "/repo",
      thinkingLevel: "high",
      model: "anthropic/claude",
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
      { model: "openai/gpt-5" },
      { thinkingLevel: "medium" },
      { isolation: "worktree" as const },
      { cwd: "/other" },
    ];

    for (const variant of variants) {
      expect(createWorkflowAgentJournalKey({ ...baseInput, ...variant })).not.toBe(baseKey);
    }
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
