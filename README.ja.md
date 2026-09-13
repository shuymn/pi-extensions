# pi-extensions

個人用の pi coding-agent extensions と prompt templates です。Pi 0.85.1 以降が必要です。

[English](./README.md)

## 使い方

個人の workflow 向けに最適化しているため、破壊的変更や削除を積極的に行います。進捗表示や status UI は日本語のみ対応します。そのまま使うより、pi にベースとして渡し、自分向けに調整することをおすすめします。

```text
https://github.com/shuymn/pi-extensions/tree/main/extensions/<extension-name> をベースに、自分の workflow 向けの pi extension を作ってください。
```

そのまま使う場合は、package をインストールし、`pi config` で必要な機能だけを有効にしてください。

```bash
pi install https://github.com/shuymn/pi-extensions
pi config
```

## 利用可能な extensions

- `add-dir` — 現在のセッションに追加の workspace directory を登録します。
- `ask-user-question` — エージェントが構造化された確認質問を逐次実行できるようにします。
- `codex-fast` — OpenAI Codex の fast service tier を global settings に永続化して制御します。
- `commandcode-provider` — Command Code の model provider を登録します。live model discovery と fallback catalog を含みます。
- `commit` — `--commit` で `/skill:commit` を one-shot flow として起動します。
- `compact` — context compaction と明示的な Goal の継続を管理します。
- `companion` — Glimpse cursor companion overlay を制御します。
- `copy-file` — `/copy-file` で最新の assistant message を cwd の `RESULT_<uuid>.md` に保存します。
- `create-pr` — `--create-pr` で `/skill:create-pr` を one-shot flow として起動します。
- `disable-model` — 設定した provider または model を model selection から除外します。
- `dynamic-workflows` — `review_flow` / `research_flow` presets を含む subagent workflows を実行します。
- `fallback-model` — retry 可能な model error 時に fallback models へ切り替えます。
- `message-history` — `ctrl+r` で過去の user messages を fuzzy find します。
- `prompt-stash` — `ctrl+s` で prompt buffer を stash / restore します。
- `session-title` — 最初の user message から session title を生成します。
- `statusline` — TUI footer を project、model、context status 表示に置き換えます。
- `subagents` — delegated work 用に isolated subagent sessions を起動します。
- `tavily` — Tavily search、extract、map、crawl、auth tools を追加します。
- `tool-search` — `search_tools` で deferred tool 群を有効化します。
- `wt` — `/wt` で `git-wt` worktree を作成し、現在のセッションをそこで継続します。

## Prompt templates

`prompts/` 配下のテンプレートを `pi config` で有効にしてください。

- `/plan [追加指示]` — 調査して agent が実行できる `PLAN.md` を作ります。実装は開始しません。
- `/impl [追加指示]` — `PLAN.md` を実装し、日本語の実装メモを残します。

## One-shot flows

`commit` と `create-pr` は、インストール済みの対応する skill を起動し、agent run 終了後に exit します。どちらも `ask-user-question` extension が必要です。

```bash
pi --no-session --commit
pi --no-session --create-pr --japanese
```

セッションやモデルの flag は必要に応じて追加できます。

| Flag | 用途 |
| --- | --- |
| `--english` / `--japanese` | 出力言語を指定します。 |
| `--branch` | `--commit` でブランチを作成します。 |
| `--update` | `--create-pr` で既存の PR を更新します。 |
| `--base <branch>` | `--commit` では `--branch` が必要です。`--create-pr` では `--update` と併用できません。 |

flag 以外の自由入力は skill prompt に追記されます。

## Goal と圧縮

`compact` extension は context compaction と、明示した Goal に向けた自動継続を管理します。

```text
/goal start 不具合を修正する | 回帰テストが通る | 必須チェックが通る
/goal status
/goal stop
/goal resume
```

- 目的と各完了条件は `|` で区切ります。
- ユーザーの `start` / `resume` だけが自動継続を許可します。実行中でなく、入力キューが空のときに使えます。
- 回答や承認が必要になると自動継続は待機します。回答後に `/goal resume` で再開してください。
- Esc または `/goal stop` で予約済みの継続を止めます。`/goal stop` は圧縮予約も取り消します。
- reload、セッション再開、fork、tree 移動では自動継続は再始動しません。`/goal resume` が必要です。
- 開始・再開ごとの自動継続上限は20回で、圧縮後の継続も含みます。1実行内のツール回数や時間は制限せず、上限到達は完了を意味しません。

エージェントは `compact_context` で圧縮を要求できます。成功後は有効な Goal がなくても現在の作業を一度継続しますが、旧 Goal の自動継続は再開しません。`stopAfterCompaction` は継続を止め、Goal も停止します。標準の `/compact` 自体は自動継続の許可にはなりません。

安全網として Pi 標準の `compaction.enabled: true` を使ってください。圧縮失敗や回復できないモデルエラー時は停止します。
