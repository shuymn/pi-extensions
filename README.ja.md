# pi-extensions

個人用の pi coding-agent extensions をまとめた standalone pi package です。

## 使い方

これらの extensions は自分の個人利用に最適化されています。そのため、そのまま使うより pi にベースとして渡し、自分の workflow 向けに調整した extension を作ってもらうのがおすすめです。
他人がそのまま使うことを想定していないため、破壊的変更や削除は積極的に行います。また、進捗表示や status UI は日本語のみサポートします。

```text
https://github.com/shuymn/pi-extensions/tree/main/extensions/<extension-name> をベースに、自分の workflow 向けの pi extension を作ってください。
```

利用可能な extension は `extensions/` 配下にあります。

必要な extension だけを使いたい場合は、package を install したあとに `pi config` で個別に有効化 / 無効化してください。

```bash
pi install https://github.com/shuymn/pi-extensions
pi config
```

## 利用可能な extensions

- `add-dir` — 現在のセッションに追加の workspace directory を登録します。
- `ask-user-question` — エージェントが構造化された確認質問を行えるようにします。
- `codex-fast` — OpenAI Codex の fast service tier を global settings に永続化して制御します。
- `exit` — `/quit` の alias として `/exit` を追加し、resume command を表示します。
- `message-history` — `ctrl+r` で過去の user messages を fuzzy find します。
- `plan` — `/plan` と `/impl` の workflow prompts を追加します。
- `prompt-stash` — `ctrl+s` で prompt buffer を stash / restore します。
- `research` — staged deep-research workflows と Tavily Research escalation を実行します。
- `review` — multi-phase code review workflow を実行します。
- `sakura-ai-engine` — Sakura AI Engine の model provider を登録します。
- `session-title` — 最初の user message から session title を生成します。
- `statusline` — TUI footer を project、model、context status 表示に置き換えます。
- `subagents` — delegated work 用に isolated subagent sessions を起動します。
- `tavily` — Tavily search、extract、map、crawl、auth tools を追加します。
- `todo` — multi-step work 用の branch-local todos を管理します。
- `vertex-claude` — Google Vertex AI 経由で提供される Claude models を登録します。

依存関係:

- `todo` は review 実行中に todo widget を抑制するために `review` workflow events を import します。
