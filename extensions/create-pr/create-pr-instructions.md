# Create Pull Request on GitHub from Committed Changes

You are running the /create-pr extension. Create or update a GitHub pull request from committed changes.

This workflow uses Google Engineering Practices as an on-demand reference for higher-quality PRs.
Source: https://github.com/google/eng-practices (CC BY 3.0). The original reference files are
bundled under `{{ENG_PRACTICES_REFERENCE_ROOT}}`; read only the single relevant file when a
judgment is unclear, not the whole reference tree.

## Google Engineering Practices Reference Map

Translate Google-internal terms into GitHub terms in all user-facing output:

- CL/changelist = PR/pull request
- LGTM = approve
- submit = create/update/publish PR
- code health = repository maintainability and reviewer confidence

Use these reference files on demand:

- PR size and separability: `{{ENG_PRACTICES_REFERENCE_ROOT}}/review/developer/small-cls.md`
- PR title/body quality: `{{ENG_PRACTICES_REFERENCE_ROOT}}/review/developer/cl-descriptions.md`
- Self-review and reviewer navigation order: `{{ENG_PRACTICES_REFERENCE_ROOT}}/review/reviewer/navigate.md`
- What to look for in code changes: `{{ENG_PRACTICES_REFERENCE_ROOT}}/review/reviewer/looking-for.md`
- Blocking vs nit judgment and overall code health: `{{ENG_PRACTICES_REFERENCE_ROOT}}/review/reviewer/standard.md`
- Constructive review-comment style: `{{ENG_PRACTICES_REFERENCE_ROOT}}/review/reviewer/comments.md`
- Emergency exception handling: `{{ENG_PRACTICES_REFERENCE_ROOT}}/review/emergencies.md`

Do not summarize or rewrite the bundled references into new knowledge files. Keep the thin workflow
instructions here, and use the original source files only when needed.

## Tool Policy During This Workflow

- Use only inspection tools, `bash`, read-only subagents, and the temp-file helper for PR body files.
- Do not use direct file edit tools or workspace write tools.
- Tool choice priority: inspect committed changes with read-only commands first; write exactly one PR body file with `workflow_write_temp_file` only when ready to call `gh pr create/edit --body-file`; do not write patches or modify workspace files.
- `spawn_subagent` is read-only in this workflow.
- Shell commands are restricted to read-only inspection plus the workflow-required side effects: `git push`, `gh pr create`, and `gh pr edit`.
- When `--body-file` is needed, write the body with `workflow_write_temp_file`; do not create body files in the workspace.

## Scope

- Analyze committed changes only.
- Ignore uncommitted work except to warn the user that it will not be included.
- Requires a GitHub repository and GitHub authentication.
- Push the current branch before creating/updating the PR.
- Do not run tests, linters, formatters, typecheckers, builds, or other project verification commands. This workflow only publishes committed changes and creates/updates PR metadata. Summarize any verification evidence already present in committed history or explicit user notes; if missing, state that it was not run in this workflow. PR templates define structure only; they are not verification evidence.

## Additional User Notes Policy

Additional user notes are workflow instructions, not PR content by default.

- Use additional notes to decide scope, exclusions, emphasis, wording, or how to interpret the diff.
- Do not quote, paraphrase, or mention additional notes in the PR title/body merely because the user
  provided them.
- Exclusion instructions such as "ignore README" or "do not include local changes" are not
  verification evidence and must not appear in `Verification` / `確認内容`.
- Include additional-note content in the PR body only when it describes reviewer-relevant facts about
  the committed changes themselves, such as verified test results, deployment constraints, known
  risks, migrations, or intentional limitations.
- If an exclusion note affects committed changes in a way reviewers must know, describe the actual
  committed-change scope or risk without saying "the user instructed me to ignore...".

## Interactive Options

The extension asks for options interactively. The selected options shown in the prompt are authoritative.

Language:

- English: create PR title/body in English.
- Japanese: create PR title/body in Japanese.

Mode:

- Create: create a new PR.
- Update: update an existing open PR for the current branch. If no PR exists, notify the user and do not create a new one.

Base branch:

- In create mode, use the selected base branch.
- In update mode, use the existing PR's base branch.

## Required Context Commands

Verify git/GitHub state with live commands before creating or updating:

```bash
git branch --show-current
git branch -r
git symbolic-ref --short refs/remotes/origin/HEAD
git rev-parse --show-toplevel
git status -sb
```

For committed changes, replace `<base>` with the selected base branch or existing PR base:

```bash
git log origin/<base>..HEAD --oneline
git rev-list --count origin/<base>..HEAD
git diff --name-status origin/<base>..HEAD
git diff --shortstat origin/<base>..HEAD
git diff origin/<base>..HEAD
git log origin/<base>..HEAD --format="### %s%n%n%b%n"
git log origin/<base>..HEAD --format="%an <%ae>"
```

PR templates:

```bash
cat .github/pull_request_template.md
cat .github/PULL_REQUEST_TEMPLATE.md
```

If neither template file exists, continue without a template.

Project information:

```bash
head -50 README.md
```

If README.md does not exist, continue without README context.

## Analyze Committed Changes

- Review all commits between current branch and base branch.
- Understand intent from commit messages and diff.
- Identify types and scope of changes.
- Check for breaking changes.
- Classify commits as feature, fix, refactor, docs, chore, etc.
- Notify the user if there are no commits between the current branch and base.
- Check whether the PR is one small, self-contained change. If unrelated feature work,
  refactoring, formatting, or dependency churn is mixed together, explain that risk in the most
  appropriate existing PR template section instead of hiding it.
- Read the complete diff before writing the final PR metadata. You should be able to explain every
  changed file's role in the PR.
- If the committed changes reveal what changed but not why it matters, ask the user for the missing
  motivation before writing the final PR body. Prefer `ask_user_question` for concise structured
  clarification, and include an option that lets the user say the motivation is intentionally
  obvious or should be omitted.

## Pre-Publish Self-Review

Before writing the final PR title/body and calling `gh pr create/edit`, review the committed diff as
if you were the reviewer. This is a metadata and readiness review only; do not modify files or run
project verification commands.

First check the whole change. If a blocking issue would make the PR misleading or unsafe to publish,
stop and ask the user how to proceed instead of creating/updating the PR. Examples: no commits to
include, wrong base branch, committed secrets, clearly broken generated PR scope, or a diff whose
intent cannot be explained from commits plus user notes.

Then apply this checklist:

- [ ] The PR has one clear purpose and the selected base branch makes sense.
- [ ] Feature changes, refactors, formatting-only edits, generated files, and docs updates are not
      mixed in a way that hides review risk; if they are mixed, the PR body explains it plainly.
- [ ] The complete diff has been read, and every changed file's role in the PR can be explained.

Classify self-review findings as:

- Blocking: publishing would mislead reviewers, include the wrong changes, hide serious risk, or
  violate this workflow's safety rules. Stop and report the issue.
- Nit: optional wording or polish. Do not block PR creation/update only for nits; improve the PR
  metadata directly when possible.

## PR Title and Body Format

- Use a short imperative PR title, not a vague label such as "Fix bug" or "Update files".
- Optimize the body for reviewer understanding, not implementation detail. Prefer why, user-visible
  or reviewer-relevant what, risks, and verification. Avoid explaining how the code works when the
  diff already makes it clear.
- Do not invent a motivation. If commit messages, diff context, README/project context, and
  additional notes do not make the why clear enough for `Summary` / `概要`, ask the user before
  creating or updating the PR.
- Keep the body concise. Do not include exhaustive file lists, commit-by-commit summaries,
  implementation walkthroughs, or mechanical checklist items unless the repository template requires
  them.
- The testing section must contain only verification evidence from commit history or explicit user
  notes, or clearly say it was not run in this workflow.
- Breaking changes, migrations, release steps, or docs impacts must be explicitly called out.
- File paths, symbols, and `@` references must be escaped or formatted so GitHub will not create
  accidental mentions.

- If `.github/pull_request_template.md` or `.github/PULL_REQUEST_TEMPLATE.md` exists, follow it strictly.
- Fill sections based on committed changes only.
- Delete empty sections when appropriate.
- Maintain checklist format (`- [ ]`).
- If no template exists, use the standard format below.

## Standard Format (English)

```markdown
## Summary

[1-3 sentences describing the essential change and why it matters]

## Changes

- [Reviewer-relevant change, not an implementation walkthrough]
- [Only include additional bullets when they add review value]

## Risks / Notes

- [Breaking changes, migrations, rollout notes, mixed-change risk, or important trade-offs]
- [If none: None]

## Verification

[Existing verification evidence from committed history or explicit user notes]
[If no evidence is available: Not run in this workflow]
```

## Standard Format (Japanese)

```markdown
## 概要

[本質的な変更とその理由を1-3文で説明]

## 変更内容

- [レビュアーにとって重要な変更。実装手順の説明は避ける]
- [レビュー価値がある場合だけ追加する]

## リスク / 補足

- [破壊的変更、移行、リリース注意点、変更混在のリスク、重要なトレードオフ]
- [ない場合: なし]

## 確認内容

[コミット履歴または明示的なユーザーメモにある既存の確認内容]
[確認内容がない場合: このワークフローでは未実行]
```

## Writing Guidelines

English:

- Use clear, concise English.
- Keep code references and file paths as-is.
- Be direct and professional.
- Wrap @ symbols in code/paths with backticks to prevent mentions: `@import`, `path/@file`.

Japanese:

- Use appropriate technical Japanese.
- Keep English proper nouns, libraries, functions, and paths as-is.
- Use clear Japanese without honorifics.
- Use ですます調 for paragraph-style sentences.
- For bullet points, use だ・である調 or noun-ending style (体言止め).
- Omit final punctuation in bullet points (no `。`).

Escaping:

- Prefer `gh pr create --body-file <file>` and `gh pr edit --body-file <file>` to avoid shell escaping issues.
- Create `<file>` with `workflow_write_temp_file`; it must be under the OS temp directory, not the workspace.
- Do not use heredocs or shell redirection for PR bodies in this workflow.
- Do not escape Markdown backticks unnecessarily.

## Create Flow

1. Determine current branch:
    ```bash
    git branch --show-current
    ```
2. Use the selected base branch.
3. Ensure there are commits to include:
    ```bash
    git log origin/<base>..HEAD --oneline
    ```
4. Push current branch:
    ```bash
    git push -u origin <current-branch>
    ```
5. Generate PR title and body from committed changes.
6. Create the PR, preferably with GitHub CLI:
    ```bash
    gh pr create --base <base> --head <current-branch> --title "<title>" --body-file <body-file>
    ```
7. Provide the PR URL and summarize success.

## Update Flow

1. Determine current branch:
    ```bash
    git branch --show-current
    ```
2. Find the existing open PR for the current branch:
    ```bash
    gh pr view --json number,url,baseRefName,headRefName,title,state
    ```
    If no open PR exists, notify the user and do not create a new PR.
3. Push latest changes:
    ```bash
    git push origin <current-branch>
    ```
4. Analyze all commits against the PR's base branch.
5. Generate updated title and body from committed changes.
6. Update the PR:
    ```bash
    gh pr edit <number> --title "<title>" --body-file <body-file>
    ```
7. Provide the PR URL and summarize success.

## Important Notes

- In create mode, create a new PR.
- In update mode, update an existing PR only; do not create a new PR if none exists.
- Do not claim tests, lint, formatting, typechecking, or builds were run unless the committed history or explicit user notes provide that evidence. PR templates are structure/context only, not verification evidence.
- Explain errors clearly.
- Ask the user when you need clarification about commit inclusion, categorization, or ambiguous PR content.
