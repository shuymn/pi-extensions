import { readFileSync } from "node:fs";
import {
  type ExtensionAPI,
  type ExtensionContext,
  parseArgs,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
  ONE_SHOT_PRIMARY_FLAGS,
  ONE_SHOT_SAFE_TOOLS,
  oneShotAuthorization,
  parseOneShotLaunch,
  registerOneShotFlags,
} from "../../lib/one-shot-flow";
import { notifyIfUI } from "../../lib/tui";

/** Hosts both bounded modes in Pi's existing TUI/RPC UI. No workflow, parser,
 * skill-expansion, or agent-loop implementation lives here. */
export default function oneShotExtension(pi: ExtensionAPI): void {
  registerOneShotFlags(pi);
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  // Native slash commands run before input hooks, including queued CLI messages.
  // Flag values are applied after loading: reject from raw argv so the CLI exits
  // on the loader diagnostic before any session or command dispatch can begin.
  if (
    ONE_SHOT_PRIMARY_FLAGS.some((name) => args.unknownFlags.has(name)) &&
    args.messages.some((message) => message.startsWith("/"))
  ) {
    throw new Error(
      "one-shot では / で始まる自由入力（絶対パスを含む）は使用できません。パスには「対象: 」などの説明を前置してください。",
    );
  }
  const initialInputs = new Set(args.messages);
  const allowedTools = new Set<string>(ONE_SHOT_SAFE_TOOLS);
  let state: "inactive" | "starting" | "running" | "stopping" | "closed" = "inactive";
  let launchInput: string | undefined;
  let skillPrefix: string | undefined;
  let skillBody: string | undefined;
  let authorization = "";

  function close(ctx: ExtensionContext, error?: string): void {
    if (state === "closed") return;
    state = "closed";
    launchInput = undefined;
    // Keep the guard installed after shutdown is requested. Pi may still dispatch
    // queued events before the mode disposes the runtime.
    pi.setActiveTools([]);
    if (error) {
      if (ctx.hasUI) notifyIfUI(ctx, error, "error");
      else console.error(error);
    }
    ctx.shutdown();
  }

  pi.on("session_start", (_event, ctx) => {
    if (state !== "inactive") {
      close(ctx);
      return;
    }
    const parsed = parseOneShotLaunch((name) => pi.getFlag(name), argv);
    if (!parsed.ok) {
      close(ctx, parsed.message);
      return;
    }
    if (!parsed.launch) return;
    state = "starting";
    const { mode, prompt } = parsed.launch;
    try {
      if (!ctx.hasUI)
        throw new Error("one-shot には質問に回答できる TUI または RPC UI が必要です。");
      if (!ctx.model) throw new Error("one-shot にはモデルの選択が必要です。");
      if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
        throw new Error("one-shot のモデル認証が設定されていません。");
      }
      if (
        ctx.sessionManager
          .getBranch()
          .some((entry) => entry.type === "message" || entry.type === "compaction")
      ) {
        throw new Error("one-shot は履歴のない新規セッションで実行してください。");
      }
      const tools = pi.getAllTools();
      if (!tools.some((tool) => tool.name === "ask_user_question" && tool.exposure !== "hidden")) {
        throw new Error(`--${mode} には ask_user_question LLM Tool が必要です。`);
      }
      const commands = pi.getCommands();
      const skill = commands.find((command) => command.name === `skill:${mode}`);
      if (skill?.source !== "skill")
        throw new Error(`skill:${mode} が見つからないか、別のコマンドに隠されています。`);
      // Fail closed before native expansion (which otherwise passes missing skills
      // through as ordinary text). Use Pi's frontmatter reader, not a second parser.
      skillBody = stripFrontmatter(readFileSync(skill.sourceInfo.path, "utf8")).trim();
      if (!skillBody) throw new Error(`skill:${mode} の本文が空です。`);
      skillPrefix = `<skill name="${mode}" location="${skill.sourceInfo.path}">`;
      authorization = oneShotAuthorization(mode);
      pi.setActiveTools(
        ONE_SHOT_SAFE_TOOLS.filter((name) => tools.some((tool) => tool.name === name)),
      );
      launchInput = prompt;
      pi.sendUserMessage(prompt, { expandPromptTemplates: true });
    } catch (error) {
      close(
        ctx,
        `one-shot の起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  pi.on("input", (event, ctx) => {
    if (state === "inactive") return;
    if (state === "starting" && event.source === "extension" && event.text === launchInput) {
      launchInput = undefined;
      return;
    }
    // CLI positional inputs are already included in launchInput. All other prompts
    // (including extension continuations) are out of scope; questionnaire answers
    // travel through ctx.ui and do not pass this input hook.
    if (state !== "closed" && event.source !== "extension" && !initialInputs.has(event.text)) {
      notifyIfUI(
        ctx,
        "one-shot 実行中の追加指示は受け付けません。質問ダイアログで回答してください。",
        "warning",
      );
    }
    return { action: "handled" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (state === "inactive") return;
    // Validate the native expansion against the preflight body, including a file
    // that becomes empty/unreadable between the input and before-start hooks.
    const bodyOffset = event.prompt.indexOf("\n\n") + 2;
    if (
      state !== "starting" ||
      !skillPrefix ||
      !skillBody ||
      !event.prompt.startsWith(`${skillPrefix}\n`) ||
      bodyOffset < 2 ||
      !event.prompt.slice(bodyOffset).startsWith(`${skillBody}\n</skill>`)
    ) {
      close(ctx, "one-shot の skill 展開を確認できないため、実行を停止しました。");
      return;
    }
    state = "running";
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
      event.systemPromptOptions.forceSystemPrompt += `\n\n${authorization}`;
    } else {
      event.systemPromptOptions.appendSystemPrompt += `\n\n${authorization}`;
    }
    event.systemPromptOptions.selectedTools = pi.getActiveTools();
  });

  pi.on("tool_call", (event) => {
    if (state === "inactive") return;
    // setActiveTools only controls declarations: codemode/deferred registrations
    // remain callable. Native nested calls pass through this same guard.
    if (state !== "running" || !allowedTools.has(event.toolName)) {
      return {
        block: true,
        reason: `Tool ${event.toolName} is not available in this bounded one-shot run.`,
        terminate: state !== "running",
      };
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (state !== "running" || event.toolName !== "ask_user_question") return;
    const details = event.details;
    if (
      event.isError ||
      !details ||
      typeof details !== "object" ||
      !("status" in details) ||
      details.status !== "completed"
    ) {
      state = "stopping";
      ctx.abort();
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (state === "closed" || state === "stopping") ctx.abort();
  });

  pi.on("agent_settled", (_event, ctx) => {
    // agent_end is not final: retries, recovery and pending tool work can follow.
    // agent_settled is the native final, notification-only boundary.
    if (state === "running" || state === "stopping") close(ctx);
  });

  pi.on("cache_warming_decision", () => {
    if (state !== "inactive") return { action: "stop" };
  });

  pi.on("session_shutdown", () => {
    if (state !== "inactive") {
      state = "closed";
      launchInput = undefined;
    }
  });
}
