export const meta = {
  name: "adversarial_review",
  description: "Stress-test a change with adversarial read-only review agents",
  phases: [
    { title: "Attack" },
    { title: "Verify" },
    { title: "Synthesize" },
  ],
};

const target =
  args && typeof args.target === "string" && args.target.trim()
    ? args.target
    : "the current change";
const claim =
  args && typeof args.claim === "string" && args.claim.trim()
    ? args.claim
    : "the implementation is correct and safe";

const findingsSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issue: { type: "string" },
          evidence: { type: "string" },
          severity: { type: "string" },
        },
      },
    },
  },
};

const verdictSchema = {
  type: "object",
  properties: {
    validated: { type: "array", items: { type: "object" } },
    falsePositives: { type: "array", items: { type: "object" } },
  },
};

// Horizontal axis: Attack -> Verify -> Synthesize, each phase trusting the prior output.
// Vertical axis (Attack): independent adversarial lenses; (Verify): adversarial cross-check.
phase("Attack");
log("Adversarially reviewing " + target);
const attackTarget =
  "Read-only adversarial review of " +
  target +
  '. Falsify this claim: "' +
  claim +
  '". Report only concrete findings with file-path evidence; an empty findings array is acceptable.';
const attacks = await parallel([
  () =>
    agent(
      attackTarget +
        " Lens: edge cases and boundary inputs (empty, null, large, malformed).",
      { label: "edge attack", schema: findingsSchema },
    ),
  () =>
    agent(
      attackTarget +
        " Lens: error paths, permission mistakes, and race/cancellation issues.",
      { label: "error path attack", schema: findingsSchema },
    ),
  () =>
    agent(
      attackTarget + " Lens: missing or weak tests and verification gaps; list exact commands.",
      { label: "test gap attack", schema: findingsSchema },
    ),
]);

phase("Verify");
const verifyTarget =
  "Read-only verification for " +
  target +
  ". Decide whether each adversarial finding is real, a duplicate, or a false positive, using concrete file-path evidence and commands. Adversarial findings:\n" +
  JSON.stringify(attacks);
const verifications = await parallel([
  () => agent(verifyTarget + " Pass: confirm reproducibility.", {
    label: "finding verifier",
    schema: verdictSchema,
  }),
  () =>
    agent(verifyTarget + " Pass: independent cross-check; flag anything not independently reproducible.", {
      label: "verification cross-check",
      schema: verdictSchema,
    }),
]);

phase("Synthesize");
return await agent(
  "Produce a concise adversarial review summary for " +
    target +
    ". Separate validated issues, likely false positives, and recommended verification. Verified findings (objects, no parsing needed):\n" +
    JSON.stringify(verifications),
  {
    label: "adversarial synthesis",
    schema: {
      type: "object",
      properties: {
        validatedIssues: { type: "array" },
        falsePositives: { type: "array" },
        recommendedVerification: { type: "array" },
      },
    },
  },
);
