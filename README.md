# pi-extensions

Personal pi coding-agent extensions and prompt templates. Requires Pi 0.85.1 or later.

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
- `commandcode-provider` — Register the Command Code model provider with live model discovery and a fallback catalog.
- `commit` — Launch `/skill:commit` as a one-shot flow with `--commit`.
- `compact` — Manage context compaction and explicit Goal continuation.
- `companion` — Control the Glimpse cursor companion overlay.
- `copy-file` — Save the latest assistant message to `RESULT_<uuid>.md` in cwd with `/copy-file`.
- `create-pr` — Launch `/skill:create-pr` as a one-shot flow with `--create-pr`.
- `disable-model` — Hide configured providers or models from model selection.
- `dynamic-workflows` — Run subagent workflows, including `review_flow` and `research_flow` presets.
- `fallback-model` — Switch to fallback models on retryable model errors.
- `message-history` — Fuzzy-find previous user messages with `ctrl+r`.
- `prompt-stash` — Stash and restore the prompt buffer with `ctrl+s`.
- `sakana-ai-provider` — Register Sakana AI Fugu models through the OpenAI Responses API.
- `sakura-ai-engine-provider` — Register the Sakura AI Engine model provider.
- `session-title` — Generate a session title from the first user message.
- `statusline` — Replace the TUI footer with project, model, and context status.
- `subagents` — Spawn isolated subagent sessions for delegated work.
- `tavily` — Expose Tavily search, extract, map, crawl, and auth tools.
- `tool-search` — Activate deferred tool groups through `search_tools`.
- `wt` — Create a `git-wt` worktree and continue the current session there with `/wt`.

## Prompt templates

Enable these templates from `prompts/` through `pi config`:

- `/plan [instructions]` — Investigate and write an agent-executable `PLAN.md` without starting implementation.
- `/impl [instructions]` — Implement `PLAN.md` and keep Japanese implementation notes.

## One-shot flows

`commit` and `create-pr` launch their corresponding installed skills and exit after the agent run. Both require the `ask-user-question` extension.

```bash
pi --no-session --commit
pi --no-session --create-pr --japanese
```

Session and model flags can be added as needed.

| Flag | Usage |
| --- | --- |
| `--english` / `--japanese` | Select the output language. |
| `--branch` | Create a branch for `--commit`. |
| `--update` | Update an existing PR with `--create-pr`. |
| `--base <branch>` | With `--commit`, requires `--branch`. With `--create-pr`, cannot be combined with `--update`. |

Non-flag CLI arguments are appended to the skill prompt.

## Goals and compaction

The `compact` extension manages context compaction and automatic continuation toward an explicit Goal.

```text
/goal start Fix the bug | Regression test passes | Required checks pass
/goal status
/goal stop
/goal resume
```

- Separate the objective and each completion condition with `|`.
- Only user-issued `start` and `resume` enable automatic continuation. Both require an idle session without queued input.
- Required input or approval pauses continuation. Answer, then run `/goal resume`.
- Esc or `/goal stop` cancels pending continuation. `/goal stop` also cancels pending compaction.
- Reload, session resume, fork, and tree navigation do not restart automatic continuation; use `/goal resume`.
- Each start/resume allows at most 20 automatic follow-up runs, including those after compaction. This does not limit tool calls or time within a run, and reaching the limit is not completion.

The agent can request compaction with `compact_context`. A successful request continues the current work once even without an active Goal; it does not reactivate an old Goal. `stopAfterCompaction` stops continuation and pauses the Goal. The standard `/compact` command does not itself authorize automatic continuation.

Keep Pi's standard `compaction.enabled: true` as a safety net. Compaction failures and unrecoverable model errors stop execution.

## Sakana AI provider

Set `SAKANA_API_KEY` before selecting a model:

- `sakana-ai/fugu`
- `sakana-ai/fugu-ultra`
- `sakana-ai/fugu-ultra-v1.1`
- `sakana-ai/fugu-ultra-v1.0`
- `sakana-ai/fugu-cyber`

`fugu-ultra` tracks the current Ultra release, currently `fugu-ultra-v1.1`. Cyber requires an approved application and an API key with **Pay as you go** billing.

Pi cannot calculate these models' costs locally because of dynamic pricing or unavailable orchestration-token usage. A displayed `$0` means unknown, not free.

To allow streams to remain idle for up to two hours, merge this into `~/.pi/agent/settings.json`:

```json
{
  "httpIdleTimeoutMs": 7200000
}
```

This global setting extends HTTP header/body idle timeouts and the default request timeout for **all providers**.
