# Domain Docs

This repository uses a single-context domain layout.

## Layout

- Domain glossary: `CONTEXT.md` at the repository root.
- ADRs: `docs/adr/` at the repository root, created only when a decision meets the ADR threshold.
- Context map: not used. There is no `CONTEXT-MAP.md`.

## Consumer rules

Engineering skills that need domain context should read `CONTEXT.md` before making design, architecture, diagnosis, or TDD decisions.

`CONTEXT.md` is a glossary only. Treat it as the canonical language for the repo, not as an implementation spec or task plan.

Read ADRs from `docs/adr/` when the directory exists. ADRs record hard-to-reverse, surprising, trade-off-driven decisions; absence of an ADR means no such decision has been recorded yet.
