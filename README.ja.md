# pi-extensions

個人用の pi coding-agent extensions、skills、prompt templates です。Pi 1.0.0 以降が必要です。

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
- `commandcode-provider` — Pi 標準のモデル更新と fallback catalog を使う Command Code provider を登録します。
- `companion` — Glimpse cursor companion overlay を制御します。
- `copy-file` — `/copy-file` で最新の assistant message を cwd の `RESULT_<uuid>.md` に保存します。
- `fallback-model` — 明示選択する `fallback/auto` virtual model を追加し、Pi 標準の request retry 内で候補を切り替えます。
- `goal` — ユーザーが明示開始した目標を、Pi 標準の終了前フックで継続します。
- `message-history` — `ctrl+r` で過去の user messages を fuzzy find します。
- `one-shot` — 導入済みの commit / PR skill を、対話・tool 制限・自動終了付きで実行します。
- `prompt-stash` — `ctrl+s` で prompt buffer を stash / restore します。
- `review` — 範囲を確定した read-only 調査、coverage の記録、別途認可する修正を提供します。
- `session-title` — 最初の user message から session title を生成します。
- `statusline` — TUI footer を、project・branch・model・thinking level・Codex fast・context 使用率・時刻／所要時間の色付き1行表示に置き換えます。有効時は標準 footer のその他の統計や extension status を表示しません。
- `subagents` — tool 制限、任意の構造化結果、foreground / background 制御を備えた委譲を実行します。
- `tavily` — CLI 経由の Tavily search、extract、map、crawl、auth tools を追加し、codemode に構造化 JSON を返します。
- `wt` — `/wt` で `git-wt` worktree を作成し、現在のセッションをそこで継続します。

## Skills と実行

`pi config` で `skills/review` と `skills/research` を有効にできます。review には `review` extension、research には Tavily と必要に応じて subagents を使います。手順は skills、tool の合成は標準 codemode、retry / compaction は Pi が担当します。

- Review は調査から開始します。結果を確認した後、`/review-fix <runId>` でその run の修正を一度だけ認可します。完全な検証と scope の不変確認が必要で、PR では最新 HEAD の一致と clean checkout も再確認します。修正用 child は調査済みファイルだけを編集でき、shell / network tools は持ちません。`fixed` はテスト成功を意味せず、未実行の検証を報告し、必要な検証は別途行います。run の操作は session 内に限定し、結果は session entry に記録します。
- Research は取得した資料を引用します。collector を Tavily のみに制限し、synthesis を `allowedTools: []` で実行できます。資料数・round 数の制限は課金上限ではありません。
- `spawn_subagent` は `allowedTools`、`readOnly`、任意の結果 `schema` を受け取ります。再委譲でも権限を広げません。read-only bash は repository を保護しますが、host 全体や network の完全な sandbox ではありません。background 完了だけで親の turn を開始しません。
- `/goal start 目的 | 完了条件 [| 条件]` で自走を開始します。`/goal stop` で停止し、`/goal resume` で明示的に再認可します。中断・人への質問・session 変更は継続権限を失効させます。`goal` tool からは開始・再開できません。
- Fallback は `pi --model fallback/auto --fallback-model 'provider/primary,provider/backup:high'` のように明示選択します。候補には最初のモデルも含め、別 provider へ context が送信される可能性を考慮してください。Pi が retry 対象とする request だけを切り替え、task 自体は再実行しません。この router は child でも使えますが、任意の他 extension の router は複製しません。

### 対話型 one-shot

`one-shot` と `ask-user-question` を有効にし、使用する `commit` / `create-pr` skills を別途導入してください。この2つの skills は本 package に含みません。モデル認証を設定した、新規の TUI または RPC session が必要です。

```bash
pi --commit -- "依頼した変更をコミットしてください"
pi --commit --branch --base main --japanese
pi --create-pr --base main --english
pi --create-pr --update
```

自由入力は `--` の後に指定します。2つ目以降の入力や絶対パスを含め、各引数を `/` で始めることはできません。パスには `pi --commit -- "対象: /path/to/repo"` のように説明を前置してください。`/` で始まる入力は、CLI のコマンド実行前に extension の読み込み時点で拒否します。`@file` と既存 session の再開には対応しません。使用可能な tools は `read`、`bash`、`grep`、`find`、`ls`、`ask_user_question` で、nested execution にも制限を適用します。質問には対話で回答し、skill / UI 不足や質問のキャンセル時は停止します。commit mode は local commit のみ、PR mode は既存 commits の公開のみを認可し、新規 commit は作りません。bash はユーザーの OS 権限で動作し、tool 制限は shell sandbox ではありません。

## Prompt templates

`prompts/` 配下のテンプレートを `pi config` で有効にしてください。

- `/plan [追加指示]` — 調査して agent が実行できる `PLAN.md` を作ります。実装は開始しません。
- `/impl [追加指示]` — `PLAN.md` を実装し、日本語の実装メモを残します。
