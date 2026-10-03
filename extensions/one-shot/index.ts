import { readFileSync } from "node:fs";
import {
  type ExtensionAPI,
  type ExtensionContext,
  parseArgs,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
  ONE_SHOT_PRIMARY_FLAGS,
  oneShotAuthorization,
  parseOneShotLaunch,
  registerOneShotFlags,
} from "../../lib/one-shot-flow";
import { notifyIfUI } from "../../lib/tui";

/** Hosts both one-shot modes with native interaction when needed. No workflow,
 * parser, skill-expansion, or agent-loop implementation lives here. */
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
      if (!ctx.model) throw new Error("one-shot にはモデルの選択が必要です。");
      if (
        ctx.sessionManager
          .getBranch()
          .some((entry) => entry.type === "message" || entry.type === "compaction")
      ) {
        throw new Error("one-shot は履歴のない新規セッションで実行してください。");
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
      launchInput = prompt;
      pi.sendUserMessage(prompt, { expandPromptTemplates: true });
    } catch (error) {
      close(
        ctx,
        `one-shot の起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  pi.on("input", (event) => {
    if (state === "inactive") return;
    if (state === "starting" && event.source === "extension" && event.text === launchInput) {
      launchInput = undefined;
      return;
    }
    // CLI positional inputs are already included in launchInput. Suppress their
    // replay and extension-generated prompts, but accept live human instructions
    // until settlement. Questionnaire answers travel through ctx.ui instead.
    if (state === "running" && event.source !== "extension" && !initialInputs.has(event.text)) {
      return;
    }
    return { action: "handled" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (state === "inactive") return;
    if (state === "starting") {
      // Validate native expansion once, including a skill that becomes empty or
      // unreadable between preflight and before-start. Later human input is not
      // another skill launch.
      const bodyOffset = event.prompt.indexOf("\n\n") + 2;
      if (
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
    } else if (state !== "running") {
      close(ctx);
      return;
    }
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
      event.systemPromptOptions.forceSystemPrompt += `\n\n${authorization}`;
    } else {
      event.systemPromptOptions.appendSystemPrompt += `\n\n${authorization}`;
    }
  });

  pi.on("tool_call", (event) => {
    if (state === "inactive") return;
    // Keep the lifecycle guard for direct and native nested calls without imposing
    // a second tool policy on Pi's loadout or the user's authorization.
    if (state !== "running") {
      return {
        block: true,
        reason: `Tool ${event.toolName} is not available outside this active one-shot run.`,
        terminate: true,
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
