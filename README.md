# pi-extensions

Personal pi coding-agent extensions, skills, and prompt templates. Requires Pi 1.0.0 or later.

[日本語版](./README.ja.md)

## Usage

These extensions are optimized for my personal workflow. Breaking changes and removals are common, and progress/status UI is Japanese-only. Rather than using them unchanged, ask pi to adapt an extension for your workflow:

```text
Use https://github.com/shuymn/pi-extensions/tree/main/extensions/<extension-name> as a base and create a pi extension tailored to my workflow.
```

To use the package directly, install it and enable only the resources you need with `pi config`:

```bash
pi install https://github.com/shuymn/pi-extensions
pi config
```

## Available extensions

- `add-dir` — Register extra workspace directories for the current session.
- `ask-user-question` — Let the agent ask structured clarification questions sequentially.
- `commandcode-provider` — Register Command Code with Pi-managed model refresh and a fallback catalog.
- `companion` — Control the Glimpse cursor companion overlay.
- `copy-file` — Save the latest assistant message to `RESULT_<uuid>.md` in cwd with `/copy-file`.
- `fallback-model` — Provide the explicitly selected `fallback/auto` virtual model for native request retries.
- `goal` — Continue an explicitly user-started objective through Pi's native pre-settlement boundary.
- `message-history` — Fuzzy-find previous user messages with `ctrl+r`.
- `one-shot` — Run an installed commit or PR skill with native tools, human interaction when needed, and automatic exit.
- `openai-fast` — Control the OpenAI Responses fast service tier with `/openai-fast [on|off|toggle|status]` and global settings persistence. Existing `codex-fast.enabled` settings are retained until overridden by `openai-fast.enabled`.
- `prompt-stash` — Stash and restore the prompt buffer with `ctrl+s`.
- `review` — Review repository changes with independent inspection, validated repairs, and verification; `--no-fix` selects report-only review.
- `session-title` — Generate a session title from the first user message.
- `statusline` — Replace the TUI footer with the colored one-line project, branch, model, thinking level, OpenAI fast indicator, context usage, and timing display. Opting in hides the standard footer's other statistics and extension statuses.
- `subagents` — Delegate work with inherited capabilities, explicit optional restrictions, structured results, and foreground/background controls.
- `tavily` — Expose CLI-backed Tavily search, extract, map, crawl, and auth tools with structured JSON for codemode.
- `wt` — Create a `git-wt` worktree and continue the current session there with `/wt`.

## Skills and execution

Enable `skills/review` and `skills/research` through `pi config`. Review uses the `review` extension; research uses Tavily and optionally subagents. Procedures live in skills, tool composition in native codemode, and retry/compaction in Pi.

- Review includes fixes and verification by default. Use `/review [files | --staged | --base ref | --pr selector]`, or invoke the review skill/tool; `--no-fix` / `noFix: true` requests inspection only. No `/review-fix` handoff is needed. Repair uses normal local tools and continues through in-scope check failures; related regression tests are allowed. Failed or unrun verification is unresolved, not `fixed`. Fresh scope/PR checks still prevent stale repairs, and commits/publication need separate authorization. Run controls are session-local; reports remain in session entries.
- Research uses cited retrieved evidence. Delegation normally inherits read-only capabilities; narrow tools or collection budgets only for explicit constraints or concrete task requirements. Evidence gaps can trigger focused follow-up collection.
- `spawn_subagent` inherits the caller's available tools and accepts explicit `allowedTools`, `readOnly`, and an optional result `schema`. Restrictions apply to descendants too. Read-only bash protects the repository, not the entire host or network. Background completion records a result without starting another parent turn.
- `/goal start objective | completion condition [| condition]` starts autonomous work. `/goal stop` pauses it; `/goal resume` explicitly reauthorizes it. Abort, human input, and session changes revoke continuation. The `goal` tool cannot start or resume it.
- Select fallback explicitly, for example `pi --model fallback/auto --fallback-model 'provider/primary,provider/backup:high'`. Candidates include the primary model and may send context to different providers. Failures use Pi's native retry eligibility and budget; if the sticky model disappears, continuation can select another configured available candidate. The task is not restarted. This router is available in delegated sessions; arbitrary foreign routers are not cloned.

### One-shot runs

Enable `one-shot` and separately install the `commit` / `create-pr` skills you want to use; they are not bundled here. Use a new session with configured model authentication. Enable `ask-user-question` and use TUI or RPC when actual human input is needed; interaction-free work also supports headless execution.

```bash
pi --commit -- "Commit the requested changes"
pi --commit --branch --base main --japanese
pi --create-pr --base main --english
pi --create-pr --update
```

Free input follows `--`; no positional message may start with `/`, including later messages and absolute paths. Prefix paths with words, for example `pi --commit -- "Target: /path/to/repo"`. Slash-leading input is rejected during extension loading, before CLI command dispatch. `@file` and resumed sessions are not supported. One-shot preserves Pi's selected tools, deferred discovery, and nested execution rather than imposing a fixed allowlist. In-scope repair and verification are allowed; actual human answers or live instructions can provide additional authorization. Interaction-free work can run without UI or a questionnaire tool; missing required input and cancelled questionnaires are blockers, not consent. Commit and PR-publication defaults remain separate. Native tools retain the user's OS permissions and are not a shell sandbox.

## Prompt templates

Enable these templates from `prompts/` through `pi config`:

- `/plan [instructions]` — Investigate and write an agent-executable `PLAN.md` without starting implementation.
- `/impl [instructions]` — Implement `PLAN.md` and keep Japanese implementation notes.
