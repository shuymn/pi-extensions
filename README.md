# pi-extensions

Personal pi coding-agent extensions and prompt templates packaged as a standalone pi package.

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
- `ask-user-question` — Let the agent ask structured clarification questions sequentially.
- `codex-fast` — Control OpenAI Codex fast service tier with global settings persistence.
- `commandcode-provider` — Register the Command Code model provider with live model discovery and a fallback catalog.
- `commit` — Launch the existing `/skill:commit` as a bounded one-shot flow with `--commit`.
- `compact` — Let the agent request Pi context compaction at semantic checkpoints.
- `companion` — Control the Glimpse cursor companion overlay.
- `copy-file` — Add `/copy-file` to write the latest assistant message to `RESULT_<uuid>.md` in cwd.
- `create-pr` — Launch the existing `/skill:create-pr` as a bounded one-shot flow with `--create-pr`.
- `disable-model` — Hide configured providers or models from model selection.
- `dynamic-workflows` — Run deterministic subagent workflows, including packaged `review_flow` and `research_flow` presets.
- `fallback-model` — Switch to comma-separated fallback models on retryable model errors.
- `message-history` — Fuzzy-find previous user messages with `ctrl+r`.
- `prompt-stash` — Stash and restore the prompt buffer with `ctrl+s`.
- `sakana-ai-provider` — Register Sakana AI Fugu models through the OpenAI Responses API.
- `sakura-ai-engine-provider` — Register the Sakura AI Engine model provider.
- `session-title` — Generate a session title from the first user message.
- `statusline` — Replace the TUI footer with project, model, and context status.
- `subagents` — Spawn isolated subagent sessions for delegated work.
- `tavily` — Expose Tavily search, extract, map, crawl, and auth tools.
- `todo` — Manage branch-local todos for multi-step work.
- `tool-search` — Keep large tool groups deferred and activate matching tools through `search_tools`.
- `wt` — Add `/wt` to create a `git-wt` worktree and continue the current session there.

## Prompt templates

- `/plan [instructions]` — Investigate and write an agent-executable `PLAN.md` without starting implementation.
- `/impl [instructions]` — Implement `PLAN.md`, track progress with `todo`, and keep Japanese implementation notes.

These are standard Pi prompt templates under `prompts/`, enabled through `pi config`. `/impl` requires the `todo` extension. Arguments use Pi's standard `$ARGUMENTS` expansion; the old special handling of a leading `--` and the busy-session rejection are removed. While the agent is running, normal Pi message delivery applies.

## Migration to built-in features

Requires Pi 0.85.1 or later. `env` and `exit` have been removed, and `plan` is now a pair of prompt templates. Remove explicit paths to these old extensions from your Pi settings if configured; package-level discovery needs no path changes. If your package filter disables prompts, enable `/plan` and `/impl` with `pi config`.

Replace the former `PI_MODEL` environment variable or `env.PI_MODEL` extension setting with built-in defaults in `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`. For example, replace `openai-codex/gpt-5.6-sol:high` with these top-level settings:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.6-sol",
  "defaultThinkingLevel": "high"
}
```

Normal `/model`, `/thinking`, and cycling changes stay in the current session. Only an explicit Ctrl+S in the model or thinking selector saves a global startup default. Fresh sessions use the configured defaults; resumed sessions retain their saved model state. Project settings override global defaults, and per-model `modelThinkingLevels` settings take precedence over the global thinking default. For a one-run override, use `pi --model 'openai-codex/gpt-5.6-sol:high'`. Pi's shell-tool `PI_MODEL` variable is session metadata, not an extension startup setting.

Use `/quit` instead of `/exit`. Fullscreen mode prints a resume hint on exit; set `fullscreenExitOutput` to `"resume-hint"` to omit the transcript. The extension's regular-mode resume output and `PI_RESUME_COMMAND` override are no longer provided. Personal settings are not migrated automatically.

## Sakana AI provider

Set `SAKANA_API_KEY` before selecting one of these models:

- `sakana-ai/fugu`
- `sakana-ai/fugu-ultra`
- `sakana-ai/fugu-ultra-v1.1`
- `sakana-ai/fugu-ultra-v1.0`
- `sakana-ai/fugu-cyber`

`fugu-ultra` tracks the current Ultra release and currently aliases `fugu-ultra-v1.1`. `fugu-cyber` is access-gated and requires an approved application plus an API key whose billing mode is **Pay as you go**. Sakana dynamically prices `fugu` from the underlying model pool, and Pi does not expose the billable orchestration-token usage for Ultra or Cyber. Pi therefore cannot calculate these models' costs locally; a displayed `$0` means unknown, not free.

To allow Sakana streams to remain idle for up to two hours, merge this setting into `~/.pi/agent/settings.json`:

```json
{
  "httpIdleTimeoutMs": 7200000
}
```

This is a global Pi setting: it also extends every provider's HTTP header/body idle timeout and default request timeout.

After setting `SAKANA_API_KEY` outside your shell history, manually smoke-test the generally available models with:

```bash
for model in fugu fugu-ultra-v1.1 fugu-ultra-v1.0; do
  pi --print --no-session --model "sakana-ai/${model}:high" "Reply with only OK."
done
```

Approved users can test Cyber separately:

```bash
pi --print --no-session --model "sakana-ai/fugu-cyber:high" "Reply with only OK."
```

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
- `todo` imports `dynamic-workflows` review lifecycle events to suppress the todo widget while `review_flow` runs.
- `tool-search` keeps Tavily, `workflow`, and background subagent management tools deferred. `ask_user_question`, `compact_context`, `todo`, `spawn_subagent`, and `github_clone_workspace` remain active.
