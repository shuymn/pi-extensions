# bun-template

<!-- template:start -->
Minimal Bun template with:

- `package.json` scripts as the single entrypoint for local commands, hooks, and CI
- Biome linting and formatting
- Lefthook automation for `pre-commit`, `pre-push`, and `commit-msg`
- Shared GitHub Actions workflows from [`shuymn/github-actions`](https://github.com/shuymn/github-actions)
- Starter docs for repository tooling, testing, and review expectations
<!-- template:end -->

## Local Setup

```bash
bun install
```

`postinstall` runs `lefthook install` automatically.

## Initial Customization

1. Run template initialization from the repository root. This updates the package name, refreshes shared workflows, removes the template-only README block, deletes the init script itself, and creates a local commit.

```bash
./scripts/init-template.sh [new-package-name]
```

If `new-package-name` is omitted, the script derives it from the `origin` remote basename.

2. Replace [`src/index.ts`](src/index.ts) with your actual application entrypoint and package layout.
3. Rewrite this README with your project's purpose, setup, development workflow, and release information.
4. Review [`AGENTS.md`](AGENTS.md) and [`docs/`](docs/) and keep only the guidance you want in this repository.
5. Run `bun run check` before your first project-specific commit.

This repository was initialized from a Bun project template.

Replace this README with project-specific documentation once the repository has a clear purpose, setup flow, and release process.

## Local Development

Useful commands:

```bash
bun run lint
bun run lint:fix
bun run fmt:check
bun run fmt:fix
bun run typecheck
bun run test
bun run check:fast
bun run check
```

## Suggested README Sections

When you rewrite this file, include only the sections your project actually needs, for example:

- Project overview
- Requirements
- Setup
- Local development commands
- Testing
- Deployment or release process
- Repository layout
- Links to deeper docs if needed
