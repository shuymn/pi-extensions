# pi-extensions

Personal pi coding-agent extensions packaged as a standalone pi package.

[日本語版](./README.ja.md)

## Usage

These extensions are optimized for my personal workflow, so the recommended path is to ask pi to use one as a base and adapt it for you.
I actively make breaking changes and remove things, and progress/status UI is only supported in Japanese because this repository is not designed for other people's direct use.

```text
Use https://github.com/shuymn/pi-extensions/tree/main/extensions/<extension-name> as a base and create a pi extension tailored to my workflow.
```

Available extensions live under `extensions/`.

To install only the extensions you need, install the package and then run `pi config` to enable or disable individual resources.

```bash
pi install https://github.com/shuymn/pi-extensions
pi config
```

## Available extensions

- `add-dir` — Register extra workspace directories for the current session.
- `agmsg-pi` — Send and receive local messages between pi sessions.
- `ask-user-question` — Let the agent ask structured clarification questions.
- `codex-fast` — Control OpenAI Codex fast service tier with global settings persistence.
- `commit` — Launch the existing `/skill:commit` as a bounded one-shot flow with `--commit`.
- `create-pr` — Launch the existing `/skill:create-pr` as a bounded one-shot flow with `--create-pr`.
- `commandcode-provider` — Register the Command Code model provider with live model discovery and a fallback catalog.
- `copy-file` — Add `/copy-file` to write the latest assistant message to `RESULT_<uuid>.md` in cwd.
- `exit` — Add `/exit` as an alias for `/quit` and print a resume command.
- `fallback-model` — Switch to comma-separated fallback models on retryable model errors.
- `message-history` — Fuzzy-find previous user messages with `ctrl+r`.
- `plan` — Add `/plan` and `/impl` workflow prompts.
- `prompt-stash` — Stash and restore the prompt buffer with `ctrl+s`.
- `research` — Run staged deep-research workflows and Tavily Research escalation.
- `review` — Run the multi-phase code review workflow.
- `sakura-ai-engine-provider` — Register the Sakura AI Engine model provider.
- `session-title` — Generate a session title from the first user message.
- `statusline` — Replace the TUI footer with project, model, and context status.
- `subagents` — Spawn isolated subagent sessions for delegated work.
- `tavily` — Expose Tavily search, extract, map, crawl, and auth tools.
- `todo` — Manage branch-local todos for multi-step work.
- `vertex-claude-provider` — Register Claude models served through Google Vertex AI.
- `wt` — Add `/wt` to create a `git-wt` worktree and continue the current session there.

## One-shot flows

Use caller-provided session and model flags, then add a one-shot flag to launch a skill and exit after the agent run:

```bash
pi \
  --no-session \
  --no-session-title \
  --model 'opencode-go/deepseek-v4-flash:high' \
  --fallback-model 'commandcode/deepseek/deepseek-v4-flash,deepseek/deepseek-v4-flash' \
  --commit
```

```bash
pi \
  --no-session \
  --no-session-title \
  --model 'opencode-go/deepseek-v4-flash:high' \
  --fallback-model 'commandcode/deepseek/deepseek-v4-flash,deepseek/deepseek-v4-flash' \
  --create-pr --japanese
```

Shared optional flags: `--english`/`--japanese` and `--base <branch>`. `--base` requires `--branch` with `--commit`, and cannot be used with `--update` for `--create-pr`. Commit-only flag: `--branch`. Create-pr-only flag: `--update`. Non-flag free-form CLI arguments are appended to the launched skill prompt.

Dependencies:

- `commit` and `create-pr` require `ask-user-question` because these one-shot flows launch only when the `ask_user_question` LLM Tool is available.
- `todo` imports `review` workflow events to suppress the todo widget while review runs.
