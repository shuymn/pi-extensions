# Review Guide

Prioritize behavior, safety, regressions, and missing verification over style.

| Viewpoint | Check | Red Flags |
| --- | --- | --- |
| Script and workflow parity | Check whether docs, hooks, CI, and local commands all invoke the same `bun run` entrypoints. | CI or hooks run commands that are not documented; direct tool invocations drift away from `package.json`. |
| Template lifecycle | Check initialization, self-removal, and post-init repository state. | Template-only artifacts remain accidentally; init mutates tracked files without a clear cleanup path; setup refs are hardcoded in multiple places. |
| Verification boundaries | Check that lightweight checks stay in `pre-commit` and full verification stays in `pre-push` / CI. | Expensive checks move into `pre-commit`; fast checks differ from CI without a stated reason. |
| Shared workflow refs | Check that all `shuymn/github-actions` workflow refs are pinned to one commit. | Mixed SHAs across workflow files; `security.yml` points at the wrong shared workflow. |
| Tests | Check that new behavior is covered through `bun run test` / `bun run check`. | Added runtime paths without test coverage or verification updates. |
