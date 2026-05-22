# Testing Conventions

## Running Tests

- Use `bun run test` for the full test suite.
- Use `bun run check` for CI-equivalent verification.
- Tests are colocated with extension and helper sources as `*.test.ts`.
- `bun run test` runs each test file with `bun test` while excluding `node_modules`.

## Expectations

- Keep behavior covered at the extension boundary when adding or changing tools, commands, flags, lifecycle hooks, or UI behavior.
- Prefer deterministic fake pi/UI helpers from `test-support/**` over live pi sessions for unit tests.
- When adding specialized test commands, compose them under `bun run test` or `bun run check` instead of bypassing the main workflow.
