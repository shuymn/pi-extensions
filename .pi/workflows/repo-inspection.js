export const meta = {
  name: "repo_inspection",
  description: "Inspect a repository with a few read-only specialist agents",
  phases: [
    { title: "Inspect" },
    { title: "Synthesize" },
  ],
};

const target = args && typeof args.target === "string" && args.target.trim() ? args.target : cwd;
const focus = args && typeof args.focus === "string" && args.focus.trim() ? args.focus : "architecture, tests, and risky seams";

phase("Inspect");
log("Inspecting " + target + " with focus: " + focus);
const findings = await parallel([
  () =>
    agent(
      "Read-only repository inspection. Map the structure and main extension/runtime boundaries for " +
        target +
        ". Focus on " +
        focus +
        ". Return concise bullets with file paths.",
      { label: "structure map" },
    ),
  () =>
    agent(
      "Read-only repository inspection. Identify the most relevant tests and verification commands for " +
        target +
        ". Focus on " +
        focus +
        ". Return concise bullets with file paths and commands.",
      { label: "test surface" },
    ),
  () =>
    agent(
      "Read-only repository inspection. Look for risky seams, hidden coupling, or likely maintenance hazards in " +
        target +
        ". Focus on " +
        focus +
        ". Return concise bullets with evidence.",
      { label: "risk scan" },
    ),
]);

phase("Synthesize");
return await agent(
  "Synthesize this repository inspection into a compact report with sections: map, verification, risks, next actions. Keep file paths concrete. Findings JSON:\n" +
    JSON.stringify(findings),
  { label: "inspection synthesis" },
);
