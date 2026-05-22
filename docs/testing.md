# Testing Conventions

## Running Tests

- Use `bun run test` for the full test suite.
- Use `bun run check` for CI-equivalent verification.
- `bun run test` uses `bun test --pass-with-no-tests` so the template stays usable before project tests exist.

## Expectations

- Add tests as real project behavior appears; do not treat the template's empty baseline as a reason to skip future coverage.
- Keep tests deterministic and runnable through the same `bun run test` entrypoint used by hooks and CI.
- When adding specialized test commands, compose them underneath `bun run test` or `bun run check` instead of bypassing the main workflow.
