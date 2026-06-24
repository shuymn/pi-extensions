import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../runtime/runtime";
import { extensionPackagedWorkflowRootDescriptors } from "../saved/packaged";
import { listSavedWorkflows, resolveSavedWorkflow } from "../saved/resolver";

type AgentCall = {
  prompt: string;
  label?: string;
  phase?: string;
  toolPolicy?: string;
  hasSchema: boolean;
};

const PACKAGED_ROOTS = extensionPackagedWorkflowRootDescriptors();

const BASE_PHASE_INSTRUCTIONS = {
  recon: "RECON",
  hunt: "HUNT",
  validate: "VALIDATE",
  gapfill: "GAPFILL",
  dedupe: "DEDUPE",
  trace: "TRACE",
  fix: "FIX",
  verify: "VERIFY",
  summary: "SUMMARY",
};

async function loadReviewFlow() {
  return await resolveSavedWorkflow(PACKAGED_ROOTS, "review_flow");
}

function makeAgent(calls: AgentCall[], options: { continueHunt: boolean }) {
  return (prompt: string, agentOptions: Record<string, unknown>) => {
    const label = typeof agentOptions.label === "string" ? agentOptions.label : "";
    calls.push({
      prompt,
      label,
      phase: agentOptions.phase as string | undefined,
      toolPolicy: agentOptions.toolPolicy as string | undefined,
      hasSchema: agentOptions.schema !== undefined,
    });
    if (label === "recon") return { riskAreas: ["auth", "io", "concurrency"], notes: "n" };
    if (label.startsWith("gapfill")) {
      return options.continueHunt
        ? { continueHunt: true, followUpHuntFocus: ["a", "b", "c"] }
        : { continueHunt: false, findings: [] };
    }
    if (label.startsWith("hunt")) return { findings: [{ path: "x" }], coverageGaps: [] };
    if (label.startsWith("validate")) return { findings: [{ path: "x" }] };
    if (label === "dedupe" || label === "trace") return { findings: [{ path: "x" }] };
    if (label === "fix") return { changes: [{ path: "x", summary: "s" }] };
    if (label === "verify") return { checks: [{ command: "test", result: "pass" }] };
    if (label === "summary") return { report: "report", findings: [], skipped: [] };
    return {};
  };
}

describe("packaged review_flow workflow", () => {
  test("is discoverable as an extension-packaged workflow with provenance", async () => {
    const workflows = await listSavedWorkflows(PACKAGED_ROOTS);
    const review = workflows.find((workflow) => workflow.name === "review_flow");
    expect(review).toMatchObject({
      name: "review_flow",
      fileName: "review-flow.js",
      source: "extension",
      phases: [
        { title: "Recon" },
        { title: "Hunt" },
        { title: "Validate" },
        { title: "Gapfill" },
        { title: "Dedupe" },
        { title: "Trace" },
        { title: "Fix" },
        { title: "Verify" },
        { title: "Summary" },
      ],
    });
  });

  test("normal mode: full phase order, parallel Hunt, read-only investigation, mutable Fix/Verify", async () => {
    const workflow = await loadReviewFlow();
    const calls: AgentCall[] = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: {
        runId: "rev1",
        noFix: false,
        phaseInstructions: BASE_PHASE_INSTRUCTIONS,
        targetList: '{"path":"src/a.ts"}',
        scopeGuidance: "scope guidance",
        globalRules: "global rules",
        diff: "## Combined diff\n+changed",
      },
      agent: makeAgent(calls, { continueHunt: false }),
    });

    expect(result.meta.name).toBe("review_flow");
    expect(result.phases).toEqual([
      "Recon",
      "Hunt",
      "Validate",
      "Gapfill",
      "Dedupe",
      "Trace",
      "Fix",
      "Verify",
      "Summary",
    ]);
    // recon + 3 hunt lenses + validate + gapfill + dedupe + trace + fix + verify + summary.
    expect(result.agentCount).toBe(11);

    // Hunt runs huntLensCount parallel lenses in one phase.
    const huntCalls = calls.filter((call) => call.phase === "Hunt");
    expect(huntCalls.map((call) => call.label)).toEqual([
      "hunt-lens-1",
      "hunt-lens-2",
      "hunt-lens-3",
    ]);

    // Investigation phases are read-only; Fix/Verify are mutable (no policy).
    const policyByLabel = new Map(calls.map((call) => [call.label, call.toolPolicy]));
    for (const label of [
      "recon",
      "hunt-lens-1",
      "validate",
      "gapfill",
      "dedupe",
      "trace",
      "summary",
    ]) {
      expect(policyByLabel.get(label)).toBe("readOnly");
    }
    expect(policyByLabel.get("fix")).toBeUndefined();
    expect(policyByLabel.get("verify")).toBeUndefined();
    expect(calls.every((call) => call.hasSchema)).toBe(true);

    expect(result.result).toMatchObject({ runId: "rev1", noFix: false, gapfillLoops: 0 });
  });

  test("no-fix mode: omits Fix/Verify and keeps every phase read-only", async () => {
    const workflow = await loadReviewFlow();
    const calls: AgentCall[] = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: {
        runId: "rev2",
        noFix: true,
        // Adapter omits fix/verify instructions under no-fix; the script skips them regardless.
        phaseInstructions: {
          recon: "RECON",
          hunt: "HUNT",
          validate: "VALIDATE",
          gapfill: "GAPFILL",
          dedupe: "DEDUPE",
          trace: "TRACE",
          summary: "SUMMARY",
        },
        targetList: '{"path":"src/a.ts"}',
        scopeGuidance: "scope guidance",
        globalRules: "global rules",
        diff: "",
      },
      agent: makeAgent(calls, { continueHunt: false }),
    });

    expect(result.phases).toEqual([
      "Recon",
      "Hunt",
      "Validate",
      "Gapfill",
      "Dedupe",
      "Trace",
      "Summary",
    ]);
    expect(calls.some((call) => call.label === "fix")).toBe(false);
    expect(calls.some((call) => call.label === "verify")).toBe(false);
    // Every scheduled agent is read-only in no-fix mode.
    expect(calls.every((call) => call.toolPolicy === "readOnly")).toBe(true);
    expect(result.result).toMatchObject({ noFix: true });
  });

  test("malformed noFix input fails closed and skips Fix/Verify", async () => {
    const workflow = await loadReviewFlow();
    const calls: AgentCall[] = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: {
        runId: "rev-malformed-nofix",
        noFix: "true",
        phaseInstructions: BASE_PHASE_INSTRUCTIONS,
        targetList: '{"path":"src/a.ts"}',
        scopeGuidance: "scope guidance",
        globalRules: "global rules",
        diff: "diff",
      },
      agent: makeAgent(calls, { continueHunt: false }),
    });

    expect(result.phases).toEqual([
      "Recon",
      "Hunt",
      "Validate",
      "Gapfill",
      "Dedupe",
      "Trace",
      "Summary",
    ]);
    expect(calls.some((call) => call.label === "fix")).toBe(false);
    expect(calls.some((call) => call.label === "verify")).toBe(false);
    expect(result.result).toMatchObject({ noFix: true });
  });

  test("Gapfill -> Hunt loop is bounded by maxGapfillLoops even when always requested", async () => {
    const workflow = await loadReviewFlow();
    const calls: AgentCall[] = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: {
        runId: "rev3",
        noFix: false,
        phaseInstructions: BASE_PHASE_INSTRUCTIONS,
        targetList: '{"path":"src/a.ts"}',
        scopeGuidance: "scope guidance",
        globalRules: "global rules",
        diff: "diff",
      },
      agent: makeAgent(calls, { continueHunt: true }),
    });

    // 3 Hunt passes (initial + 2 capped follow-ups), each with 3 lenses.
    const huntLabels = calls.filter((call) => call.phase === "Hunt").map((call) => call.label);
    expect(huntLabels).toEqual([
      "hunt-lens-1",
      "hunt-lens-2",
      "hunt-lens-3",
      "hunt-2-lens-1",
      "hunt-2-lens-2",
      "hunt-2-lens-3",
      "hunt-3-lens-1",
      "hunt-3-lens-2",
      "hunt-3-lens-3",
    ]);
    const gapfillLabels = calls
      .filter((call) => call.phase === "Gapfill")
      .map((call) => call.label);
    expect(gapfillLabels).toEqual(["gapfill", "gapfill-2", "gapfill-3"]);
    // recon + 9 hunt + 3 validate + 3 gapfill + dedupe + trace + fix + verify + summary.
    expect(result.agentCount).toBe(21);
    expect(result.result).toMatchObject({ gapfillLoops: 2 });
  });

  test("maxGapfillLoops=0 disables follow-up Hunt even when Gapfill requests it", async () => {
    const workflow = await loadReviewFlow();
    const calls: AgentCall[] = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: {
        runId: "rev-zero-gapfill",
        noFix: false,
        maxGapfillLoops: 0,
        phaseInstructions: BASE_PHASE_INSTRUCTIONS,
        targetList: '{"path":"src/a.ts"}',
        scopeGuidance: "scope guidance",
        globalRules: "global rules",
        diff: "diff",
      },
      agent: makeAgent(calls, { continueHunt: true }),
    });

    expect(calls.filter((call) => call.phase === "Hunt").map((call) => call.label)).toEqual([
      "hunt-lens-1",
      "hunt-lens-2",
      "hunt-lens-3",
    ]);
    expect(calls.filter((call) => call.phase === "Gapfill").map((call) => call.label)).toEqual([
      "gapfill",
    ]);
    expect(result.result).toMatchObject({ gapfillLoops: 0 });
  });
});
