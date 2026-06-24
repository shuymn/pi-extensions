# Dynamic Workflows

`dynamic-workflows` runs deterministic JavaScript orchestration scripts that call Pi subagents through `agent()`, `parallel()`, `pipeline()`, `phase()`, and `log()`.

Current safety note: workflow scripts are parsed and restricted, but execution still uses Node's VM in the Pi process. Do not treat workflow JavaScript as a CPU-safe plugin boundary until the remaining worker/subprocess isolation follow-up is complete.

## Optional ultracode policy mode

Workflow auto-use is off by default. To opt into broader workflow guidance for the current Pi session, run:

```text
/ultracode on
```

While enabled, the extension appends session policy guidance telling the main agent to prefer the `workflow` tool for substantive tasks that benefit from decomposition, parallel investigation, or adversarial verification. The policy still tells the agent not to launch workflows for quick single-file edits, simple factual questions, or tasks without an objective verification path.

Use `/ultracode status` to inspect the mode and `/ultracode off` to disable it. The mode resets at session start and does not make packaged workflow discovery an authorization signal by itself.

## Workflow script contract

Workflow scripts can call `agent(prompt, options)` to delegate work to a Pi subagent. Supported author options are:

- `label` — short human-readable label for progress, journal, and transcript artifacts.
- `phase` — explicit phase label for this agent call; otherwise the current `phase()` is used.
- `schema` — JSON schema for structured output. When provided, the subagent must finish with the structured output tool and `agent()` returns the parsed object.
- `agentType` — English role metadata for prompts, journals, and transcripts.
- `model` — optional child-agent model selection using the shared `provider/model` or `provider/model:effort` notation, for example `openai/gpt-5:high`. When effort is omitted, the child keeps the parent session's current effort.
- `toolPolicy` — optional per-agent execution policy. `"readOnly"` runs the phase without `edit`/`write` tools and replaces the built-in `bash` with a read-only protected bash, while structured output still works. `"readOnly"` is the only accepted value; any other value fails fast with a contract error. See [Per-agent read-only policy](#per-agent-read-only-policy).

`thinkingLevel`, `effort`, and `isolation` are intentionally unsupported as separate options. Passing any of them to `agent()` fails fast instead of becoming a no-op hint. Use the `model` notation above for per-agent model and effort selection.

The `budget` global and `tokenBudget` launch option are estimate-based guards derived from serialized agent result size. They are not actual model-token accounting, and workflow outputs do not report real tool-call counts.

## Per-agent read-only policy

A phase can request a read-only child agent by passing `toolPolicy: "readOnly"` to `agent()`:

```js
phase("Recon");
const recon = await agent("Map the changed files and risk areas.", {
  label: "recon",
  toolPolicy: "readOnly",
});
```

With `toolPolicy: "readOnly"`:

- The child agent's `edit` and `write` tools are dropped, so the phase cannot mutate the workspace.
- The built-in `bash` tool is replaced by a protected read-only bash that rejects mutating commands; sandbox or fingerprint failures are returned as tool output rather than crashing the phase.
- Structured output (`schema`) still works, so read-only phases can return parsed objects that later phases consume.

`"readOnly"` is the only accepted value. Any other value fails fast with a workflow contract error. The policy is enforced per `agent()` call, so a single workflow can mix read-only investigation phases with later mutating phases.

Replay note: the policy participates in the agent journal key only when it is set, so existing default-policy runs keep byte-identical replay keys.

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

A saved workflow file is resolved by its static `meta.name`, not by filename. Project saved workflows, skill-packaged workflow roots, extension-packaged workflow roots, duplicate-name handling, completion candidates, and direct slash-command registration are coordinated through the shared `WorkflowCatalog` boundary.

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

Discovery is not authorization. A packaged (skill or extension) workflow may be launched only when the user explicitly asks for workflow-style orchestration or the loaded skill instructions explicitly authorize it, for example:

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

## Extension-packaged workflows

Extensions can also ship packaged workflow scripts. The `dynamic-workflows` extension ships its own presets under:

```text
extensions/dynamic-workflows/workflows/<workflow-name>.js
```

These roots are contributed through `extensionPackagedWorkflowRoot()` / `extensionPackagedWorkflowRootDescriptors()` and made available to the `workflow` tool and the `/workflow` command. Like skill-packaged workflows, extension-packaged workflows are launch-only and do not register direct slash commands.

## Workflow source provenance and precedence

Every resolved workflow carries a `source` of `"project" | "skill" | "extension"`. The catalog resolves a workflow by its static `meta.name` across all roots, and the project root is always searched first:

```text
project (.pi/workflows) › skill (skills/*/workflows) › extension (extensions/*/workflows)
```

So a project `.pi/workflows/<name>.js` overrides a skill- or extension-packaged workflow with the same `meta.name`. Provenance is descriptive only: it lets callers and the UI distinguish where a workflow came from, but **discovery is not authorization**. A packaged (skill or extension) workflow may be launched only when the user explicitly asks for workflow-style orchestration or the loaded skill instructions explicitly authorize it.

## Workflow launch bridge

The `dynamic-workflows` extension owns the workflow run lifecycle: scheduling, run-artifact storage, the progress widget, the resume cache, the run controller registry, and background completion notifications. Sibling extensions that need to launch a packaged workflow with prepared inputs do so through the launch bridge instead of duplicating any of that machinery.

`createWorkflowLaunchBridge(options)` returns a `WorkflowLaunchBridge`:

```ts
type WorkflowLaunchBridge = (
  input: WorkflowToolInput, // typically { name, args }
  ctx: ExtensionContext,
  signal?: AbortSignal,
) => Promise<WorkflowLaunchResult>; // { runId, taskId, workflowName, artifactDir, outputPath, details }
```

The bridge launches a workflow by resolved `name` (or `script` / `scriptPath`) plus `args`, producing the same `runId`, `artifactDir`, `outputPath`, and background notifications as the `workflow` tool. It is generic and contains no review or research semantics. Failure modes:

- A pre-aborted `signal` rejects with `workflow launch was aborted.`.
- An unknown workflow `name` rejects.
- The shared controller registry can cancel a launched run mid-flight; the run's `output.json` then records status `cancelled`.

Sibling extensions inject the bridge (dependency injection) rather than importing live launch state. This keeps the run lifecycle owned in one place and keeps each sibling adapter unit-testable with a fake bridge.

## Packaged presets: research_flow and review_flow

The `dynamic-workflows` extension ships two presets. They are experimental and additive: they coexist with, and do not replace, the authoritative `/research` + `deep_research` and `/review` commands.

### research_flow

`research_flow` runs Frame → Collect → bounded Assess → Synthesize and returns a cited brief. Launch it by name with JSON args:

```text
/workflow research_flow {"task":"Compare Bun and Node test runners","depth":"standard","profile":"technical"}
```

Args are compatible with the research extension's params (`task`, `depth`, `profile`, `outputFormat`, `citationFormat`, `maxSources`) after light in-script defaulting. The Assess → Collect retry loop is bounded (at most 2 follow-up rounds) and enforced by the script through structured output, not by parsing prose. Phases use the Tavily `search` / `extract` / `map` / `crawl` tools; the high-cost `tavily_research` tool is intentionally not exposed, and retrieved web content is treated as untrusted data.

### review_flow

`review_flow` runs Recon → Hunt → Validate → Gapfill → Dedupe → Trace → Fix → Verify → Summary. Unlike `research_flow`, it is **not** launched directly with raw user args. The review extension's adapter (`extensions/review/review-flow.ts`) prepares the Target Scope (changed / staged / PR / explicit files, combined diff, and any no-fix reason) with the existing review helpers, then hands a fully prepared args payload to the launch bridge. The workflow script never collects git or `gh` scope itself.

Key behaviors:

- Investigation phases (Recon, Hunt, Validate, Gapfill, Dedupe, Trace, Summary) run with `toolPolicy: "readOnly"`.
- Fix and Verify are the only mutating phases. They run only when no-fix is `false` and are skipped entirely in no-fix mode, so every executed phase is read-only under no-fix.
- A pull-request head mismatch or a dirty worktree auto-downgrades the run to no-fix.
- Hunt fans out parallel review lenses; the Gapfill → Hunt loop is bounded (at most 2 follow-up rounds) via structured output.

### Why domain policy stays outside the runtime

The workflow runtime stays generic. Review and research domain logic — Target Scope preparation, no-fix gating, prompt and policy text, and source-collection rules — lives in the `review` and `research` extensions, not in `dynamic-workflows`. The runtime only provides discovery, provenance, the read-only policy seam, and the launch bridge. This keeps presets swappable and keeps the authoritative `/review` and `/research` commands as the source of truth until a preset reaches parity.
