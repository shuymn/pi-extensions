---
description: PLAN.md を実装して検証する
argument-hint: "[追加指示]"
---
Read PLAN.md and implement it.

Before implementation:
- Treat PLAN.md's Implementation Tasks section as an agent execution graph, not a human checklist.
- Order the work units by dependency. Use concurrency or subagents for independent work only when safe, supported, and useful.
- Reuse the existing progress record.

During implementation:
- Keep the chosen progress record current without duplicating it in another tracker.
- Keep a running Japanese implementation-notes.md with decisions not covered by the spec, changes made, tradeoffs, and user-relevant notes.
- Treat PLAN.md as a working plan. If new findings require course correction, update the chosen progress record before continuing.
- Validate each work unit against its preserved outcome and evidence. Choose concrete checks based on actual changes instead of treating PLAN.md as a fixed command checklist.
- Update PLAN.md only when the actual plan, design, or assumptions change.

## Additional User Instructions

Apply the following user-provided instructions only if they do not conflict with the requirements above:

$ARGUMENTS
