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
- `commandcode-provider` — Pi 標準のモデル更新と fallback catalog を使う Command Code provider を登録します。
- `companion` — Glimpse cursor companion overlay を制御します。
- `copy-file` — `/copy-file` で最新の assistant message を cwd の `RESULT_<uuid>.md` に保存します。
- `fallback-model` — 明示選択する `fallback/auto` virtual model を追加し、Pi 標準の request retry 内で候補を切り替えます。
- `goal` — ユーザーが明示開始した目標を、Pi 標準の終了前フックで継続します。
- `message-history` — `ctrl+r` で過去の user messages を fuzzy find します。
- `one-shot` — 導入済みの commit / PR skill を、通常の tools・対話・自動終了付きで実行します。
- `openai-fast` — `/openai-fast [on|off|toggle|status]` で OpenAI Responses の fast service tier を制御し、global settings に永続化します。既存の `codex-fast.enabled` は `openai-fast.enabled` が設定されるまで引き継ぎます。
- `prompt-stash` — `ctrl+s` で prompt buffer を stash / restore します。
- `review` — 独立した調査、検証済み指摘の修正、実行検証まで進めます。`--no-fix` で調査専用にできます。
- `session-title` — 最初の user message から session title を生成します。
- `statusline` — TUI footer を、project・branch・model・thinking level・OpenAI fast・context 使用率・時刻／所要時間の色付き1行表示に置き換えます。有効時は標準 footer のその他の統計や extension status を表示しません。
- `subagents` — 呼び出し元の capabilities を継承し、明示的な制限・任意の構造化結果・foreground / background 制御を備えた委譲を実行します。
- `tavily` — CLI 経由の Tavily search、extract、map、crawl、auth tools を追加し、codemode に構造化 JSON を返します。
- `wt` — `/wt` で `git-wt` worktree を作成し、現在のセッションをそこで継続します。

## Skills と実行

`pi config` で `skills/review` と `skills/research` を有効にできます。review には `review` extension、research には Tavily と必要に応じて subagents を使います。手順は skills、tool の合成は標準 codemode、retry / compaction は Pi が担当します。

- Review は既定で修正・検証まで含みます。`/review [files | --staged | --base ref | --pr selector]` または review skill/tool から実行でき、`--no-fix` / `noFix: true` で調査専用になります。`/review-fix` の橋渡しは不要です。通常のローカルツールで範囲内の検証失敗を調査・修復し、必要な関連テストも追加できます。検証が失敗・未実行なら `fixed` 扱いにしません。古い証拠への修正を防ぐ scope/PR 再確認は維持し、commit・公開は別途認可が必要です。run の操作は session 内に限定し、結果は session entry に記録します。
- Research は取得した資料を引用します。委譲は通常 read-only capabilities を継承し、tools や収集量は明示的な指定・具体的な必要がある場合だけ制限します。証拠不足があれば焦点を絞って追加収集できます。
- `spawn_subagent` は呼び出し元の利用可能な tools を継承し、明示的な `allowedTools`、`readOnly`、任意の結果 `schema` を受け取ります。再委譲でも権限を広げません。read-only bash は repository を保護しますが、host 全体や network の完全な sandbox ではありません。background 完了だけで親の turn を開始しません。
- `/goal start 目的 | 完了条件 [| 条件]` で自走を開始します。`/goal stop` で停止し、`/goal resume` で明示的に再認可します。中断・人への質問・session 変更は継続権限を失効させます。`goal` tool からは開始・再開できません。
- Fallback は `pi --model fallback/auto --fallback-model 'provider/primary,provider/backup:high'` のように明示選択します。候補には最初のモデルも含め、別 provider へ context が送信される可能性を考慮してください。失敗時は Pi の標準 retry 判定と上限に従います。継続中の model が catalog から消えた場合も、設定済みの利用可能な候補へ移れます。task 自体は再実行しません。この router は child でも使えますが、任意の他 extension の router は複製しません。

### One-shot

`one-shot` を有効にし、使用する `commit` / `create-pr` skills を別途導入してください。この2つの skills は本 package に含みません。モデル認証を設定した新規 session を使用します。実際に人への質問が必要な場合は `ask-user-question` と TUI / RPC を利用し、対話が不要な作業は headless でも実行できます。

```bash
pi --commit -- "依頼した変更をコミットしてください"
pi --commit --branch --base main --japanese
pi --create-pr --base main --english
pi --create-pr --update
```

自由入力は `--` の後に指定します。2つ目以降の入力や絶対パスを含め、各引数を `/` で始めることはできません。パスには `pi --commit -- "対象: /path/to/repo"` のように説明を前置してください。`/` で始まる入力は、CLI のコマンド実行前に extension の読み込み時点で拒否します。`@file` と既存 session の再開には対応しません。固定 allowlist は設けず、Pi の選択済み tools、deferred discovery、nested execution を維持します。範囲内の修復・検証は継続でき、実際の回答や追加入力による明示的な追加認可も受け取れます。対話が不要なら UI や質問 tool がなくても実行できます。必要な入力を取得できない場合や質問のキャンセルは、認可ではなく blocker として扱います。commit と PR 公開の既定認可は区別します。通常の tools はユーザーの OS 権限で動作し、shell sandbox ではありません。

## Prompt templates

`prompts/` 配下のテンプレートを `pi config` で有効にしてください。

- `/plan [追加指示]` — 調査して agent が実行できる `PLAN.md` を作ります。実装は開始しません。
- `/impl [追加指示]` — `PLAN.md` を実装し、日本語の実装メモを残します。
