# pi-extensions

個人用の pi coding-agent extensions をまとめた standalone pi package です。

## 使い方

これらの extensions は自分の個人利用に最適化されています。そのため、そのまま使うより pi にベースとして渡し、自分の workflow 向けに調整した extension を作ってもらうのがおすすめです。
他人がそのまま使うことを想定していないため、破壊的変更や削除は積極的に行います。また、進捗表示や status UI は日本語のみサポートします。

```text
https://github.com/shuymn/pi-extensions/tree/main/extensions/<extension-name> をベースに、自分の workflow 向けの pi extension を作ってください。
```

利用可能な extension は `extensions/` 配下にあります。

## 利用可能な extensions

- `add-dir` — 現在のセッションに追加の workspace directory を登録します。
- `ask-user-question` — エージェントが構造化された確認質問を行えるようにします。
- `coderabbit-review` — CodeRabbit review を実行し、検証済みの修正をキューします。
- `commit` — 対話式の commit workflow を実行して pi を終了します。
- `create-pr` — 対話式の pull request workflow を実行して pi を終了します。
- `exit` — `/quit` の alias として `/exit` を追加し、resume command を表示します。
- `message-history` — `ctrl+r` で過去の user messages を fuzzy find します。
- `plan` — `/plan` と `/impl` の workflow prompts を追加します。
- `prompt-stash` — `ctrl+s` で prompt buffer を stash / restore します。
- `research` — staged deep-research workflows と Tavily Research escalation を実行します。
- `review` — multi-phase code review workflow を実行します。
- `session-title` — 最初の user message から session title を生成します。
- `simplify` — 変更済みまたは最近の code に対して simplification reviews を実行します。
- `statusline` — TUI footer を project、model、context status 表示に置き換えます。
- `subagents` — delegated work 用に isolated subagent sessions を起動します。
- `tavily` — Tavily search、extract、map、crawl、auth tools を追加します。
- `todo` — multi-step work 用の branch-local todos を管理します。

依存関係:

- `todo` は review 実行中に todo widget を抑制するために `review` workflow events を import します。
