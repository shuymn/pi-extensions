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

- `abliteration-provider` — Pi の `/login` で保存した API キーで abliteration.ai を利用します。
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

## abliteration.ai の設定

`pi config` で `abliteration-provider` を有効にし、Pi を再起動するか `/reload` してください。`/login` で **abliteration.ai** を選び、[console](https://abliteration.ai/console) で取得した API キーを入力します。キーは Pi が `~/.pi/agent/auth.json` に保存するため、環境変数は不要です。その後、`/model` で `abliteration` のモデルを選択します。

[公式モデル一覧](https://docs.abliteration.ai/models) の3モデルを静的に登録します。画像入力は `abliterated-model` のみ対応します。Large V2 の推論レベルは low/high/max（無効化不可）、旧 Large は off/high/max です。プロンプトキャッシュのルーティング用にセッション単位の affinity header を有効にしています。料金の概算には Pi 連携例の古い値ではなく、[料金ページ](https://docs.abliteration.ai/pricing) の値を使用します。

## Prompt templates

`prompts/` 配下のテンプレートを `pi config` で有効にしてください。

- `/plan [追加指示]` — 調査して agent が実行できる `PLAN.md` を作ります。実装は開始しません。
- `/impl [追加指示]` — `PLAN.md` を実装し、日本語の実装メモを残します。
