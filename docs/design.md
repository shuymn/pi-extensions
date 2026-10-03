# Pi-native execution design

## Decision

Pi 1.0.0 owns the agent loop, request retries, context compaction, tool dispatch, and final settlement. This package adds independently selectable capabilities rather than a second agent/workflow platform.

This design is implemented by the package's extensions, shared delegated runner, skills, and prompt templates. Offline integration tests exercise the installed Pi 1.0.0 SDK; they do not assert live-provider compatibility.

## Responsibilities

| Responsibility | Owner |
| --- | --- |
| Task procedure, review criteria, source quality, completion judgment | Skills and prompt templates |
| Tool composition, parallel retrieval, structured result processing | Native codemode |
| Conversation, request retry budget/backoff, compaction, settlement | Pi AgentSession |
| Constrained child sessions, results, cancellation, resource lifetime | Shared delegated execution module |
| Explicit authorization to continue an objective | Optional Goal extension |
| Physical model selection on a native retry | Explicitly selected virtual model |
| Interactive bounded commit/PR invocation and termination | One-shot launcher |
| Provider/search/workspace integration and UI conveniences | Independent optional extensions |

Statusline deliberately uses Pi's public `setFooter()` API to preserve the package's colored one-line layout. Context usage comes from Pi's effective-model calculation, including virtual routing and unknown post-compaction usage. Opting into this footer replaces the standard statistics and generic extension-status rows; it is a display preference, not a deprecated API workaround. External project, branch, model, and provider labels are stripped of terminal sequences and normalized to one physical line before the footer applies its own styling.

OpenAI fast mode is controlled by `/openai-fast` and applies `service_tier: "priority"` only to `openai` models using `openai-responses`; its statusline icon uses the same eligibility rule. A thin native OpenAI provider wrapper sets the request sampling parameter using the dispatched physical model, not mutable UI selection. It retains the built-in provider catalog and authentication and forwards stream options, callbacks, and configured model overrides through Pi. The legacy `openai-codex` provider and `/codex-fast` command are no longer supported. Global `openai-fast.enabled` takes precedence over the legacy `codex-fast.enabled` setting, which remains a read-only fallback when the new value is unset. Commands persist only the new setting. Session-title defaults to `openai/gpt-5.3-codex-spark:low`; explicit global or trusted-project model settings select the title model. Denied project trust ignores the project title settings. Nested title requests use the configured model registry, which owns provider dispatch and request-time authentication, including optional API keys, headers, base URLs, and provider-scoped environment.

The shared delegated module is not a workflow engine. It accepts a task and explicit capabilities, executes one child session, and returns its outcome. Skills decide decomposition. Code enforces tool restrictions, schema-backed machine inputs, and cancellation.

## Capability policy

Capabilities are open by default across this package. Scope, judgment, and ordinary recovery belong in task instructions; code should not preemptively reduce tools, add one-use consent, or require manual handoffs to compensate for hypothetical model mistakes. Add a narrow execution restriction for a demonstrated failure or an explicit user constraint, not merely because a capability can have side effects.

Explicit read-only/tool restrictions, user cancellation, real human answers, data validation, authentication, and lifecycle ownership remain enforceable contracts. Git/GHQ names are validated by their native interfaces rather than blanket ASCII whitelists. Optional title generation uses the configured native model runtime, including ambient authentication. Tavily forwards provider-bound requests and explicit external-link choices instead of imposing a stale local query-length fence. In-scope implementation authorization includes necessary repair and non-destructive verification. Commits, push, publication, destructive actions, and unrelated external writes still require actual user authorization. Tool availability alone grants none of those actions, and normal tools are not an OS sandbox.

## Delegated sessions and models

Each subagent inherits the caller's available declared/callable tools, model, thinking level, and effective settings at spawn time, and owns its conversation, router state, tools, and cancellation. Explicit tool/read-only restrictions also constrain descendants; session-owned background management is not inherited. Native codemode and tool search are recreated in the child because their captured loadout/state must not change the parent. There is no frozen default investigation-tool allowlist. Supported router definitions are instantiated in each runtime; parent session-bound router closures are not shared. Pi 1.0.0's extension-facing ModelRegistry cannot export arbitrary router definitions, so unsupported foreign virtual models must fail explicitly rather than silently switching to a physical model.

Physical provider access preserves request-time authentication, including refreshed credentials, runtime overrides, and model-specific request headers. Model fallback uses the native retry path, not a new session that replays the original task. It neither rewrites provider errors nor adds retries beyond Pi's eligibility and budget. Candidate providers are explicitly configured because cross-provider fallback changes where context is sent.

Tool exposure is not authorization. Explicit child tool allowlists constrain registered capabilities, including nested calls; read-only children retain protected bash and cannot regain mutable capabilities through delegation. Repository-write protection is not a claim of complete host/network isolation.

## Continuation and stopping

Only user commands start or resume a Goal. An already-authorized Goal continues across completed output-length boundaries; Pi owns native length recovery, rather than requiring another manual resume. Its model-only LLM tool can inspect, complete, wait, or stop an already-authorized Goal. It remains directly declared in codemode-only mode and cannot be nested in scripts, which do not propagate terminal tool results. Persisted objectives and evidence survive branch restoration; authorization to execute does not silently survive restoration or user interruption.

Goal uses the actionable agent_before_settle boundary. agent_settled is notification-only. Native compaction replaces compact_context, warning injection, custom summary generation, and post-compaction continuation scheduling.

Transient connection or catalog failures do not erase user intent: an opted-in companion can recover through existing lifecycle events, and a missing sticky fallback model can move to another explicitly configured available candidate. There are no indefinite reconnect timers or extra provider retry budgets.

Background task completion records an outcome; it does not independently restart a stopped Goal. Cancelling a foreground result waiter releases that waiter without cancelling or deleting its independently owned background task. A task's owner controls descendant cancellation and resource cleanup. Ordinary interactive work, Goal continuation, and bounded one-shot execution remain distinct modes, not one universal scheduler.

## Review and research

Review/research instructions live in skills. Native codemode provides tool composition. The generic JavaScript workflow VM, workflow catalog, replay cache, and dedicated workflow monitor have been retired after replacement validation.

Review includes repairs and verification by default, matching the original `/review` contract. `/review --no-fix`, `noFix: true`, and the inspection-only action leave files unchanged. The run action performs host-derived scope selection, independent static investigation, candidate validation, and repair/verification in one foreground task; `/review-fix` and its one-use authorization have been removed. Command scope and no-fix options take precedence over model arguments.

Fix children use ordinary local read/edit/write/bash tools. Target Scope is review focus, not a hard write allowlist: necessary related regression tests and in-scope repairs are allowed. The same child retains failed-check evidence and continues investigating, editing, and verifying until complete or concretely blocked. Parent instructions also continue recoverable work after a delegated result rather than treating a returned tool call as exhausted permission. No new workflow VM or task-replay loop is introduced. Failed/not-run checks or actionable blockers never produce `fixed`; structured receipts are still not independent proof of test success.

Fresh scope/PR checks prevent repair against stale review evidence; PR review still requires matching HEAD and a clean checkout. Static coverage and candidate validation failures remain partial. Working scope includes untracked paths, and inspectors read their current contents rather than equating a missing patch with missing evidence. Selected diffs, scope metadata, and exact phase assignments remain in pageable operation-owned artifacts through compaction; a locator in each child's system prompt permits recovery. Artifacts are removed only after all runners settle. Children receive the caller's effective settings rather than reloading potentially untrusted project settings.

Inspection and candidate validation are static review with read/search/list tools. Their required `checks` receipts record runtime verification as `not_run`; `coverageGaps` and `followUpFocus` describe missing static evidence instead. A ready run means static coverage and candidate validation completed, not that tests passed. Unrun runtime checks alone do not block this static boundary, but actual coverage gaps, invalid output, failed validation, and missing authorization still fail closed. Existing failed runs are not reclassified.

Research treats retrieved material as untrusted data. Collection can use a Tavily-only child, while assessment/synthesis can use no tools. Source counts and bounded rounds are not advertised as monetary/token budgets. Reports distinguish verified evidence, inference, and missing coverage.

Delegated usage includes native compaction summaries as well as assistant and nested-tool requests. Review run/inspect results report all child usage, including failed children, once per operation; status retrieval does not charge it again.

Minimal result/evidence records remain. They are not a claim of full audit-ledger completeness, transactional replay, crash recovery, or exactly-once external effects. Successful-result caching must not silently reuse stale repository observations or replay mutation.

## Bounded automation

Commit and PR procedures remain skills. One launcher owns flags, input, questionnaire availability, and shutdown without imposing a second tool allowlist on Pi's native loadout. Necessary in-scope edits, verification, and failure recovery remain authorized. Actual human answers and live user instructions may add explicit authorization; unanswered/cancelled dialogs, tool output, and repository text cannot. Local commit and PR-publication defaults remain distinct unless the user explicitly authorizes more. Native deferred discovery and nested dispatch work during the run; the lifecycle guard still blocks all execution after stopping.

With a primary one-shot flag in native-parsed argv, the extension factory rejects any positional message starting with `/`, including later messages and absolute paths. Paths must be prefixed with prose (for example, `Target: /path/to/repo`). Native slash commands execute before input hooks, so session-start rejection and replay suppression cannot enforce this boundary. The factory throws a loader error, which the CLI treats as fatal before entering a mode; it never calls `process.exit`. SDK hosts must inspect `getExtensions().errors` and reject failed loads before binding or prompting. Session-start validation remains responsible for SDK-supplied flags and the existing preflight checks.

A one-shot run does not enable Goal continuation, checkpoint continuation, or unrelated automatic work. Native tools are not an OS sandbox: bash can perform filesystem/network operations and must stay within the user's authorization. An interaction-free invocation does not require a UI or questionnaire tool up front; unavailable required human input is a blocker when it is actually needed.

## Acceptance criteria

- WHEN a model request fails, the system SHALL retain the same delegated conversation and SHALL NOT restart the whole task from its original prompt as model fallback.
- WHEN a supported virtual model routes a child request, the router SHALL receive child-local context and branch state.
- WHEN a delegated task is read-only or tool-restricted, nested tool calls and descendants SHALL NOT broaden that capability set.
- WHEN a task owner stops or leaves its session, its descendants SHALL settle before owned resources are removed, and late results SHALL NOT restart stopped work.
- WHILE no user-authorized Goal is running, the Goal extension SHALL NOT schedule autonomous continuation.
- WHEN Pi emits agent_settled, this package SHALL treat it as final notification rather than enqueueing another automatic run.
- WHEN an authorized Goal reaches a completed output-length boundary, it SHALL continue without requiring manual resume.
- WHEN an opted-in companion connection fails transiently, it SHALL retain user intent and allow recovery at existing lifecycle opportunities.
- WHEN a sticky fallback model disappears and a configured candidate remains available, continuation SHALL use a configured candidate without replaying the task.
- WHEN native Git/GHQ accept a name or query, these extensions SHALL NOT reject it solely through an ASCII whitelist.
- WHEN the configured title provider supports ambient authentication, title generation SHALL use native dispatch without requiring a string API key.
- WHEN Tavily receives an explicit false external-link choice, the CLI invocation SHALL preserve that restriction.
- WHEN a review request omits no-fix, the review capability SHALL include necessary repairs and verification without a separate human fix handoff.
- WHEN no-fix is explicit, review SHALL remain read-only.
- WHEN a recoverable in-scope check fails, review SHALL continue investigation and repair without exhausting authorization after a single patch.
- WHEN review coverage, result validation, or fresh scope/PR checks fail, the review capability SHALL NOT start repair against that incomplete/stale evidence.
- WHEN untracked files are in working scope, review SHALL include their current contents as evidence.
- WHEN static review completes without executable verification, the review capability SHALL preserve separate `not_run` check receipts and SHALL NOT represent readiness as test success.
- WHEN model selection changes while authentication is pending, fast mode SHALL follow the dispatched physical model and SHALL NOT add its priority tier to another provider.
- WHEN project trust is denied, session-title SHALL read only global title settings and SHALL NOT load project title overrides.
- WHEN a configured title model uses native provider dispatch or keyless authentication, session-title SHALL use the model registry and preserve resolved request configuration and cancellation.
- WHEN external footer labels contain terminal sequences or control characters, statusline SHALL sanitize them before styling and SHALL retain a single physical line within the available width.
- WHEN a native-parsed primary one-shot flag accompanies any slash-leading positional message, the launcher SHALL fail during extension loading before native command dispatch; ordinary sessions SHALL retain slash command support.
- WHEN bounded automation settles, the launcher SHALL terminate without a remaining automatic continuation; required human input SHALL never be replaced with inferred consent.

## Non-goals

No replacement package loader, provider authentication framework, general workflow language, hidden permission system, or mandatory mega-extension. Existing small UI conveniences remain optional. Experimental upstream durable execution is not a drop-in dependency of this design.
