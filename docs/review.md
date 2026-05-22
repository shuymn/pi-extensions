# Review Guide

Prioritize behavior, safety, regressions, runtime package loading, and missing verification over style.

| Viewpoint | Check | Red Flags |
| --- | --- | --- |
| Pi package layout | Check that `package.json` `pi.extensions` matches the repository layout. | Runtime extensions exist outside declared resource paths; package loading requires undocumented flags. |
| Runtime behavior | Check extension tools, commands, flags, lifecycle events, and non-UI behavior. | UI-only code runs in headless mode; LLM-facing metadata is unclear; runtime imports depend on dotfiles paths. |
| Workflow parity | Check whether docs, hooks, CI, and local commands all invoke the same `bun run` entrypoints. | CI or hooks run commands that are not documented; direct tool invocations drift away from `package.json`. |
| Verification boundaries | Check that lightweight checks stay in `pre-commit` and full verification stays in `pre-push` / CI. | Expensive checks move into `pre-commit`; fast checks differ from CI without a stated reason. |
| Tests | Check that new behavior is covered through `bun run test` / `bun run check`. | Added runtime paths without test coverage or verification updates. |
