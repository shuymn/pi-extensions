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
- `codex-fast` — Control OpenAI Codex fast service tier with global settings persistence.
- `commandcode-provider` — Register Command Code with Pi-managed model refresh and a fallback catalog.
- `companion` — Control the Glimpse cursor companion overlay.
- `copy-file` — Save the latest assistant message to `RESULT_<uuid>.md` in cwd with `/copy-file`.
- `fallback-model` — Provide the explicitly selected `fallback/auto` virtual model for native request retries.
- `goal` — Continue an explicitly user-started objective through Pi's native pre-settlement boundary.
- `message-history` — Fuzzy-find previous user messages with `ctrl+r`.
- `one-shot` — Run an installed commit or PR skill interactively with a restricted tool set and automatic exit.
- `prompt-stash` — Stash and restore the prompt buffer with `ctrl+s`.
- `review` — Inspect repository changes with bounded read-only delegation, coverage receipts, and separately authorized fixes.
- `session-title` — Generate a session title from the first user message.
- `statusline` — Replace the TUI footer with the colored one-line project, branch, model, thinking level, Codex fast indicator, context usage, and timing display. Opting in hides the standard footer's other statistics and extension statuses.
- `subagents` — Delegate work with explicit tool limits, optional structured results, and foreground/background controls.
- `tavily` — Expose CLI-backed Tavily search, extract, map, crawl, and auth tools with structured JSON for codemode.
- `wt` — Create a `git-wt` worktree and continue the current session there with `/wt`.

## Skills and execution

Enable `skills/review` and `skills/research` through `pi config`. Review uses the `review` extension; research uses Tavily and optionally subagents. Procedures live in skills, tool composition in native codemode, and retry/compaction in Pi.

- Review defaults to inspection. After inspecting the findings, `/review-fix <runId>` authorizes one local fix attempt for that exact run. Fixes require complete validation and an unchanged scope; PR fixes also require a fresh matching HEAD and clean checkout. The child can edit only reviewed files, without shell or network tools. `fixed` does not mean tests passed: unrun checks must be reported and verification performed separately. Run controls are session-local; reports remain in session entries.
- Research uses cited retrieved evidence. A delegated collector can be limited to Tavily; synthesis can use `allowedTools: []`. Source/round limits are not spending limits.
- `spawn_subagent` accepts `allowedTools`, `readOnly`, and an optional result `schema`. Restrictions apply to descendants too. Read-only bash protects the repository, not the entire host or network. Background completion records a result without starting another parent turn.
- `/goal start objective | completion condition [| condition]` starts autonomous work. `/goal stop` pauses it; `/goal resume` explicitly reauthorizes it. Abort, human input, and session changes revoke continuation. The `goal` tool cannot start or resume it.
- Select fallback explicitly, for example `pi --model fallback/auto --fallback-model 'provider/primary,provider/backup:high'`. Candidates include the primary model and may send context to different providers. Only Pi-eligible request retries can advance the route; the task is not restarted. This router is available in delegated sessions; arbitrary foreign routers are not cloned.

### Interactive one-shot runs

Enable `one-shot` and `ask-user-question`, and separately install the `commit` / `create-pr` skills you want to use. These two skills are not bundled here. A new TUI or RPC session with configured model authentication is required.

```bash
pi --commit -- "Commit the requested changes"
pi --commit --branch --base main --japanese
pi --create-pr --base main --english
pi --create-pr --update
```

Free input follows `--`; no positional message may start with `/`, including later messages and absolute paths. Prefix paths with words, for example `pi --commit -- "Target: /path/to/repo"`. Slash-leading input is rejected during extension loading, before CLI command dispatch. `@file` and resumed sessions are not supported. Allowed tools are `read`, `bash`, `grep`, `find`, `ls`, and `ask_user_question`, including nested execution. Questions remain interactive; missing skills, unavailable UI, and cancelled questionnaires fail closed. Commit mode authorizes local commits only; PR mode publishes existing commits and does not create new ones. Bash retains the user's OS permissions: the tool allowlist is not a shell sandbox.

## Prompt templates

Enable these templates from `prompts/` through `pi config`:

- `/plan [instructions]` — Investigate and write an agent-executable `PLAN.md` without starting implementation.
- `/impl [instructions]` — Implement `PLAN.md` and keep Japanese implementation notes.
