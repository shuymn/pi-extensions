export const meta = {
  name: "repo_inspection",
  description: "Inspect a repository with a few read-only specialist agents",
  phases: [
    { title: "Inspect" },
    { title: "Verify" },
    { title: "Synthesize" },
  ],
};

const target =
  args && typeof args.target === "string" && args.target.trim() ? args.target : cwd;
const focus =
  args && typeof args.focus === "string" && args.focus.trim()
    ? args.focus
    : "architecture, tests, and risky seams";

const lensSchema = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          note: { type: "string" },
        },
      },
    },
  },
};

// Horizontal axis: Inspect -> Verify -> Synthesize, each phase consuming the prior output.
// Vertical axis (Inspect): independent specialist lenses raise coverage and precision.
phase("Inspect");
log("Inspecting " + target + " with focus: " + focus);
const inspectTarget =
  "Read-only repository inspection of " +
  target +
  ". Focus on " +
  focus +
  ". Return concise observations with concrete file paths; an empty list is acceptable.";
const findings = await parallel([
  () =>
    agent(inspectTarget + " Lens: structure and main extension/runtime boundaries.", {
      label: "structure map",
      schema: lensSchema,
    }),
  () =>
    agent(inspectTarget + " Lens: most relevant tests and verification commands.", {
      label: "test surface",
      schema: lensSchema,
    }),
  () =>
    agent(inspectTarget + " Lens: risky seams, hidden coupling, and maintenance hazards.", {
      label: "risk scan",
      schema: lensSchema,
    }),
]);

phase("Verify");
const verification = await agent(
  "Read-only verification for " +
    target +
    ". Discard observations without concrete file-path evidence and merge duplicates. Lens observations (objects, no parsing needed):\n" +
    JSON.stringify(findings),
  {
    label: "evidence verifier",
    schema: {
      type: "object",
      properties: { confirmed: { type: "array" }, discarded: { type: "array" } },
    },
  },
);

phase("Synthesize");
return await agent(
  "Synthesize this repository inspection into a compact report with sections: map, verification, risks, next actions. Keep file paths concrete. Verified findings (object, no parsing needed):\n" +
    JSON.stringify(verification),
  {
    label: "inspection synthesis",
    schema: {
      type: "object",
      properties: {
        map: { type: "array" },
        verification: { type: "array" },
        risks: { type: "array" },
        nextActions: { type: "array" },
      },
    },
  },
);
