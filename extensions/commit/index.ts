import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeBaseBranch } from "../../lib/git";
import { notifyIfUI } from "../../lib/tui";
import { ASK_USER_QUESTION_POLICY_EVENT } from "../ask-user-question/policy";

export const COMMIT_FLAG = "commit";
export const COMMIT_LANGUAGE_FLAG = "commit-language";
export const COMMIT_BRANCH_FLAG = "commit-branch";
export const COMMIT_BASE_FLAG = "commit-base";

export const COMMIT_SAFE_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "ask_user_question",
] as const;

export type CommitLanguage = "english" | "japanese";

export type CommitLaunchOptions = {
  language: CommitLanguage;
  branch: boolean;
  base?: string;
};

export type CommitOptionsResult =
  | { ok: true; options: CommitLaunchOptions }
  | { ok: false; message: string };

export function parseCommitLaunchOptions(flags: {
  language: unknown;
  branch: unknown;
  base: unknown;
}): CommitOptionsResult {
  const language = flags.language ?? "english";
  if (language !== "english" && language !== "japanese") {
    return {
      ok: false,
      message: "--commit-language には english または japanese を指定してください。",
    };
  }

  if (flags.branch !== undefined && typeof flags.branch !== "boolean") {
    return {
      ok: false,
      message: "--commit-branch は値を取らない boolean flag として指定してください。",
    };
  }
  const branch = flags.branch === true;

  if (flags.base !== undefined && flags.base !== null && typeof flags.base !== "string") {
    return {
      ok: false,
      message: "--commit-base には base branch 名を指定してください。",
    };
  }

  let base = typeof flags.base === "string" ? flags.base.trim() : undefined;
  if (flags.base !== undefined && flags.base !== null && !base) {
    return {
      ok: false,
      message: "--commit-base には空でない base branch 名を指定してください。",
    };
  }
  if (base) {
    try {
      base = normalizeBaseBranch(base);
    } catch {
      return {
        ok: false,
        message:
          "--commit-base には main や origin/main のような安全な branch/ref 名を指定してください。",
      };
    }
  }

  if (base && !branch) {
    return {
      ok: false,
      message: "--commit-base は --commit-branch と一緒に指定してください。",
    };
  }

  return {
    ok: true,
    options: {
      language,
      branch,
      ...(base ? { base } : {}),
    },
  };
}

export function buildCommitSkillPrompt(options: CommitLaunchOptions): string {
  const parts = ["/skill:commit", options.language === "japanese" ? "--japanese" : "--english"];
  if (options.branch) parts.push("--branch");
  if (options.base) parts.push(`--base=${options.base}`);
  return parts.join(" ");
}

function getAvailableToolNames(pi: Pick<ExtensionAPI, "getAllTools">): Set<string> {
  return new Set(pi.getAllTools().map((tool) => tool.name));
}

function availableCommitTools(availableTools: Set<string>): string[] {
  return COMMIT_SAFE_TOOLS.filter((tool) => availableTools.has(tool));
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function expandedSkillTextMatchesPrompt(text: string, prompt: string): boolean {
  if (!prompt.startsWith("/skill:commit")) return false;
  const args = prompt.slice("/skill:commit".length).trim();
  return text.startsWith('<skill name="commit" ') && (!args || text.endsWith(`\n\n${args}`));
}

function userTextMatchesPrompt(text: string, prompt: string): boolean {
  return text === prompt || expandedSkillTextMatchesPrompt(text, prompt);
}

function agentEndIncludesUserPrompt(messages: unknown, prompt: string): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const record = message as { role?: unknown; content?: unknown };
    const text = record.role === "user" ? textFromContent(record.content) : undefined;
    return text !== undefined && userTextMatchesPrompt(text, prompt);
  });
}

export default function commitExtension(pi: ExtensionAPI): void {
  pi.registerFlag(COMMIT_FLAG, {
    description: "Launch the commit skill as a bounded one-shot flow",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(COMMIT_LANGUAGE_FLAG, {
    description: "Commit message language for --commit: english or japanese",
    type: "string",
    default: "english",
  });
  pi.registerFlag(COMMIT_BRANCH_FLAG, {
    description: "Create a new branch before committing in --commit mode",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(COMMIT_BASE_FLAG, {
    description: "Base branch to switch to before creating --commit-branch",
    type: "string",
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

    const parsed = parseCommitLaunchOptions({
      language: pi.getFlag(COMMIT_LANGUAGE_FLAG),
      branch: pi.getFlag(COMMIT_BRANCH_FLAG),
      base: pi.getFlag(COMMIT_BASE_FLAG),
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
      pi.setActiveTools(availableCommitTools(availableTools));
      const prompt = buildCommitSkillPrompt(parsed.options);
      setBoundedQuestionnaire();
      pi.sendUserMessage(prompt);
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

  pi.on("agent_end", async (event, ctx) => {
    if (!launchedCommitPrompt) return;
    if (!agentEndIncludesUserPrompt(event.messages, launchedCommitPrompt)) return;
    clearActiveCommitRun();
    ctx.shutdown();
  });
}
