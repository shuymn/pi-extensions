import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TSchema, Type } from "typebox";
import type { CommandResult } from "../../lib/command";

const text = () => Type.String({ minLength: 1, maxLength: 20_000, pattern: "\\S" });
const texts = () => Type.Array(text(), { maxItems: 600 });

export const ReviewScopeSchema = Type.Object(
  {
    mode: StringEnum(["files", "pr", "base", "staged", "working"]),
    files: Type.Optional(Type.Array(text(), { minItems: 1, maxItems: 500 })),
    pr: Type.Optional(text()),
    base: Type.Optional(text()),
  },
  { additionalProperties: false },
);
export type ReviewScope = Static<typeof ReviewScopeSchema>;

export const ReviewInspectSchema = Type.Object(
  {
    scope: Type.Optional(ReviewScopeSchema),
    focus: Type.Optional(Type.Array(text(), { maxItems: 100 })),
    concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    maxFollowups: Type.Optional(Type.Integer({ minimum: 0, maximum: 2 })),
    noFix: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type ReviewInspectParams = Static<typeof ReviewInspectSchema>;

export const ReviewFindingSchema = Type.Object(
  { path: text(), issue: text(), evidence: text(), impact: text(), suggestedFix: text() },
  { additionalProperties: false },
);
export type ReviewFinding = Static<typeof ReviewFindingSchema>;
export type ReviewCandidate = ReviewFinding & { id: string };

// Inspectors and validators have no execution tools. These receipts cannot claim
// runtime success/failure, and are separate from missing static review coverage.
const unrunChecksSchema = Type.Array(
  Type.Object(
    {
      description: text(),
      outcome: Type.Literal("not_run"),
      evidence: text(),
    },
    { additionalProperties: false },
  ),
  {
    minItems: 1,
    maxItems: 100,
    description:
      "Runtime verification not executed by this read-only child, such as tests, typecheck, lint, or live probes. State the limitation; static inspection is not an executed check.",
  },
);

export const ReviewInspectionSchema = Type.Object(
  {
    reviewedFocus: texts(),
    coverageGaps: Type.Array(text(), {
      maxItems: 600,
      description:
        "Unexamined static-review scope, such as unreadable files or missing diffs. Unexecuted runtime verification belongs in checks.",
    }),
    findings: Type.Array(ReviewFindingSchema, { maxItems: 100 }),
    checks: unrunChecksSchema,
  },
  { additionalProperties: false },
);
export type ReviewInspection = Static<typeof ReviewInspectionSchema>;

export const ReviewValidationSchema = Type.Object(
  {
    decisions: Type.Array(
      Type.Object(
        {
          findingId: text(),
          verdict: StringEnum(["keep", "drop"]),
          evidence: text(),
          reason: text(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 1500 },
    ),
    followUpFocus: Type.Array(text(), {
      maxItems: 100,
      description:
        "Material static-review blind spots needing another inspection pass. Unexecuted runtime verification belongs in checks.",
    }),
    checks: unrunChecksSchema,
  },
  { additionalProperties: false },
);
export type ReviewValidation = Static<typeof ReviewValidationSchema>;

export const ReviewFixSchema = Type.Object(
  {
    blockers: Type.Array(
      Type.Object(
        {
          kind: StringEnum(["scope", "input", "environment", "external"]),
          reason: text(),
          nextAction: text(),
        },
        { additionalProperties: false },
      ),
      {
        maxItems: 100,
        description:
          "Required unavailable scope, input, access, or external change. Recoverable in-scope check failures are work to continue, not blockers.",
      },
    ),
    changes: Type.Array(
      Type.Object({ path: text(), summary: text() }, { additionalProperties: false }),
      { maxItems: 500 },
    ),
    checks: Type.Array(
      Type.Object(
        {
          description: text(),
          outcome: StringEnum(["passed", "failed", "not_run"]),
          evidence: text(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
export type ReviewFix = Static<typeof ReviewFixSchema>;

/** The host must enforce these tool restrictions, including read-only execution. */
export type ReviewAgentRequest = {
  label: string;
  prompt: string;
  /** The host must append this artifact recovery reference to the child's system prompt. */
  recoveryContext?: string;
  readOnly: boolean;
  allowedTools: string[];
  schema: TSchema;
  signal?: AbortSignal;
};

/** Runner completion is a host receipt, not a status parsed from model prose. */
export type ReviewAgentResult = {
  status: "completed" | "failed" | "aborted";
  output?: unknown;
  error?: string;
};
export type ReviewRunner = (request: ReviewAgentRequest) => Promise<ReviewAgentResult>;
export type ReviewExec = (
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeout: number },
) => Promise<CommandResult>;

export type ReviewPreparedScope = {
  scope: ReviewScope;
  targetFiles: string[];
  diff: string;
  fingerprint: string;
  prHeadOid?: string;
  prCheckoutMatches?: boolean;
};

export type ReviewReceipt<T> = {
  label: string;
  status: "pending" | "completed" | "failed" | "aborted";
  output?: T;
  error?: string;
};
export type ReviewCoverage = {
  pass: number;
  bucket: number;
  focus: string[];
  receipt: ReviewReceipt<ReviewInspection>;
};

export type ReviewRun = {
  runId: string;
  status: "inspecting" | "ready" | "partial" | "aborted" | "fixing" | "fixed" | "fix_failed";
  scope: ReviewScope;
  targetFiles: string[];
  /** Inspection-only or blocked by static review/safety issues; readiness is not test success. */
  noFix: boolean;
  issues: string[];
  coverage: ReviewCoverage[];
  candidates: ReviewCandidate[];
  findings: ReviewCandidate[];
  validations: ReviewReceipt<ReviewValidation>[];
  fix?: ReviewReceipt<ReviewFix>;
};

const candidateSchema = Type.Object(
  { id: text(), ...ReviewFindingSchema.properties },
  { additionalProperties: false },
);

function receiptSchema<T extends TSchema>(output: T) {
  return Type.Object(
    {
      label: text(),
      status: StringEnum(["pending", "completed", "failed", "aborted"]),
      output: Type.Optional(output),
      error: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  );
}

/** Register as the review tool's outputSchema; return the same object as structuredContent. */
export const ReviewRunSchema = Type.Object(
  {
    runId: text(),
    status: StringEnum([
      "inspecting",
      "ready",
      "partial",
      "aborted",
      "fixing",
      "fixed",
      "fix_failed",
    ]),
    scope: ReviewScopeSchema,
    targetFiles: texts(),
    noFix: Type.Boolean(),
    issues: Type.Array(Type.String()),
    coverage: Type.Array(
      Type.Object(
        {
          pass: Type.Integer(),
          bucket: Type.Integer(),
          focus: texts(),
          receipt: receiptSchema(ReviewInspectionSchema),
        },
        { additionalProperties: false },
      ),
    ),
    candidates: Type.Array(candidateSchema),
    findings: Type.Array(candidateSchema),
    validations: Type.Array(receiptSchema(ReviewValidationSchema)),
    fix: Type.Optional(receiptSchema(ReviewFixSchema)),
  },
  { additionalProperties: false },
);

export type ReviewControlsOptions = {
  cwd: string;
  runAgent: ReviewRunner;
  execGit: ReviewExec;
  execGh: ReviewExec;
};
