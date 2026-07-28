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
- `ask-user-question` — エージェントが構造化された確認質問を逐次実行できるようにします。
- `codex-fast` — OpenAI Codex の fast service tier を global settings に永続化して制御します。
- `commandcode-provider` — Command Code の model provider を登録します。live model discovery と fallback catalog を含みます。
- `commit` — `--commit` で既存の `/skill:commit` を bounded one-shot flow として起動します。
- `compact` — semantic checkpoint で Pi context compaction を agent が要求できるようにします。
- `companion` — Glimpse cursor companion overlay を制御します。
- `copy-file` — `/copy-file` で最新の assistant message を cwd の `RESULT_<uuid>.md` に保存します。
- `create-pr` — `--create-pr` で既存の `/skill:create-pr` を bounded one-shot flow として起動します。
- `disable-model` — 設定した provider または model を model selection から除外します。
- `dynamic-workflows` — deterministic subagent workflows と packaged `review_flow` / `research_flow` presets を実行します。
- `env` — CLI で model を指定しない場合、`PI_MODEL` または project settings から初期 model を選びます。
- `exit` — `/quit` の alias として `/exit` を追加し、resume command を表示します。
- `fallback-model` — retry 可能な model error 時に comma-separated fallback models へ切り替えます。
- `message-history` — `ctrl+r` で過去の user messages を fuzzy find します。
- `plan` — `/plan` と `/impl` の workflow prompts を追加します。
- `prompt-stash` — `ctrl+s` で prompt buffer を stash / restore します。
- `sakana-ai-provider` — OpenAI Responses API 経由で Sakana AI Fugu models を登録します。
- `sakura-ai-engine-provider` — Sakura AI Engine の model provider を登録します。
- `session-title` — 最初の user message から session title を生成します。
- `statusline` — TUI footer を project、model、context status 表示に置き換えます。
- `subagents` — delegated work 用に isolated subagent sessions を起動します。
- `tavily` — Tavily search、extract、map、crawl、auth tools を追加します。
- `todo` — multi-step work 用の branch-local todos を管理します。
- `tool-search` — 大型 tool 群を deferred に保ち、`search_tools` で一致する tools を有効化します。
- `wt` — `/wt` で `git-wt` worktree を作成し、現在のセッションをそこで継続します。

## Sakana AI provider

次のモデルを選択する前に `SAKANA_API_KEY` を設定してください。

- `sakana-ai/fugu`
- `sakana-ai/fugu-ultra`
- `sakana-ai/fugu-ultra-v1.1`
- `sakana-ai/fugu-ultra-v1.0`
- `sakana-ai/fugu-cyber`

`fugu-ultra` は現在の Ultra release を参照し、現時点では `fugu-ultra-v1.1` の alias です。`fugu-cyber` の利用には申請の承認と、Billing mode が **Pay as you go** の API キーが必要です。Sakana は `fugu` の料金を基盤モデルプールに応じて動的に決め、Pi は Ultra と Cyber の課金対象 orchestration token 使用量を取得できません。そのため、これらのモデルの料金はローカルに算出できず、`$0` と表示されても無料ではなく不明という意味です。

Sakana の stream が最大2時間 idle のまま待機できるように、次の設定を `~/.pi/agent/settings.json` にマージしてください。

```json
{
  "httpIdleTimeoutMs": 7200000
}
```

これは Pi 全体の global 設定であり、すべての provider の HTTP header/body idle timeout と既定の request timeout も延長します。

`SAKANA_API_KEY` を shell history に残らない方法で設定したあと、一般提供モデルを手動で smoke test します。

```bash
for model in fugu fugu-ultra-v1.1 fugu-ultra-v1.0; do
  pi --print --no-session --model "sakana-ai/${model}:high" "Reply with only OK."
done
```

承認済みユーザーは Cyber を個別に確認できます。

```bash
pi --print --no-session --model "sakana-ai/fugu-cyber:high" "Reply with only OK."
```

## one-shot flows

セッションやモデルの flag は呼び出し元で指定し、one-shot flag を追加すると skill を起動して agent run 終了後に exit します。

```bash
pi \
  --no-session \
  --no-session-title \
  --model 'opencode-go/deepseek-v4-flash:high' \
  --fallback-model 'commandcode/deepseek/deepseek-v4-flash,deepseek/deepseek-v4-flash' \
  --commit
```

```bash
pi \
  --no-session \
  --no-session-title \
  --model 'opencode-go/deepseek-v4-flash:high' \
  --fallback-model 'commandcode/deepseek/deepseek-v4-flash,deepseek/deepseek-v4-flash' \
  --create-pr --japanese
```

共通の任意 flag は `--english`/`--japanese` と `--base <branch>` です。`--base` は `--commit` では `--branch` と一緒に使い、`--create-pr` では `--update` と同時に使えません。commit 専用 flag は `--branch`、create-pr 専用 flag は `--update` です。flag 以外の自由入力は起動する skill prompt に追記されます。

依存関係:

- `commit` と `create-pr` は `ask_user_question` LLM Tool が利用可能な場合だけ one-shot flow を起動するため、`ask-user-question` が必要です。
- `todo` は `review_flow` 実行中に todo widget を抑制するため、`dynamic-workflows` の review lifecycle events を import します。
- `tool-search` は Tavily、`workflow`、background subagent management tools を deferred に保ちます。`ask_user_question`、`compact_context`、`todo`、`spawn_subagent`、`github_clone_workspace` は常時 active です。
