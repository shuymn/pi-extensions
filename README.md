# pi-extensions

Personal pi coding-agent extensions packaged as a standalone pi package.

## Requirements

- Bun matching `.bun-version`
- pi coding agent

## Setup

```bash
bun install
```

`postinstall` runs `lefthook install`.

## Use with pi

For local development, load this repository as a pi package path:

```bash
pi -e /path/to/pi-extensions
```

For persistent use, add the repository path or Git source to pi settings/packages. This repository declares its pi resources in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

## Local development

```bash
bun run fmt:check
bun run lint
bun run typecheck
bun run test
bun run check:fast
bun run check
```

`bun run check` is the full verification command used by CI and hooks.

## Repository layout

```text
extensions/    pi extension entrypoints and extension-local files
lib/           shared implementation helpers
tests/support/  shared test helpers
CONVENTIONS.md extension behavior and UI conventions
docs/          tooling, testing, and review notes
```

## Maintenance notes

- Add or change extension source under `extensions/**`.
- Put shared runtime helpers in `lib/**`.
- Put shared test-only helpers in `tests/support/**`.
- Keep extension runtime imports relative and package-local.
- Run `bun run check` after behavior or layout changes.
- This package is maintained for personal use; contributor onboarding files are intentionally omitted.
