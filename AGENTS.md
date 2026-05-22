<!-- Keep under 30 instruction lines. Update inline when tooling changes. -->

## Core Principles
- Execute only what the user explicitly requested; do not add unrequested features.
- When requirements are ambiguous, ask one concise question before implementation.
- Prefer minimal, low-risk changes with clear rationale.
- Never hardcode secrets; use environment variables or constants.
- Fix root causes; do not bypass checks or suppress errors.
- Do not run destructive git commands unless explicitly requested.
- Do not revert unrelated user changes.

## Runtime and Commands
- Use Bun for runtime, package management, scripts, and tests.
- Use `bun install` for dependencies.
- Use `bun run <script>` for project scripts.
- Use `bunx <tool>` for local CLIs (`biome`, `commitlint`, `tsc`).
- Bun loads `.env` automatically; do not add `dotenv`.
- Prefer `rg` and `rg --files` for searching text/files.
- Keep `package.json` scripts as the single entrypoint for local commands, hooks, and CI.

## Required Checks
- After code changes, run `bun run check`.
- Keep fast local verification green with `bun run check:fast`.
- Keep Biome clean with `bun run lint` and `bun run fmt:check`.
- Keep type safety green with `bun run typecheck`.
- Keep tests green with `bun run test`.
- Never skip a failing check; fix the underlying issue.

## Git and Hooks
- Respect lefthook hooks (`pre-commit`, `pre-push`, `commit-msg`).
- `pre-commit` owns auto-fixes and lightweight verification; `pre-push` owns full verification via `bun run check`.
- Commit messages must pass commitlint (Conventional Commits).
- Keep commits and pull requests focused and small.

## Documentation

- `docs/review.md` — review conventions and checklist viewpoints.
- `docs/testing.md` — test conventions and running tests.
- `docs/tooling.md` — verification pipeline and adding tools.

## Template Scope
- This template provides only development tooling scaffolding.
- Feature architecture and domain-specific design docs are intentionally out of scope.
