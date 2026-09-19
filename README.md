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

- `abliteration-provider` — Use abliteration.ai with an API key saved through Pi's `/login`.
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
