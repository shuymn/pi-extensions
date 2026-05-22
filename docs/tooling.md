# Tooling Pipeline

## Source of Truth

- Use `bun run <script>` as the single interface for local development, hooks, and CI.
- `package.json` is the source of truth for repository scripts and verification composition.
- Keep shared GitHub workflow refs aligned to a single `shuymn/github-actions` commit.

## Verification Stages

- `bun run check:fast` is the lightweight local verification path for formatting, linting, and type checking.
- `bun run check` is the CI-equivalent verification path and includes tests.
- `pre-commit` owns auto-fixes and lightweight verification. `pre-push` owns `bun run check`.

## Adding or Changing Tools

1. Pin the dependency in `package.json`.
2. Expose the tool through a `bun run` script instead of invoking it directly from docs, hooks, or CI.
3. Keep hook and CI commands thin wrappers around the same scripts.
4. Update this file and `AGENTS.md` when the workflow changes.
