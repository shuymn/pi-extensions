---
name: review
description: Review code changes or selected files, repair actionable defects, and verify the result. Review includes fixes by default; use no-fix for an explicitly report-only request. Use for files, staged or working changes, a branch diff, or a pull request; use triage-review for supplied review comments and adversarial-verify for dedicated stress-test probes instead.
---

# Review

Review includes investigation, validated repairs, and verification unless the user explicitly requests **no fix**. Read [criteria.md](criteria.md) before inspection. Use the `review` capability for host-selected scope and independent evidence; its receipts record what ran, not proof that every claim is true.

## Run

1. Resolve the user's scope to exactly one of explicit repository-relative files, PR selector, base ref, staged changes, or working changes (the default). Whole-file and diff review are different scopes. Ask only when that distinction materially changes the requested work. Use the repository root as cwd.
2. Discover `review` and its current schema with tool search or codemode `searchTools` / `describeTool`. Call `run` (the default action), adding material risk areas as focus. Set `noFix: true` only for an explicitly report-only request; `inspect` is also inspection-only. `/review [files | --staged | --base ref | --pr selector]` starts the same task, and `--no-fix` selects report-only mode. There is no `/review-fix` handoff.
3. Read every assigned existing file, including untracked and renamed additions. The patch supplies change context, not the only available evidence. If a patch omits an existing file, obtain its current contents rather than declaring a coverage gap. Genuine failed coverage or validation remains partial, not a clean review; obtain the missing evidence and run a focused follow-up within the same request when possible.
4. Keep the run ID and use `status` for recorded findings, coverage, checks, and blockers. In codemode retain structured results and project only relevant evidence. A failed script does not undo completed tool calls.
5. For review-with-fix, continue through necessary local repairs, related regression tests, and project verification. A check that fails before the intended assertion is still failing: investigate the root cause, repair within scope, and rerun the affected check. If a delegated result leaves recoverable work, continue with ordinary local tools or a fresh focused review; a completed tool call is not exhausted user authorization. Stop only when the requested work is verified or progress requires unavailable input/access, a material scope expansion, or an external change. Report those blockers with the specific next action.
6. Report validated findings with path, evidence, impact, and repair or smallest suggested fix. Separate unvalidated candidates, static coverage, applied changes, and runtime checks. State failed/missing coverage and checks literally: `not_run` is not passing verification, and zero findings is not proof of defect-free code.

## Scope and side effects

Target files identify review focus, not a hard write allowlist. Preserve unrelated user changes and make the smallest necessary repair. Review-with-fix authorizes in-scope recovery and non-destructive local verification, not commits, push, publication, destructive operations, or unrelated external writes. Ask only for a missing material decision or additional authorization. Ordinary fix tools are not an OS sandbox. Explicit no-fix review remains read-only.

Completion criteria (EARS):

- When review completes, the report shall account for every host-selected file and requested focus using coverage receipts.
- If an existing file is omitted from the patch, the assistant shall obtain its contents before treating that omission as missing evidence.
- When an in-scope check fails, the assistant shall investigate and repair it, then rerun affected verification without requesting a new one-shot fix authorization.
- If checks are failed or not run, the assistant shall report unresolved work and evidence rather than claim verified completion.
- When the user requests no fix, the assistant shall leave repository files unchanged and report only.
