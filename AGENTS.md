<!-- Keep under 30 instruction lines. Update inline when tooling changes. -->
## Agent guidance
- No issue tracker is configured; see `docs/agents/issue-tracker.md`.
- Triage labels are unused; see `docs/agents/triage-labels.md`.
- This repo uses a single-context domain layout; see `docs/agents/domain.md`.
## Change boundaries
- Execute only what the user explicitly requested; do not add unrequested features.
- When requirements are ambiguous, ask one concise question before implementation.
- Prefer minimal, low-risk changes with clear rationale.
- Keep capabilities open by default. Enforce explicit user restrictions and demonstrated failure cases narrowly; prefer task instructions over speculative permission machinery.
- Review includes necessary fixes and verification unless the user explicitly requests no-fix; follow `skills/review/SKILL.md`.
- Fix root causes; do not bypass checks, suppress errors, or skip failing verification.
- Do not run destructive git commands unless explicitly requested.
- Do not revert unrelated user changes.
## Runtime and commands
- Use Bun for runtime, package management, scripts, and tests: `bun install`, `bun run <script>`, and `bunx <tool>` for local JS/TS CLIs (`biome`, `tsc`).
- Use installed `pommitlint` for commit message linting.
- Prefer `rg` and `rg --files` for searching text/files.
- Keep `package.json` scripts as the single entrypoint for local commands, hooks, and CI.
## Pi extensions
- Edit extension sources under `extensions/**`.
- Put shared runtime helpers under `lib/**` and shared test helpers under `tests/support/**`.
- Keep `package.json` `pi.extensions` aligned with the runtime resource layout.
- Do not add contributor-process files unless explicitly requested.
- Preserve Japanese human-facing TUI text and English LLM-facing metadata conventions from `docs/conventions.md`.
## Required checks
- After code changes, run `bun run check`.
- Keep `bun run check:fast`, `bun run lint`, `bun run fmt:check`, `bun run typecheck`, and `bun run test` green.
