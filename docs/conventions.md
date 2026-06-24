# Pi Agent Extension Conventions

このディレクトリの extension は、単なる DRY ではなく UI/LLM-facing API/非対話モードの挙動を揃える。

## 言語

- Human-facing TUI 文言（通知、確認、入力タイトル、help text）は日本語を基本にする。
- LLM-facing metadata（tool `description`, `promptSnippet`, `promptGuidelines`, parameter `description`）は英語を基本にする。
- コマンド名、tool 名、CLI 出力、外部サービス固有語は原語を維持する。

## Slash Command 公開方針

- 明示的に人が呼ぶ workflow（例: `/plan`, `/impl`, `/review`, `/research`, `/workflow`, `/workflows`, `/wt`, `/add-dir`）は直接 Slash Command として登録する。
- `ExtensionCommandContext` が必要だが、恒久的な個別コマンドとして見せる必要がない runtime 操作は allowlist された `/invoke <operation> [JSON args]` 経由にする。
- `/invoke` は Slash Command 用の router であり、LLM Tool を置き換えるものではない。既存 Tool を `/invoke` 配下へ移動しない。

## TUI component

- 検索可能な単一選択は `lib/tui.ts` の `selectFuzzy()` を使う。
- 任意テキスト入力は `lib/tui.ts` の `inputOptional()` を使う。
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
- Structured schema は外部 API / CLI、質問 UI、永続化 state、副作用 tool、workflow 分岐など、コードが機械的に消費する境界に限定する。
- LLM-to-LLM の内部 workflow handoff は Markdown / prose を基本にし、具体的な失敗や品質改善が観測されるまで schema / validation / patch tool を追加しない。
- 文字列 enum は Google API 互換性のため `@earendil-works/pi-ai` の `StringEnum` を使い、`Type.Union` / `Type.Literal` で表現しない。
- 最終または中間成果物の提出で turn を終える tool は `terminate: true` を返す。
- `content` は人間向けの短い説明に留め、機械可読な状態は `details` に置く。
- recoverable な workflow 提出失敗は `{ ok, warnings }`（必要なら `reason`）を含む structured result で返し、実行不能な tool failure は throw する。
- 外部 CLI JSON の parse、質問 UI、state persistence の result は、具体的な再利用ニーズが出るまで structured-output helper に一般化しない。

## 進捗表示

- 長期的に参照する進行状態・作業状態は `aboveEditor` widget で示す。
- `todo` / `review` / plan・workflow 系の状態表示は `aboveEditor` を標準にする。
- `belowEditor` widget は spinner、elapsed time、外部 CLI 実行中など短命・補助的な進捗表示に使う。
- 外部 CLI など待ち時間が読みにくい処理は spinner と elapsed time を表示する。
- 短い完了通知は `ctx.ui.notify()` でよい。
