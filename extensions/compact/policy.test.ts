import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCompactWarningMessage,
  builtInAutoCompactThreshold,
  COMPACT_TOOL_NAME,
  DEFAULT_RESERVE_TOKENS,
  decideCompactWarning,
  finishCompactRequest,
  initialCompactRequestState,
  readCompactionReserveTokens,
  resolveReserveTokens,
  scheduleCompactRequest,
  takePendingCompactRequest,
} from "./policy";

describe("compact policy", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-compact-policy-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("resolves reserve tokens from effective settings with fallback for invalid values", () => {
    const globalPath = join(tempDir, "global.json");
    const projectPath = join(tempDir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ compaction: { reserveTokens: 12_000 } }));
    writeFileSync(projectPath, JSON.stringify({ other: true }));

    expect(readCompactionReserveTokens({ globalPath, projectPath })).toBe(12_000);

    writeFileSync(projectPath, JSON.stringify({ compaction: { reserveTokens: 32_768 } }));
    expect(readCompactionReserveTokens({ globalPath, projectPath })).toBe(32_768);

    writeFileSync(projectPath, JSON.stringify({ compaction: { reserveTokens: "invalid" } }));
    expect(readCompactionReserveTokens({ globalPath, projectPath })).toBe(12_000);

    writeFileSync(globalPath, JSON.stringify({ compaction: { reserveTokens: "invalid" } }));
    expect(readCompactionReserveTokens({ globalPath, projectPath })).toBe(DEFAULT_RESERVE_TOKENS);
    expect(resolveReserveTokens(undefined)).toBe(DEFAULT_RESERVE_TOKENS);
    expect(resolveReserveTokens(-1)).toBe(DEFAULT_RESERVE_TOKENS);
    expect(resolveReserveTokens(12_000.9)).toBe(12_000);
  });

  test("computes Pi built-in auto-compaction threshold from context window and reserve", () => {
    expect(builtInAutoCompactThreshold(200_000, 32_768)).toBe(167_232);
    expect(builtInAutoCompactThreshold(8_000, 16_384)).toBe(-8_384);
    expect(builtInAutoCompactThreshold(undefined, 16_384)).toBeUndefined();
  });

  test("warns only in the bounded window before Pi's built-in auto-compaction threshold", () => {
    const state = initialCompactRequestState();
    const base = { usage: { contextWindow: 200_000 }, reserveTokens: 32_768, state };

    expect(
      decideCompactWarning({ ...base, usage: { ...base.usage, tokens: 163_135 } }),
    ).toMatchObject({
      inject: false,
      reason: "not_near_threshold",
      warningThreshold: 163_136,
    });
    expect(
      decideCompactWarning({ ...base, usage: { ...base.usage, tokens: 163_136 } }),
    ).toMatchObject({
      inject: true,
      autoCompactThreshold: 167_232,
      warningThreshold: 163_136,
      warningMarginTokens: 4_096,
    });
    expect(
      decideCompactWarning({ ...base, usage: { ...base.usage, tokens: 167_231 } }),
    ).toMatchObject({
      inject: true,
    });
    expect(
      decideCompactWarning({ ...base, usage: { ...base.usage, tokens: 167_232 } }),
    ).toMatchObject({
      inject: false,
      reason: "auto_threshold_reached",
    });
  });

  test("clamps warning margin for small context windows", () => {
    const decision = decideCompactWarning({
      usage: { tokens: 6_300, contextWindow: 8_000 },
      reserveTokens: 1_024,
      state: initialCompactRequestState(),
    });

    expect(decision).toMatchObject({
      inject: true,
      autoCompactThreshold: 6_976,
      warningThreshold: 6_176,
      warningMarginTokens: 800,
    });
  });

  test("suppresses warnings when usage is unknown, invalid, pending, or compacting", () => {
    const usage = { tokens: 163_136, contextWindow: 200_000 };
    const state = initialCompactRequestState();
    const pending = scheduleCompactRequest(state, "Focus on current task");
    expect(pending.accepted).toBe(true);
    if (!pending.accepted) return;
    const taken = takePendingCompactRequest(pending.state);
    expect(taken.taken).toBe(true);
    if (!taken.taken) return;

    expect(decideCompactWarning({ usage: undefined, reserveTokens: 32_768, state })).toMatchObject({
      inject: false,
      reason: "unknown_usage",
    });
    expect(
      decideCompactWarning({
        usage: { tokens: null, contextWindow: 200_000 },
        reserveTokens: 32_768,
        state,
      }),
    ).toMatchObject({ inject: false, reason: "unknown_usage" });
    expect(
      decideCompactWarning({
        usage: { tokens: 1_000, contextWindow: 0 },
        reserveTokens: 32_768,
        state,
      }),
    ).toMatchObject({ inject: false, reason: "invalid_context_window" });
    expect(
      decideCompactWarning({
        usage: { tokens: 1_000, contextWindow: 8_000 },
        reserveTokens: 16_384,
        state,
      }),
    ).toMatchObject({ inject: false, reason: "no_safe_warning_window" });
    expect(
      decideCompactWarning({ usage, reserveTokens: 32_768, state: pending.state }),
    ).toMatchObject({ inject: false, reason: "pending" });
    expect(
      decideCompactWarning({ usage, reserveTokens: 32_768, state: taken.state }),
    ).toMatchObject({ inject: false, reason: "compacting" });
  });

  test("tracks pending and compacting state transitions without duplicate scheduling", () => {
    const idle = initialCompactRequestState();
    const scheduled = scheduleCompactRequest(idle, "  Focus on changed files.  ");

    expect(scheduled).toEqual({
      accepted: true,
      state: { phase: "pending", customInstructions: "Focus on changed files." },
    });
    if (!scheduled.accepted) return;

    expect(scheduleCompactRequest(scheduled.state)).toEqual({
      accepted: false,
      state: scheduled.state,
      reason: "pending",
    });

    const taken = takePendingCompactRequest(scheduled.state);
    expect(taken).toEqual({
      taken: true,
      state: { phase: "compacting" },
      customInstructions: "Focus on changed files.",
    });
    if (!taken.taken) return;

    expect(scheduleCompactRequest(taken.state)).toEqual({
      accepted: false,
      state: taken.state,
      reason: "compacting",
    });
    expect(takePendingCompactRequest(finishCompactRequest())).toEqual({
      taken: false,
      state: { phase: "idle" },
      reason: "not_pending",
    });
  });

  test("builds warning text that directs the model to the compact_context tool", () => {
    const warning = buildCompactWarningMessage();

    expect(warning).toContain(COMPACT_TOOL_NAME);
    expect(warning).toContain("Pi's built-in auto-compaction threshold is approaching");
    expect(warning).toContain("as the only tool");
  });
});
