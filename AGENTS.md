<!-- Keep under 30 instruction lines. Update inline when tooling changes. -->

## Core Principles
- Execute only what the user explicitly requested; do not add unrequested features.
- When requirements are ambiguous, ask one concise question before implementation.
- Prefer minimal, low-risk changes with clear rationale.
- Fix root causes; do not bypass checks, suppress errors, or skip failing verification.
- Do not run destructive git commands unless explicitly requested.
- Do not revert unrelated user changes.

## Runtime and Commands
- Use Bun for runtime, package management, scripts, and tests.
- Use `bun install` for dependencies.
- Use `bun run <script>` for project scripts.
- Use `bunx <tool>` for local CLIs (`biome`, `commitlint`, `tsc`).
- Prefer `rg` and `rg --files` for searching text/files.
- Keep `package.json` scripts as the single entrypoint for local commands, hooks, and CI.

## Pi Extension Rules
- Edit extension sources under `extensions/**`.
- Put shared runtime helpers under `lib/**` and shared test helpers under `tests/support/**`.
- Keep `package.json` `pi.extensions` aligned with the runtime resource layout.
- Do not add contributor-process files unless explicitly requested.
- Preserve Japanese human-facing TUI text and English LLM-facing metadata conventions from `CONVENTIONS.md`.

## Required Checks
- After code changes, run `bun run check`.
- Keep fast local verification green with `bun run check:fast`.
- Keep Biome clean with `bun run lint` and `bun run fmt:check`.
- Keep type safety green with `bun run typecheck`.
- Keep tests green with `bun run test`.
