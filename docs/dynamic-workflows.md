# Dynamic Workflows

`dynamic-workflows` runs deterministic JavaScript orchestration scripts that call Pi subagents through `agent()`, `parallel()`, `pipeline()`, `phase()`, and `log()`.

Current safety note: workflow scripts are parsed and restricted, but execution still uses Node's VM in the Pi process. Do not treat workflow JavaScript as a CPU-safe plugin boundary until the remaining worker/subprocess isolation follow-up is complete.

## Optional ultracode policy mode

Workflow auto-use is off by default. To opt into broader workflow guidance for the current Pi session, run:

```text
/ultracode on
```

While enabled, the extension appends session policy guidance telling the main agent to prefer the `workflow` tool for substantive tasks that benefit from decomposition, parallel investigation, or adversarial verification. The policy still tells the agent not to launch workflows for quick single-file edits, simple factual questions, or tasks without an objective verification path.

Use `/ultracode status` to inspect the mode and `/ultracode off` to disable it. The mode resets at session start and does not make skill-packaged workflow discovery an authorization signal by itself.

## When not to use dynamic workflows

Do not launch a dynamic workflow when the task is better handled by the main agent directly:

- Quick single-file edits where the target file and expected change are already clear.
- Simple factual questions or source lookups that do not need parallel investigation.
- Formatting, copy edits, or mechanical renames with an obvious verification command.
- Tasks without an objective verification path, where extra agents would only produce opinions.
- User requests that explicitly ask for a small direct fix, unless they also ask for workflow-style orchestration.

Prefer ordinary tools or a single direct answer in those cases. Use dynamic workflows when the task benefits from auditable decomposition, independent subagent perspectives, parallel inspection, or adversarial verification.

## Saved workflow locations

Project-local saved workflows live in:

```text
.pi/workflows/<workflow-name>.js
```

A saved workflow file is resolved by its static `meta.name`, not by filename. Project saved workflows, skill-packaged workflow roots, duplicate-name handling, completion candidates, and direct slash-command registration are coordinated through the shared `WorkflowCatalog` boundary.

## Example saved workflows

This repository ships two small project-local examples:

- `repo_inspection` (`.pi/workflows/repo-inspection.js`) — read-only repository map, test-surface scan, risk scan, then synthesis.
- `adversarial_review` (`.pi/workflows/adversarial-review.js`) — read-only edge-case attack, test-gap attack, verification, then synthesis.

Launch them with JSON args:

```text
/workflow repo_inspection {"target":"extensions/dynamic-workflows","focus":"saved workflow support"}
/workflow adversarial_review {"target":"extensions/dynamic-workflows","claim":"the saved workflow examples are safe"}
```

The `.pi/workflows/.gitignore` file keeps generated run artifact directories out of git while allowing these example scripts to be tracked.

## Skill-packaged workflows

Skills can package reusable workflow scripts next to `SKILL.md`:

```text
skills/deep-research/
  SKILL.md
  workflows/
    deep-research.js
```

Package the skill through Pi package metadata:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

When Pi loads the skill, `dynamic-workflows` also searches that skill's `workflows/*.js` files for `meta.name` resolution. Project `.pi/workflows/*.js` files are searched first, so a project can override a packaged workflow with the same `meta.name`.

Discovery is not authorization. A skill-packaged workflow may be launched only when the user explicitly asks for workflow-style orchestration or the loaded skill instructions explicitly authorize it, for example:

```markdown
When this skill is used for broad multi-source research, launch the packaged workflow with `/workflow deep-research {"topic":"..."}`. Do not launch it for quick factual questions or single-source lookups.
```

If the skill only documents a workflow file but does not tell the agent when to launch it, use normal tools instead of starting a workflow.

Example packaged workflow:

```js
export const meta = {
  name: "deep-research",
  description: "Research a topic with parallel subagents",
  phases: [{ title: "Research" }, { title: "Synthesize" }],
};

phase("Research");
const findings = await parallel([
  () => agent("Collect primary sources for " + args.topic, { label: "sources" }),
  () => agent("Find risks and counterarguments for " + args.topic, { label: "risks" }),
]);

phase("Synthesize");
return await agent("Synthesize these findings:\n" + JSON.stringify(findings), {
  label: "synthesis",
});
```

Launch by name through the generic command or LLM tool:

```text
/workflow deep-research {"topic":"Pi packages"}
```

```json
{"name":"deep-research","args":{"topic":"Pi packages"}}
```

Skill-packaged workflows do not register direct slash commands in this slice. Use `/workflow <name> [JSON args]` or the `workflow` tool's `name` input.
