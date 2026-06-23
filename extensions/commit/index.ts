import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  agentEndIncludesSkillPrompt,
  appendOneShotFreeInput,
  availableOneShotTools,
  collectOneShotCliFreeInputs,
  consumeOneShotFreeInput,
  expandOneShotSkillPrompt,
  findOneShotPrimaryFlagConflict,
  getAvailableToolNames,
  ONE_SHOT_BASE_FLAG,
  ONE_SHOT_ENGLISH_FLAG,
  ONE_SHOT_JAPANESE_FLAG,
  ONE_SHOT_SAFE_TOOLS,
  type OneShotLanguage,
  parseOneShotBaseFlag,
  parseOneShotLanguageFlags,
  registerOneShotSharedFlags,
} from "../../lib/one-shot-flow";
import { notifyIfUI } from "../../lib/tui";
import { ASK_USER_QUESTION_POLICY_EVENT } from "../ask-user-question/policy";

export const COMMIT_FLAG = "commit";
export const COMMIT_ENGLISH_FLAG = ONE_SHOT_ENGLISH_FLAG;
export const COMMIT_JAPANESE_FLAG = ONE_SHOT_JAPANESE_FLAG;
export const COMMIT_BRANCH_FLAG = "branch";
export const COMMIT_BASE_FLAG = ONE_SHOT_BASE_FLAG;

export const COMMIT_SAFE_TOOLS = ONE_SHOT_SAFE_TOOLS;

export type CommitLanguage = OneShotLanguage;

export type CommitLaunchOptions = {
  language?: CommitLanguage;
  branch: boolean;
  base?: string;
};

export type CommitOptionsResult =
  | { ok: true; options: CommitLaunchOptions }
  | { ok: false; message: string };

export function parseCommitLaunchOptions(flags: {
  english: unknown;
  japanese: unknown;
  branch: unknown;
  base: unknown;
}): CommitOptionsResult {
  const language = parseOneShotLanguageFlags(flags);
  if (!language.ok) return language;

  if (flags.branch !== undefined && typeof flags.branch !== "boolean") {
    return {
      ok: false,
      message: "--branch は値を取らない boolean flag として指定してください。",
    };
  }
  const branch = flags.branch === true;

  const base = parseOneShotBaseFlag(flags.base);
  if (!base.ok) return base;

  if (base.base && !branch) {
    return {
      ok: false,
      message: "--base は --branch と一緒に指定してください。",
    };
  }

  return {
    ok: true,
    options: {
      ...(language.language ? { language: language.language } : {}),
      branch,
      ...(base.base ? { base: base.base } : {}),
    },
  };
}

export function buildCommitSkillPrompt(options: CommitLaunchOptions): string {
  const parts = ["/skill:commit"];
  if (options.language) parts.push(options.language === "japanese" ? "--japanese" : "--english");
  if (options.branch) parts.push("--branch");
  if (options.base) parts.push(`--base=${options.base}`);
  return parts.join(" ");
}

export default function commitExtension(pi: ExtensionAPI): void {
  pi.registerFlag(COMMIT_FLAG, {
    description: "Launch the commit skill as a bounded one-shot flow",
    type: "boolean",
    default: false,
  });
  const getSharedFlags = registerOneShotSharedFlags(pi);
  const cliFreeInputs = collectOneShotCliFreeInputs(COMMIT_FLAG);
  const pendingInitialMessages = [...cliFreeInputs.initialMessages];
  pi.registerFlag(COMMIT_BRANCH_FLAG, {
    description: "Create a new branch before committing in --commit mode",
    type: "boolean",
    default: false,
  });

  let launchAttempted = false;
  let boundedQuestionnaireActive = false;
  let launchedCommitPrompt: string | undefined;

  function setBoundedQuestionnaire(): void {
    pi.events.emit(ASK_USER_QUESTION_POLICY_EVENT, { allowChatAboutThis: false });
    boundedQuestionnaireActive = true;
  }

  function resetBoundedQuestionnaire(): void {
    if (!boundedQuestionnaireActive) return;
    pi.events.emit(ASK_USER_QUESTION_POLICY_EVENT, { allowChatAboutThis: true });
    boundedQuestionnaireActive = false;
  }

  function clearActiveCommitRun(): void {
    launchedCommitPrompt = undefined;
    resetBoundedQuestionnaire();
  }

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag(COMMIT_FLAG) !== true) return;
    if (launchAttempted) return;
    launchAttempted = true;

    const primaryFlagConflict = findOneShotPrimaryFlagConflict();
    if (!primaryFlagConflict.ok) {
      if (primaryFlagConflict.shouldReport) {
        notifyIfUI(ctx, primaryFlagConflict.message, "error");
        ctx.shutdown();
      }
      return;
    }

    const sharedFlags = getSharedFlags();
    const parsed = parseCommitLaunchOptions({
      english: sharedFlags.english,
      japanese: sharedFlags.japanese,
      branch: pi.getFlag(COMMIT_BRANCH_FLAG),
      base: sharedFlags.base,
    });
    if (!parsed.ok) {
      notifyIfUI(ctx, parsed.message, "error");
      ctx.shutdown();
      return;
    }

    const availableTools = getAvailableToolNames(pi);
    if (!availableTools.has("ask_user_question")) {
      notifyIfUI(
        ctx,
        "--commit には ask_user_question LLM Tool が必要です。commit skill は起動しません。",
        "error",
      );
      ctx.shutdown();
      return;
    }

    try {
      pi.setActiveTools(availableOneShotTools(availableTools));
      const prompt = appendOneShotFreeInput(
        buildCommitSkillPrompt(parsed.options),
        cliFreeInputs.all,
      );
      const expandedPrompt = expandOneShotSkillPrompt(pi, "commit", prompt);
      setBoundedQuestionnaire();
      pi.sendUserMessage(expandedPrompt);
      launchedCommitPrompt = prompt;
    } catch (error) {
      clearActiveCommitRun();
      notifyIfUI(
        ctx,
        `commit one-shot の起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      ctx.shutdown();
    }
  });

  if (pendingInitialMessages.length > 0) {
    pi.on("input", async (event) => {
      if (consumeOneShotFreeInput(pendingInitialMessages, event)) return { action: "handled" };
    });
  }

  pi.on("agent_end", async (event, ctx) => {
    if (!launchedCommitPrompt) return;
    if (!agentEndIncludesSkillPrompt(event.messages, "commit", launchedCommitPrompt)) return;
    clearActiveCommitRun();
    ctx.shutdown();
  });
}
