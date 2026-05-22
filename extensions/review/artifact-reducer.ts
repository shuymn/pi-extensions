import {
  REVIEW_FINDING_CONFIDENCES,
  REVIEW_ARTIFACT_SUMMARY_MAX_CHARS,
  type PendingPhaseArtifactState,
  type PhaseArtifactStatus,
  type ReviewArtifactWarning,
  type ReviewArtifactWarningCode,
  type ReviewPhaseArtifact,
  type ReviewPhaseArtifactPatch,
} from "./artifacts";

const FATAL_ARTIFACT_WARNING_CODES = new Set<ReviewArtifactWarningCode>([
  "missing_artifact",
  "run_mismatch",
  "phase_mismatch",
  "missing_field",
  "duplicate_id",
]);

function truncateArtifactText(
  text: string,
  maxChars: number,
): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n[truncated]`, truncated: true };
}

function warning(code: ReviewArtifactWarningCode, message: string): ReviewArtifactWarning {
  return { code, message };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasFatalArtifactWarning(warnings: ReviewArtifactWarning[]): boolean {
  return warnings.some((item) => FATAL_ARTIFACT_WARNING_CODES.has(item.code));
}

function validateIdList<T extends { id: string }>(
  label: string,
  items: T[],
): ReviewArtifactWarning[] {
  const warnings: ReviewArtifactWarning[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!hasText(item.id)) {
      warnings.push(warning("missing_field", `${label} item is missing id.`));
      continue;
    }
    if (seen.has(item.id)) {
      warnings.push(warning("duplicate_id", `${label} has duplicate id: ${item.id}`));
    }
    seen.add(item.id);
  }
  return warnings;
}

function validateFindingFields(finding: unknown, label: string): ReviewArtifactWarning[] {
  const warnings: ReviewArtifactWarning[] = [];
  if (!isRecord(finding)) {
    return [warning("missing_field", `${label} item must be an object.`)];
  }
  for (const field of ["id", "file", "issue", "evidence", "impact", "suggestedFix"]) {
    if (!hasText(finding[field])) {
      warnings.push(warning("missing_field", `${label} item is missing ${field}.`));
    }
  }
  if (
    typeof finding.confidence !== "string" ||
    !(REVIEW_FINDING_CONFIDENCES as readonly string[]).includes(finding.confidence)
  ) {
    warnings.push(warning("missing_field", `${label} item has invalid confidence.`));
  }
  return warnings;
}

function validateCoverageGapFields(gap: unknown, label: string): ReviewArtifactWarning[] {
  const warnings: ReviewArtifactWarning[] = [];
  if (!isRecord(gap)) {
    return [warning("missing_field", `${label} item must be an object.`)];
  }
  for (const field of ["id", "area", "reason"]) {
    if (!hasText(gap[field])) {
      warnings.push(warning("missing_field", `${label} item is missing ${field}.`));
    }
  }
  if (!hasStringArray(gap.evidenceToCheck)) {
    warnings.push(
      warning("missing_field", `${label} item evidenceToCheck must be an array of strings.`),
    );
  }
  return warnings;
}

function validateTaskFields(task: unknown, label: string): ReviewArtifactWarning[] {
  const warnings: ReviewArtifactWarning[] = [];
  if (!isRecord(task)) {
    return [warning("missing_field", `${label} item must be an object.`)];
  }
  for (const field of ["id", "question", "scopeHint", "whyItMatters"]) {
    if (!hasText(task[field])) {
      warnings.push(warning("missing_field", `${label} item is missing ${field}.`));
    }
  }
  if (!hasStringArray(task.evidenceToCheck)) {
    warnings.push(
      warning("missing_field", `${label} item evidenceToCheck must be an array of strings.`),
    );
  }
  return warnings;
}

function validateReviewPhaseArtifact(
  artifact: ReviewPhaseArtifact | undefined,
  expected: { runId: string; phaseFile: string },
): ReviewArtifactWarning[] {
  if (!artifact)
    return [warning("missing_artifact", "No structured review artifact was submitted.")];

  const warnings: ReviewArtifactWarning[] = [];
  if (artifact.runId !== expected.runId) {
    warnings.push(
      warning(
        "run_mismatch",
        `Artifact runId ${artifact.runId} does not match active run ${expected.runId}.`,
      ),
    );
  }
  if (artifact.phaseFile !== expected.phaseFile) {
    warnings.push(
      warning(
        "phase_mismatch",
        `Artifact phaseFile ${artifact.phaseFile} does not match active phase ${expected.phaseFile}.`,
      ),
    );
  }
  if (!Array.isArray(artifact.findings))
    warnings.push(warning("missing_field", "Artifact findings must be an array."));
  if (!Array.isArray(artifact.coverageGaps))
    warnings.push(warning("missing_field", "Artifact coverageGaps must be an array."));
  if (!Array.isArray(artifact.nextTasks))
    warnings.push(warning("missing_field", "Artifact nextTasks must be an array."));
  if (!hasText(artifact.summaryForNextPhase))
    warnings.push(warning("missing_field", "Artifact summaryForNextPhase must be non-empty."));

  if (Array.isArray(artifact.findings)) {
    warnings.push(...validateIdList("findings", artifact.findings));
    for (const finding of artifact.findings) {
      warnings.push(...validateFindingFields(finding, "findings"));
    }
  }
  if (Array.isArray(artifact.coverageGaps)) {
    warnings.push(...validateIdList("coverageGaps", artifact.coverageGaps));
    for (const gap of artifact.coverageGaps) {
      warnings.push(...validateCoverageGapFields(gap, "coverageGaps"));
    }
  }
  if (Array.isArray(artifact.nextTasks)) {
    warnings.push(...validateIdList("nextTasks", artifact.nextTasks));
    for (const task of artifact.nextTasks) {
      warnings.push(...validateTaskFields(task, "nextTasks"));
    }
  }

  return warnings;
}

function upsertById<T extends { id: string }>(items: T[], replacements: T[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const replacement of replacements) byId.set(replacement.id, replacement);
  return [...byId.values()];
}

function removeById<T extends { id: string }>(items: T[], ids: string[] | undefined): T[] {
  if (!ids?.length) return items;
  const remove = new Set(ids);
  return items.filter((item) => !remove.has(item.id));
}

function validatePatchTargets<T extends { id: string }>(
  label: string,
  existing: T[],
  replacements: T[] | undefined,
  removals: string[] | undefined,
): ReviewArtifactWarning[] {
  const warnings: ReviewArtifactWarning[] = [];
  const existingIds = new Set(existing.map((item) => item.id));
  for (const item of replacements ?? []) {
    if (!existingIds.has(item.id)) {
      warnings.push(
        warning("invalid_patch", `${label} replacement id does not exist yet: ${item.id}`),
      );
    }
  }
  for (const id of removals ?? []) {
    if (!existingIds.has(id)) {
      warnings.push(warning("invalid_patch", `${label} removal id does not exist: ${id}`));
    }
  }
  return warnings;
}

function existingReplacements<T extends { id: string }>(
  existing: T[],
  replacements: T[] | undefined,
): T[] {
  if (!replacements?.length) return [];
  const existingIds = new Set(existing.map((item) => item.id));
  return replacements.filter((item) => existingIds.has(item.id));
}

function existingRemovalIds<T extends { id: string }>(
  existing: T[],
  ids: string[] | undefined,
): string[] | undefined {
  if (!ids?.length) return undefined;
  const existingIds = new Set(existing.map((item) => item.id));
  return ids.filter((id) => existingIds.has(id));
}

function applyArtifactItemPatch<T extends { id: string }>(
  label: string,
  existing: T[],
  patch: {
    additions?: T[];
    replacements?: T[];
    removals?: string[];
  },
): { items: T[]; warnings: ReviewArtifactWarning[] } {
  const warnings = validatePatchTargets(label, existing, patch.replacements, patch.removals);
  const items = upsertById(removeById(existing, existingRemovalIds(existing, patch.removals)), [
    ...existingReplacements(existing, patch.replacements),
    ...(patch.additions ?? []),
  ]);
  return { items, warnings };
}

function applyReviewPhaseArtifactPatch(
  artifact: ReviewPhaseArtifact,
  patch: ReviewPhaseArtifactPatch,
): { artifact: ReviewPhaseArtifact; warnings: ReviewArtifactWarning[] } {
  const warnings: ReviewArtifactWarning[] = [];
  if (patch.runId !== artifact.runId)
    warnings.push(
      warning(
        "run_mismatch",
        `Patch runId ${patch.runId} does not match artifact run ${artifact.runId}.`,
      ),
    );
  if (patch.phaseFile !== artifact.phaseFile)
    warnings.push(
      warning(
        "phase_mismatch",
        `Patch phaseFile ${patch.phaseFile} does not match artifact phase ${artifact.phaseFile}.`,
      ),
    );
  if (warnings.some((item) => item.code === "run_mismatch" || item.code === "phase_mismatch")) {
    return { artifact, warnings };
  }

  const findings = applyArtifactItemPatch("findings", artifact.findings, {
    additions: patch.addFindings,
    replacements: patch.replaceFindingsById,
    removals: patch.removeFindingIds,
  });
  const coverageGaps = applyArtifactItemPatch("coverageGaps", artifact.coverageGaps, {
    additions: patch.addCoverageGaps,
    replacements: patch.replaceCoverageGapsById,
    removals: patch.removeCoverageGapIds,
  });
  const nextTasks = applyArtifactItemPatch("nextTasks", artifact.nextTasks, {
    additions: patch.addNextTasks,
    replacements: patch.replaceNextTasksById,
    removals: patch.removeNextTaskIds,
  });
  warnings.push(...findings.warnings, ...coverageGaps.warnings, ...nextTasks.warnings);

  const nextArtifact: ReviewPhaseArtifact = {
    ...artifact,
    findings: findings.items,
    coverageGaps: coverageGaps.items,
    nextTasks: nextTasks.items,
    summaryForNextPhase: patch.replaceSummaryForNextPhase ?? artifact.summaryForNextPhase,
  };

  return { artifact: nextArtifact, warnings };
}

export function finalizeReviewPhaseArtifact(input: {
  runId: string;
  phaseIndex: number;
  phaseFile: string;
  pending: PendingPhaseArtifactState | undefined;
  latestAssistantText?: string;
  truncateFallback: (text: string) => string;
}): PhaseArtifactStatus {
  const warnings = [...(input.pending?.warnings ?? [])];
  let artifact = input.pending?.artifact;
  let patchCount = 0;
  const patches = input.pending?.patches ?? [];
  const expected = { runId: input.runId, phaseFile: input.phaseFile };
  const baseWarnings = validateReviewPhaseArtifact(artifact, expected);
  warnings.push(...baseWarnings);

  if (hasFatalArtifactWarning(baseWarnings)) {
    if (patches.length) {
      warnings.push(
        warning(
          "invalid_patch",
          "Patch was submitted for a missing or invalid artifact; patch ignored.",
        ),
      );
    }
  } else if (artifact) {
    for (const patch of patches) {
      const result = applyReviewPhaseArtifactPatch(artifact, patch);
      artifact = result.artifact;
      patchCount += 1;
      warnings.push(...result.warnings);
    }

    if (patches.length) {
      warnings.push(...validateReviewPhaseArtifact(artifact, expected));
    }
  }

  let fallbackNotes: string | undefined;
  const hasFatalWarning = hasFatalArtifactWarning(warnings);
  if (hasFatalWarning) {
    fallbackNotes = input.truncateFallback(input.latestAssistantText ?? "");
    warnings.push(
      warning(
        "fallback_used",
        "Structured artifact was missing or invalid; compact assistant text fallback was stored.",
      ),
    );
  }

  if (artifact && artifact.summaryForNextPhase.length > REVIEW_ARTIFACT_SUMMARY_MAX_CHARS) {
    const truncated = truncateArtifactText(
      artifact.summaryForNextPhase,
      REVIEW_ARTIFACT_SUMMARY_MAX_CHARS,
    );
    artifact = { ...artifact, summaryForNextPhase: truncated.text };
    if (truncated.truncated)
      warnings.push(
        warning("truncated", "summaryForNextPhase exceeded the limit and was truncated."),
      );
  }

  return {
    phaseIndex: input.phaseIndex,
    phaseFile: input.phaseFile,
    artifact: hasFatalWarning ? undefined : artifact,
    fallbackNotes,
    warnings,
    patchCount,
  };
}

export function hasMaterialNextTasks(status: PhaseArtifactStatus | undefined): boolean {
  return Boolean(status?.artifact?.nextTasks?.length);
}
