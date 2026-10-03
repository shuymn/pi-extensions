# Pi Agent Extension Conventions

このディレクトリの extension は、単なる DRY ではなく UI/LLM-facing API/非対話モードの挙動を揃える。

## 言語

- Human-facing TUI 文言（通知、確認、入力タイトル、help text）は日本語を基本にする。
- LLM-facing metadata（tool `description`, `promptSnippet`, `promptGuidelines`, parameter `description`）は英語を基本にする。
- コマンド名、tool 名、CLI 出力、外部サービス固有語は原語を維持する。

## Slash Command 公開方針

- 実行時の制御・ユーザー認可が必要な操作（例: `/goal`, `/review-fix`, `/wt`, `/add-dir`）は直接 Slash Command として登録する。
- 固定の手順を渡す `/plan` と `/impl` は `prompts/` 配下の標準 prompt templates とし、`package.json` の `pi.prompts` で公開する。引数展開と処理中のメッセージ配送は Pi 標準に任せる。
- review / research の手順は `skills/` に置く。review の scope・coverage・修正前チェックは runtime capability が保証し、修正認可は `/review-fix` でユーザーから受け取る。

## Dynamic Tool Loading

- Tavily、`review`、background subagent management の大型 tool 群は `exposure: "deferred"` で登録する。Pi 標準の `tool_search` を使う場合は `builtin:tool-search` と `defaultTools` の `+tool_search` が必要。codemode からも標準の discovery API で参照できる。
- `ask_user_question`、`goal`、`spawn_subagent`、`github_clone_workspace` は常時 active にする。
- deferred LLM Tool は active-only の `promptSnippet` / `promptGuidelines` を持たず、必要な契約を `description` と parameter schema に置く。
- deferred exposure と `setActiveTools()` はアクセス制御ではない。child の明示的な tools allowlist、one-shot の実行時 guard により nested / deferred execution にも制限を適用する。

## TUI component

- TUI と RPC で共有する単一選択・任意テキスト入力は Pi 公開の `ctx.ui.select()` / `ctx.ui.input()` を使う。
- `ask_user_question` は標準ダイアログを逐次表示し、選択肢の説明を選択時のタイトル内に含める。独自質問票やモード別 UI は持たない。
- custom component の render line は必ず width 以下に収める。共通 helper の `truncateLines()` を優先する。
- state を変えた後は `tui.requestRender()` を呼ぶ。
- embedded `Input` を持つ component は、IME 対応のため `Focusable` propagation を意識する。

## 入力処理

- printable 判定は `lib/tui.ts` の `printableInput()` を使う。
- 制御キーは printable 判定より先に処理する。
- 選択 UI は将来的に `keybindings.matches("tui.select.*")` を優先し、必要に応じて `Key.*` を fallback として使う。

## 非対話モード

- UI 専用 extension は `ctx.hasUI === false` で no-op にする。
- LLM tool は UI が必要で利用できない場合、structured error result を返す。
- 通知だけの処理は `ctx.hasUI` を吸収する helper を使う。

## Structured output tool

- LLM に固定の JSON-like 出力を求める場合は、prose-only な JSON 指示ではなく tool parameter schema を優先する。
- Structured schema は外部 API / CLI、質問 UI、永続化 state、副作用 tool、review の coverage / validation など、コードが機械的に消費する境界に限定する。
- LLM-to-LLM の委譲結果は Markdown / prose を基本にし、コードが分岐・検証する場合に schema を指定する。
- 文字列 enum は Google API 互換性のため `@earendil-works/pi-ai` の `StringEnum` を使い、`Type.Union` / `Type.Literal` で表現しない。
- 最終または中間成果物の提出で turn を終える tool は `terminate: true` を返す。
- `content` はモデルに渡る tool result として、判断に必要な回答・状態・未回答情報を含める。`details` は UI や extension 用であり、モデルへの伝達には使わない。codemode 向けの完全なデータは `outputSchema` と `structuredContent` で返す。
- 部分失敗や中断は明示的な status と証跡で返す。実行不能な tool failure は throw し、失敗を空の成功結果に変換しない。
- 外部 CLI JSON の parse、質問 UI、state persistence の result は、具体的な再利用ニーズが出るまで structured-output helper に一般化しない。

## 進捗表示

- 長期的に参照する進行状態・作業状態は `aboveEditor` widget で示す。
- `belowEditor` widget は spinner、elapsed time、外部 CLI 実行中など短命・補助的な進捗表示に使う。
- 外部 CLI など待ち時間が読みにくい処理は spinner と elapsed time を表示する。
- 短い完了通知は `ctx.ui.notify()` でよい。
