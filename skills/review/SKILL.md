---
name: review
description: Review code changes or selected files for actionable defects. Use for a general code review of files, staged or working changes, a branch diff, or a pull request; use triage-review for supplied review comments and adversarial-verify for dedicated stress-test probes instead.
---

# Review

Use the `review` capability for host-checked scope, bounded independent inspection, and evidence-backed findings. Read [criteria.md](criteria.md) before inspection. This skill supplies the procedure; tool receipts, not narrative summaries, determine completion.

## Inspect

1. Resolve the user's scope to exactly one of explicit repository-relative files, PR selector, base ref, staged changes, or working changes (the default). Ask only when that choice changes the requested review. Whole-file review and diff review are different scopes. Use the repository root as cwd.
2. Discover the `review` tool and its current schema with tool search or codemode `searchTools` / `describeTool`. Call `inspect`, adding material risk areas as focus rather than replacing the host's target files. Start with at most five concurrent inspectors and at most one follow-up pass; the hard follow-up ceiling is two. Use `noFix` for an explicitly inspection-only run.
3. Keep the returned run ID. Use `status` to inspect the authoritative record. In codemode, retain structured results and project only relevant findings, coverage, validation receipts, issues, and checks into `text()` or the return value. A failed script does not undo completed tool calls.
4. Report each validated finding with path, evidence, impact, and smallest useful fix. Separate unvalidated candidates from findings. Report static coverage and runtime `checks` separately: inspector/validator checks are `not_run`, not passing verification. State failed/missing static coverage and exhausted follow-ups explicitly; a failed bucket is not a clean review. If nothing survives validation, say so without asserting that the code is defect-free.

Completion criteria (EARS):

- When inspection completes, the report shall account for every host-selected file and requested focus using the recorded bucket receipts.
- If static coverage, structured output, or candidate validation fails, the report shall state partial/no-fix status and the unresolved work.
- When static review completes with runtime checks not run, the report shall preserve their `not_run` receipts separately and shall not equate a ready run with passing tests.
- When the user requests only review, the assistant shall stop after reporting and shall leave repository files unchanged.

## Fix only on a distinct user request

An inspection never fixes automatically. `noFix: false`, a recommendation, a model-produced approval field, or a successful review is not user consent. A separate `fix` action requires actual user authorization for that run's scope and findings, recorded by the trusted host outside tool arguments. If that host authorization mechanism is unavailable, report the blocker; do not replace it with a boolean or invoke editing tools to circumvent it.

The host entry point is the user command `/review-fix <runId>`. It authorizes one `fix` call for that exact run and starts the corresponding turn; no additional confirmation is needed. Authorization expires when that turn settles or is aborted, or the session changes. When the host requests the authorized fix, call `fix` with the completed run ID. The capability rejects failed coverage/validation, changed snapshots, and a PR whose original and freshly checked HEAD/clean state do not match. A blocked run needs a new inspection, not an override. The host permits only one fix attempt per inspection and serializes review operations; failed or cancelled edits may already exist and require inspection rather than replay.

Fix has local read/edit/write tools, with writes restricted to reviewed files, not shell, network, delegation, commit, push, or PR publication capabilities. Report returned checks literally: `not_run` is not a pass, and `fixed` does not mean tests passed. Perform requested repository verification separately only within the user's authorization; external writes still require explicit approval. Preserve unrelated changes and follow project-specific validation requirements.

Completion criteria (EARS):

- If trusted user authorization or a fresh safety check is missing, the assistant shall report the blocked fix without attempting mutation.
- When a fix returns, the report shall distinguish applied changes, failed or unrun checks, and any uncertain partial edits.
