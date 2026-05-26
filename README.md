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

## Available extensions

- `add-dir` — Register extra workspace directories for the current session.
- `ask-user-question` — Let the agent ask structured clarification questions.
- `exit` — Add `/exit` as an alias for `/quit` and print a resume command.
- `message-history` — Fuzzy-find previous user messages with `ctrl+r`.
- `plan` — Add `/plan` and `/impl` workflow prompts.
- `prompt-stash` — Stash and restore the prompt buffer with `ctrl+s`.
- `research` — Run staged deep-research workflows and Tavily Research escalation.
- `review` — Run the multi-phase code review workflow.
- `session-title` — Generate a session title from the first user message.
- `simplify` — Run simplification reviews over changed or recent code.
- `statusline` — Replace the TUI footer with project, model, and context status.
- `subagents` — Spawn isolated subagent sessions for delegated work.
- `tavily` — Expose Tavily search, extract, map, crawl, and auth tools.
- `todo` — Manage branch-local todos for multi-step work.

Dependencies:

- `todo` imports `review` workflow events to suppress the todo widget while review runs.
