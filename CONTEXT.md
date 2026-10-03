# Pi Extensions

This context describes a Pi package of optional capabilities, skills, and prompt templates. Pi owns the conversation and execution lifecycle; this package supplies constrained delegation and task-specific controls.

## Language

**Pi Extension Package**:
A package of independently selectable Pi Extensions, Skills, and Prompt Templates.
_Avoid_: Extension collection, agent framework

**Pi Extension**:
A runtime capability that adds tools, user commands, provider integration, or UI behavior to Pi.
_Avoid_: Workflow engine, skill

**Skill**:
A discoverable task procedure and its judgment criteria, distinct from executable permission checks.
_Avoid_: Workflow preset, permission policy

**Prompt Template**:
A named prompt expanded by Pi with user arguments, without a separate execution lifecycle.
_Avoid_: Command implementation, workflow

**LLM Tool**:
A typed runtime capability the agent can request directly or through native tool composition.
_Avoid_: Skill, prompt

**Deferred LLM Tool**:
A registered LLM Tool initially omitted from active declarations but available through native discovery or nested execution.
_Avoid_: Disabled tool, permission boundary

**Slash Command**:
A user-invoked runtime entry point, including actions that establish execution authorization.
_Avoid_: Model tool, prompt template

**Subagent Session**:
A child conversation with its own model routing state, tools, cancellation, and outcome, created for delegated work.
_Avoid_: Workflow phase, shared parent session

**Delegated Outcome**:
The host-recorded completion, failure, or cancellation of a Subagent Session, including its result and available evidence.
_Avoid_: Guaranteed success, replay checkpoint

**Target Scope**:
The host-resolved set of repository files or changes an inspection or authorized fix covers.
_Avoid_: Prompt focus, review instructions

**Review Run**:
One review of a Target Scope with coverage receipts, candidate validation, and in-scope repair and verification by default; an explicitly no-fix request is inspection-only.
_Avoid_: Workflow Run, agent session

**Goal**:
A user-started objective with completion conditions and execution status; persisted objective state alone does not authorize autonomous continuation.
_Avoid_: Task list, work plan

**Virtual Fallback Model**:
An explicitly selected model whose child-local or parent-local router chooses a configured physical candidate within Pi's native request retry budget.
_Avoid_: Task retry, automatic provider switching

**One-shot Run**:
An explicitly invoked commit or PR procedure with the native tool selection, human questions when needed, and automatic shutdown after settlement.
_Avoid_: Print mode, Goal

**Research Task**:
A question answered through bounded source collection and cited synthesis.
_Avoid_: Research workflow, tool call

**Research Source**:
A retrieved document or user-supplied source used as evidence, not as execution instructions.
_Avoid_: Authorization, trusted instruction

**Questionnaire**:
A sequence of native selection or text-input dialogs that records actual answers and unanswered questions separately.
_Avoid_: Inferred consent, automatic approval

## Boundaries

A review request includes necessary local fixes and verification unless explicitly no-fix; an inspection-only request is not permission to edit. Review receipts record what ran and what was reported; they do not prove a finding or citation is true. Deferred exposure is not a capability restriction, and repository-write protection is not complete host or network isolation.

Native codemode composes tools; it does not replace Subagent Sessions. Native compaction manages context; it does not start or resume a Goal. See [the execution design](docs/design.md) for these responsibility boundaries.
