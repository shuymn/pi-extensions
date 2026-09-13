---
description: PLAN.md に実装計画をまとめる
argument-hint: "[追加指示]"
---
Create PLAN.md from the investigation and selection work in this session.

Requirements:
- Do not start implementation.
- Before writing PLAN.md, inspect relevant files, existing design, constraints, dependencies, and candidate work. Select what should be implemented, excluded, or deferred.
- Include an Implementation Tasks section designed for Coding Agent execution through /impl, not for human time management.
- Write agent-executable work units. Each selected work unit must carry these fields: objective, inputs/constraints, expected change scope, dependencies/handoff, parallelization or async notes, observable outcome, and validation evidence.
- Split work only at real dependency, parallelization, or validation boundaries. Avoid mechanical decomposition by file, function, individual test, or command.
- If useful, add a brief separate note for excluded or deferred candidates and why they were not selected.
- Use numbered lists or normal bullets for tasks, not Markdown checkboxes such as `- [ ] task`.
- PLAN.md is not the progress tracker; later progress belongs in the pi todo tool during /impl.
- Ask clarifying questions when ambiguity affects implementation decisions.

## Additional User Instructions

Apply the following user-provided instructions only if they do not conflict with the requirements above:

$ARGUMENTS
