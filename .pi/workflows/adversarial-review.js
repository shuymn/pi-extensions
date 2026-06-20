export const meta = {
  name: "adversarial_review",
  description: "Stress-test a change with adversarial read-only review agents",
  phases: [
    { title: "Attack" },
    { title: "Verify" },
    { title: "Synthesize" },
  ],
};

const target = args && typeof args.target === "string" && args.target.trim() ? args.target : "the current change";
const claim = args && typeof args.claim === "string" && args.claim.trim() ? args.claim : "the implementation is correct and safe";

phase("Attack");
log("Adversarially reviewing " + target);
const attacks = await parallel([
  () =>
    agent(
      "Read-only adversarial review. Try to falsify this claim: " +
        claim +
        ". Target: " +
        target +
        ". Look for edge cases, error paths, permission mistakes, race/cancellation issues, and missing tests. Return only findings with evidence.",
      { label: "edge attack" },
    ),
  () =>
    agent(
      "Read-only adversarial review. Inspect test coverage and verification gaps for " +
        target +
        ". Assume the implementation may be subtly wrong. Return concrete missing checks and commands.",
      { label: "test attack" },
    ),
]);

phase("Verify");
const verification = await agent(
  "Verify whether these adversarial findings are real, duplicates, or false positives. Prefer concrete file-path evidence and commands. Findings JSON:\n" +
    JSON.stringify(attacks),
  { label: "finding verifier" },
);

phase("Synthesize");
return await agent(
  "Produce a concise adversarial review summary. Separate validated issues, likely false positives, and recommended verification. Target: " +
    target +
    "\nVerified findings JSON:\n" +
    JSON.stringify(verification),
  { label: "adversarial synthesis" },
);
