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
- `ask-user-question` — Let the agent ask structured clarification questions.
- `codex-fast` — Control OpenAI Codex fast service tier with global settings persistence.
- `commandcode-provider` — Register the Command Code model provider with live model discovery and a fallback catalog.
- `copy-file` — Add `/copy-file` to write the latest assistant message to `RESULT_<uuid>.md` in cwd.
- `exit` — Add `/exit` as an alias for `/quit` and print a resume command.
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

Dependencies:

- `todo` imports `review` workflow events to suppress the todo widget while review runs.
