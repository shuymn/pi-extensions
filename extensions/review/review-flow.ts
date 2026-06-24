import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecGh, ExecGit } from "../../lib/command";
import type { Target } from "../../lib/git";
import type {
  WorkflowLaunchBridge,
  WorkflowLaunchResult,
} from "../dynamic-workflows/workflow-tool";
import { loadWorkflowPhases, type WorkflowPhase, type WorkflowPhaseFile } from "./phases";
import {
  buildAdditionalUserInstructions,
  buildGlobalRules,
  buildScopeInstruction,
  buildTargetList,
} from "./prompts";
import {
  type NoFixReason,
  type PreparedTargetScope,
  prepareTargetScope,
  type ReviewScope,
} from "./target-scope";
import { MAX_GAPFILL_LOOPS } from "./workflow";

/**
 * The packaged dynamic-workflow that exercises the review pipeline. The review
 * extension prepares safe structured args; the workflow runtime owns scheduling
 * and read-only enforcement.
 */
export const REVIEW_FLOW_WORKFLOW_NAME = "review_flow";

/** Number of parallel Hunt lenses per Hunt phase. */
export const REVIEW_FLOW_HUNT_LENS_COUNT = 3;

export type ReviewFlowPhaseInstructions = {
  recon: string;
  hunt: string;
  validate: string;
  gapfill: string;
  dedupe: string;
  trace: string;
  summary: string;
  fix?: string;
  verify?: string;
};

/**
 * Args handed to the `review_flow` workflow script. Prepared Target Scope
 * (`targets`, `diff`, `scope`, `noFixReason`) is passed through unchanged so the
 * workflow never collects git/gh scope itself; the rendered text fields reuse
 * the review extension's existing prompt/policy helpers.
 */
export type ReviewFlowArgs = {
  runId: string;
  noFix: boolean;
  maxGapfillLoops: number;
  huntLensCount: number;
  targets: Target[];
  diff: string;
  scope: ReviewScope;
  noFixReason?: NoFixReason;
  targetList: string;
  scopeGuidance: string;
  globalRules: string;
  additionalUserInstructions: string;
  phaseInstructions: ReviewFlowPhaseInstructions;
};

export type ReviewFlowScopeDeps = {
  execGit: ExecGit;
  execGh?: ExecGh;
  cwd: string;
};

export type ReviewFlowLaunchOptions = {
  runId: string;
  files?: string[];
  staged?: boolean;
  base?: string;
  pr?: string;
  noFix?: boolean;
  instructions?: string;
};

export type ReviewFlowPreparation =
  | { kind: "empty" }
  | { kind: "ready"; prepared: PreparedTargetScope; args: ReviewFlowArgs };

export type ReviewFlowLaunch =
  | { kind: "empty" }
  | { kind: "launched"; result: WorkflowLaunchResult; args: ReviewFlowArgs };

const FILE_TO_ROLE: Record<WorkflowPhaseFile, keyof ReviewFlowPhaseInstructions> = {
  "01-recon.md": "recon",
  "02-hunt.md": "hunt",
  "03-validate.md": "validate",
  "04-gapfill.md": "gapfill",
  "05-dedupe.md": "dedupe",
  "06-trace.md": "trace",
  "07-fix.md": "fix",
  "08-verify.md": "verify",
  "09-summary.md": "summary",
};

function buildPhaseInstructions(phases: WorkflowPhase[]): ReviewFlowPhaseInstructions {
  const instructions: Partial<Record<keyof ReviewFlowPhaseInstructions, string>> = {};
  for (const phase of phases) instructions[FILE_TO_ROLE[phase.file]] = phase.instructions;
  return instructions as ReviewFlowPhaseInstructions;
}

/**
 * Build `review_flow` args from a prepared Target Scope. A PR head mismatch or
 * dirty worktree (`prepared.noFixReason`) forces no-fix mode, mirroring the
 * authoritative `/review` automatic downgrade.
 */
export async function prepareReviewFlowArgs(
  prepared: PreparedTargetScope,
  options: { runId: string; noFix: boolean; instructions: string },
): Promise<ReviewFlowArgs> {
  const effectiveNoFix = options.noFix || Boolean(prepared.noFixReason);
  const phases = await loadWorkflowPhases(effectiveNoFix);

  return {
    runId: options.runId,
    noFix: effectiveNoFix,
    maxGapfillLoops: MAX_GAPFILL_LOOPS,
    huntLensCount: REVIEW_FLOW_HUNT_LENS_COUNT,
    targets: prepared.targets,
    diff: prepared.diff,
    scope: prepared.scope,
    ...(prepared.noFixReason ? { noFixReason: prepared.noFixReason } : {}),
    targetList: buildTargetList(prepared.targets),
    scopeGuidance: buildScopeInstruction(prepared.scope, prepared.noFixReason),
    globalRules: buildGlobalRules(effectiveNoFix),
    additionalUserInstructions: buildAdditionalUserInstructions(options.instructions),
    phaseInstructions: buildPhaseInstructions(phases),
  };
}

/**
 * Collect Target Scope with existing review helpers and build prepared
 * `review_flow` args. Returns `empty` when no review targets are found.
 */
export async function prepareReviewFlowLaunch(
  deps: ReviewFlowScopeDeps,
  options: ReviewFlowLaunchOptions,
): Promise<ReviewFlowPreparation> {
  const prepared = await prepareTargetScope({
    execGit: deps.execGit,
    execGh: deps.execGh,
    cwd: deps.cwd,
    files: options.files ?? [],
    staged: options.staged ?? false,
    base: options.base,
    pr: options.pr,
  });
  if (prepared.targets.length === 0) return { kind: "empty" };

  const args = await prepareReviewFlowArgs(prepared, {
    runId: options.runId,
    noFix: options.noFix ?? false,
    instructions: options.instructions?.trim() ?? "",
  });
  return { kind: "ready", prepared, args };
}

/**
 * Prepare Target Scope and launch `review_flow` through the dynamic-workflow
 * launch bridge. The bridge is injected so the live binding (built from
 * dynamic-workflow tool options) stays out of this module; this preset path is
 * additive and does not replace the authoritative `/review` command.
 */
export async function launchReviewFlow(
  bridge: WorkflowLaunchBridge,
  ctx: ExtensionContext,
  deps: ReviewFlowScopeDeps,
  options: ReviewFlowLaunchOptions,
  signal?: AbortSignal,
): Promise<ReviewFlowLaunch> {
  const preparation = await prepareReviewFlowLaunch(deps, options);
  if (preparation.kind === "empty") return { kind: "empty" };

  const result = await bridge(
    { name: REVIEW_FLOW_WORKFLOW_NAME, args: preparation.args },
    ctx,
    signal,
  );
  return { kind: "launched", result, args: preparation.args };
}
