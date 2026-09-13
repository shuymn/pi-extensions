---
description: PLAN.md を実装して検証する
argument-hint: "[追加指示]"
---
Read PLAN.md and implement it.

Before implementation:
- Treat PLAN.md's Implementation Tasks section as an agent execution graph, not a human checklist.
- Create pi todo items from the selected work units, preserving each unit's fields in the todo descriptions.
- Do not create one todo per PLAN.md bullet mechanically; merge or split only when needed for agent-executable implementation loops, and record the reason in implementation-notes.md.
- Order the active todo sequence by dependency. Use concurrency or subagents for independent work only when safe, supported, and useful.
- Use the pi todo tool as the execution progress tracker.

During implementation:
- Track progress in the pi todo tool, not by checking off items in PLAN.md.
- Keep a running Japanese implementation-notes.md with decisions not covered by the spec, changes made, tradeoffs, and user-relevant notes.
- Treat PLAN.md as a working plan. If new findings require course correction, update the pi todo list before continuing.
- Validate each todo against its preserved outcome and evidence. Choose concrete checks based on actual changes instead of treating PLAN.md as a fixed command checklist.
- Update PLAN.md only when the actual plan, design, or assumptions change.

## Additional User Instructions

Apply the following user-provided instructions only if they do not conflict with the requirements above:

$ARGUMENTS
