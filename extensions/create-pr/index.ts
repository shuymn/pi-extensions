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

export const CREATE_PR_FLAG = "create-pr";
export const CREATE_PR_ENGLISH_FLAG = ONE_SHOT_ENGLISH_FLAG;
export const CREATE_PR_JAPANESE_FLAG = ONE_SHOT_JAPANESE_FLAG;
export const CREATE_PR_UPDATE_FLAG = "update";
export const CREATE_PR_BASE_FLAG = ONE_SHOT_BASE_FLAG;

export const CREATE_PR_SAFE_TOOLS = ONE_SHOT_SAFE_TOOLS;

export type CreatePrLaunchOptions = {
  language?: OneShotLanguage;
  update: boolean;
  base?: string;
};

export type CreatePrOptionsResult =
  | { ok: true; options: CreatePrLaunchOptions }
  | { ok: false; message: string };

export function parseCreatePrLaunchOptions(flags: {
  english: unknown;
  japanese: unknown;
  update: unknown;
  base: unknown;
}): CreatePrOptionsResult {
  const language = parseOneShotLanguageFlags(flags);
  if (!language.ok) return language;

  if (flags.update !== undefined && typeof flags.update !== "boolean") {
    return {
      ok: false,
      message: "--update は値を取らない boolean flag として指定してください。",
    };
  }
  const update = flags.update === true;

  const base = parseOneShotBaseFlag(flags.base);
  if (!base.ok) return base;

  if (base.base && update) {
    return {
      ok: false,
      message: "--base は --update と同時に指定できません。",
    };
  }

  return {
    ok: true,
    options: {
      ...(language.language ? { language: language.language } : {}),
      update,
      ...(base.base ? { base: base.base } : {}),
    },
  };
}

export function buildCreatePrSkillPrompt(options: CreatePrLaunchOptions): string {
  const parts = ["/skill:create-pr"];
  if (options.language === "japanese") parts.push("--japanese");
  if (options.update) parts.push("--update");
  if (options.base) parts.push(`--base=${options.base}`);
  return parts.join(" ");
}

export default function createPrExtension(pi: ExtensionAPI): void {
  pi.registerFlag(CREATE_PR_FLAG, {
    description: "Launch the create-pr skill as a bounded one-shot flow",
    type: "boolean",
    default: false,
  });
  const getSharedFlags = registerOneShotSharedFlags(pi);
  const cliFreeInputs = collectOneShotCliFreeInputs(CREATE_PR_FLAG);
  const pendingInitialMessages = [...cliFreeInputs.initialMessages];
  pi.registerFlag(CREATE_PR_UPDATE_FLAG, {
    description: "Update the current branch pull request in --create-pr mode",
    type: "boolean",
    default: false,
  });

  let launchAttempted = false;
  let boundedQuestionnaireActive = false;
  let launchedCreatePrPrompt: string | undefined;

  function setBoundedQuestionnaire(): void {
    pi.events.emit(ASK_USER_QUESTION_POLICY_EVENT, { allowChatAboutThis: false });
    boundedQuestionnaireActive = true;
  }

  function resetBoundedQuestionnaire(): void {
    if (!boundedQuestionnaireActive) return;
    pi.events.emit(ASK_USER_QUESTION_POLICY_EVENT, { allowChatAboutThis: true });
    boundedQuestionnaireActive = false;
  }

  function clearActiveCreatePrRun(): void {
    launchedCreatePrPrompt = undefined;
    resetBoundedQuestionnaire();
  }

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag(CREATE_PR_FLAG) !== true) return;
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
    const parsed = parseCreatePrLaunchOptions({
      english: sharedFlags.english,
      japanese: sharedFlags.japanese,
      update: pi.getFlag(CREATE_PR_UPDATE_FLAG),
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
        "--create-pr には ask_user_question LLM Tool が必要です。create-pr skill は起動しません。",
        "error",
      );
      ctx.shutdown();
      return;
    }

    try {
      pi.setActiveTools(availableOneShotTools(availableTools));
      const prompt = appendOneShotFreeInput(
        buildCreatePrSkillPrompt(parsed.options),
        cliFreeInputs.all,
      );
      const expandedPrompt = expandOneShotSkillPrompt(pi, "create-pr", prompt);
      setBoundedQuestionnaire();
      pi.sendUserMessage(expandedPrompt);
      launchedCreatePrPrompt = prompt;
    } catch (error) {
      clearActiveCreatePrRun();
      notifyIfUI(
        ctx,
        `create-pr one-shot の起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
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
    if (!launchedCreatePrPrompt) return;
    if (!agentEndIncludesSkillPrompt(event.messages, "create-pr", launchedCreatePrPrompt)) return;
    clearActiveCreatePrRun();
    ctx.shutdown();
  });
}
