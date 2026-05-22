import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { WorkflowPhaseFile } from "./phases";

export const REVIEW_PHASE_ARTIFACT_TOOL_NAME = "review_phase_artifact";
export const REVIEW_PHASE_ARTIFACT_PATCH_TOOL_NAME = "review_phase_artifact_patch";

export const REVIEW_ARTIFACT_SUMMARY_MAX_CHARS = 4_000;
export const REVIEW_ARTIFACT_FALLBACK_MAX_CHARS = 4_000;
export const REVIEW_FINDING_CONFIDENCES = [
  "confirmed",
  "likely",
  "speculative",
  "false_positive",
] as const;

export const reviewFindingSchema = Type.Object({
  id: Type.String({
    description: "Stable finding ID unique within this phase.",
  }),
  file: Type.String({ description: "Relevant file path." }),
  issue: Type.String({ description: "Concise issue description." }),
  evidence: Type.String({
    description: "Concrete evidence checked in code/tests/output.",
  }),
  impact: Type.String({ description: "Why the issue matters." }),
  suggestedFix: Type.String({
    description: "Minimal suggested fix or skip rationale.",
  }),
  confidence: StringEnum(REVIEW_FINDING_CONFIDENCES, {
    description: "Finding confidence classification.",
  }),
});

export const reviewCoverageGapSchema = Type.Object({
  id: Type.String({
    description: "Stable coverage-gap ID unique within this phase.",
  }),
  area: Type.String({
    description: "Area, behavior, or file scope that still needs coverage.",
  }),
  reason: Type.String({ description: "Why this gap remains." }),
  evidenceToCheck: Type.Array(Type.String(), {
    description: "Concrete evidence, files, tests, callers, or assumptions to inspect.",
  }),
});

export const reviewTaskSchema = Type.Object({
  id: Type.String({ description: "Stable task ID unique within this phase." }),
  question: Type.String({
    description: "Specific review question to investigate.",
  }),
  scopeHint: Type.String({
    description: "Small file/function/module scope. Keep it narrow.",
  }),
  evidenceToCheck: Type.Array(Type.String(), {
    description: "Concrete code paths, tests, callers, or assumptions to inspect.",
  }),
  whyItMatters: Type.String({
    description: "Why this could change the fix/skip decision.",
  }),
});

export const reviewPhaseArtifactSchema = Type.Object({
  runId: Type.String({ description: "Current /review workflow run ID." }),
  phaseFile: Type.String({
    description: "Current phase markdown file, such as 02-hunt.md.",
  }),
  findings: Type.Array(reviewFindingSchema),
  coverageGaps: Type.Array(reviewCoverageGapSchema),
  nextTasks: Type.Array(reviewTaskSchema),
  summaryForNextPhase: Type.String({
    description: "Compact state summary for the next phase. Prefer under 4000 chars.",
  }),
});

export const reviewPhaseArtifactPatchSchema = Type.Object({
  runId: Type.String({ description: "Current /review workflow run ID." }),
  phaseFile: Type.String({ description: "Current phase markdown file." }),
  addFindings: Type.Optional(Type.Array(reviewFindingSchema)),
  replaceFindingsById: Type.Optional(Type.Array(reviewFindingSchema)),
  removeFindingIds: Type.Optional(Type.Array(Type.String())),
  addCoverageGaps: Type.Optional(Type.Array(reviewCoverageGapSchema)),
  replaceCoverageGapsById: Type.Optional(Type.Array(reviewCoverageGapSchema)),
  removeCoverageGapIds: Type.Optional(Type.Array(Type.String())),
  addNextTasks: Type.Optional(Type.Array(reviewTaskSchema)),
  replaceNextTasksById: Type.Optional(Type.Array(reviewTaskSchema)),
  removeNextTaskIds: Type.Optional(Type.Array(Type.String())),
  replaceSummaryForNextPhase: Type.Optional(Type.String()),
});

export type ReviewFinding = Static<typeof reviewFindingSchema>;
export type ReviewCoverageGap = Static<typeof reviewCoverageGapSchema>;
export type ReviewTask = Static<typeof reviewTaskSchema>;
export type ReviewPhaseArtifact = Static<typeof reviewPhaseArtifactSchema> & {
  phaseFile: WorkflowPhaseFile | string;
};
export type ReviewPhaseArtifactPatch = Static<typeof reviewPhaseArtifactPatchSchema> & {
  phaseFile: WorkflowPhaseFile | string;
};

export type ReviewArtifactWarningCode =
  | "missing_artifact"
  | "run_mismatch"
  | "phase_mismatch"
  | "missing_field"
  | "duplicate_id"
  | "invalid_patch"
  | "truncated"
  | "fallback_used";

export type ReviewArtifactWarning = {
  code: ReviewArtifactWarningCode;
  message: string;
};

export type PhaseArtifactStatus = {
  phaseIndex: number;
  phaseFile: string;
  artifact?: ReviewPhaseArtifact;
  fallbackNotes?: string;
  warnings: ReviewArtifactWarning[];
  patchCount: number;
};

export type PendingPhaseArtifactState = {
  artifact?: ReviewPhaseArtifact;
  patches: ReviewPhaseArtifactPatch[];
  warnings: ReviewArtifactWarning[];
};
