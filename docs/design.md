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

Statusline deliberately uses Pi's public `setFooter()` API to preserve the package's colored one-line layout. Context usage comes from Pi's effective-model calculation, including virtual routing and unknown post-compaction usage. Opting into this footer replaces the standard statistics and generic extension-status rows; it is a display preference, not a deprecated API workaround.

The shared delegated module is not a workflow engine. It accepts a task and explicit capabilities, executes one child session, and returns its outcome. Skills decide decomposition. Code enforces tool restrictions, schema-backed machine inputs, and cancellation.

## Delegated sessions and models

Each child owns its conversation, router state, tools, and cancellation. Supported router definitions are instantiated in each runtime; parent session-bound router closures are not shared. Pi 1.0.0's extension-facing ModelRegistry cannot export arbitrary router definitions, so unsupported foreign virtual models must fail explicitly rather than silently switching to a physical model.

Physical provider access preserves request-time authentication, including refreshed credentials, runtime overrides, and model-specific request headers. Model fallback uses the native retry path, not a new session that replays the original task. It neither rewrites provider errors nor adds retries beyond Pi's eligibility and budget. Candidate providers are explicitly configured because cross-provider fallback changes where context is sent.

Tool exposure is not authorization. Explicit child tool allowlists constrain registered capabilities, including nested calls; read-only children retain protected bash and cannot regain mutable capabilities through delegation. Repository-write protection is not a claim of complete host/network isolation.

## Continuation and stopping

Only user commands start or resume a Goal. Its model-only LLM tool can inspect, complete, wait, or stop an already-authorized Goal. It remains directly declared in codemode-only mode and cannot be nested in scripts, which do not propagate terminal tool results. Persisted objectives and evidence survive branch restoration; authorization to execute does not silently survive restoration or user interruption.

Goal uses the actionable agent_before_settle boundary. agent_settled is notification-only. Native compaction replaces compact_context, warning injection, custom summary generation, and post-compaction continuation scheduling.

Background task completion records an outcome; it does not independently restart a stopped Goal. Cancelling a foreground result waiter releases that waiter without cancelling or deleting its independently owned background task. A task's owner controls descendant cancellation and resource cleanup. Ordinary interactive work, Goal continuation, and bounded one-shot execution remain distinct modes, not one universal scheduler.

## Review and research

Review/research instructions live in skills. Native codemode provides tool composition. The generic JavaScript workflow VM, workflow catalog, replay cache, and dedicated workflow monitor have been retired after replacement validation.

Executable review checks remain: host-derived Target Scope, read-only investigation, complete bounded coverage, explicit partial failures, machine-validated control results, and fresh scope/PR authorization immediately before mutation. Inspecting a change does not authorize fixing it. `/review-fix <runId>` grants single-use, turn-scoped authorization for that exact run; a boolean supplied by the model is not proof of user consent. Fix children can edit only reviewed local files, without shell, network, or delegation tools. Mutation authorization checks the final native I/O path after path rewriting, before any file or directory mutation. Their structured result is not proof that tests passed; unrun verification must be reported separately.

Inspection and candidate validation are static review with read/search/list tools. Their required `checks` receipts record runtime verification as `not_run`; `coverageGaps` and `followUpFocus` describe missing static evidence instead. A ready run means static coverage and candidate validation completed, not that tests passed. Unrun runtime checks alone do not block this static boundary, but actual coverage gaps, invalid output, failed validation, and missing authorization still fail closed. Existing failed runs are not reclassified.

Research treats retrieved material as untrusted data. Collection can use a Tavily-only child, while assessment/synthesis can use no tools. Source counts and bounded rounds are not advertised as monetary/token budgets. Reports distinguish verified evidence, inference, and missing coverage.

Delegated usage includes native compaction summaries as well as assistant and nested-tool requests. Review inspect/fix results report all child usage, including failed children, once per operation; status retrieval does not charge it again.

Minimal result/evidence records remain. They are not a claim of full audit-ledger completeness, transactional replay, crash recovery, or exactly-once external effects. Successful-result caching must not silently reuse stale repository observations or replay mutation.

## Bounded automation

Commit and PR procedures remain skills. One launcher owns flags, input, the existing tool allowlist, questionnaire availability, and shutdown. Interactive human questions remain supported; missing skills or unavailable required interaction fail closed. Commit authorization does not authorize push/PR publication, and PR publication does not implicitly authorize creating commits.

With a primary one-shot flag in native-parsed argv, the extension factory rejects any positional message starting with `/`, including later messages and absolute paths. Paths must be prefixed with prose (for example, `Target: /path/to/repo`). Native slash commands execute before input hooks, so session-start rejection and replay suppression cannot enforce this boundary. The factory throws a loader error, which the CLI treats as fatal before entering a mode; it never calls `process.exit`. SDK hosts must inspect `getExtensions().errors` and reject failed loads before binding or prompting. Session-start validation remains responsible for SDK-supplied flags and the existing preflight checks.

A one-shot run does not enable Goal continuation, checkpoint continuation, or unrelated automatic work. Its tool allowlist is not an OS sandbox: permitted bash can still perform filesystem/network operations within the user's authorization.

## Acceptance criteria

- WHEN a model request fails, the system SHALL retain the same delegated conversation and SHALL NOT restart the whole task from its original prompt as model fallback.
- WHEN a supported virtual model routes a child request, the router SHALL receive child-local context and branch state.
- WHEN a delegated task is read-only or tool-restricted, nested tool calls and descendants SHALL NOT broaden that capability set.
- WHEN a task owner stops or leaves its session, its descendants SHALL settle before owned resources are removed, and late results SHALL NOT restart stopped work.
- WHILE no user-authorized Goal is running, the Goal extension SHALL NOT schedule autonomous continuation.
- WHEN Pi emits agent_settled, this package SHALL treat it as final notification rather than enqueueing another automatic run.
- WHEN review coverage, result validation, or fresh mutation authorization fails, the review capability SHALL NOT start a mutating child.
- WHEN static review completes without executable verification, the review capability SHALL preserve separate `not_run` check receipts and SHALL NOT represent readiness as test success.
- WHEN a native-parsed primary one-shot flag accompanies any slash-leading positional message, the launcher SHALL fail during extension loading before native command dispatch; ordinary sessions SHALL retain slash command support.
- WHEN bounded automation settles, the launcher SHALL terminate without a remaining automatic continuation; required human input SHALL never be replaced with inferred consent.

## Non-goals

No replacement package loader, provider authentication framework, general workflow language, hidden permission system, or mandatory mega-extension. Existing small UI conveniences remain optional. Experimental upstream durable execution is not a drop-in dependency of this design.
