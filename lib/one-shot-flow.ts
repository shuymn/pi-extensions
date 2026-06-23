import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeBaseBranch } from "./git";

export const ONE_SHOT_ENGLISH_FLAG = "english";
export const ONE_SHOT_JAPANESE_FLAG = "japanese";
export const ONE_SHOT_BASE_FLAG = "base";
export const ONE_SHOT_PRIMARY_FLAGS = ["commit", "create-pr"] as const;

export const ONE_SHOT_SAFE_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "ask_user_question",
] as const;

export type OneShotLanguage = "english" | "japanese";

export type OneShotSharedFlagValues = {
  english: unknown;
  japanese: unknown;
  base: unknown;
};

export type OneShotSharedFlagReader = () => OneShotSharedFlagValues;

export type OneShotCliFreeInputs = {
  all: string[];
  initialMessages: string[];
};

type SharedFlagState = {
  reader?: OneShotSharedFlagReader;
  reportedConflictKey?: string;
};

const SHARED_FLAG_STATE = Symbol.for("pi-extensions.one-shot-flow.shared-flags");

function sharedFlagState(): SharedFlagState {
  const root = globalThis as typeof globalThis & { [SHARED_FLAG_STATE]?: SharedFlagState };
  root[SHARED_FLAG_STATE] ??= {};
  return root[SHARED_FLAG_STATE];
}

function tryReadSharedFlags(
  reader: OneShotSharedFlagReader | undefined,
): OneShotSharedFlagValues | null {
  if (!reader) return null;
  try {
    return reader();
  } catch {
    return null;
  }
}

export function resetOneShotSharedFlagsForTest(): void {
  const state = sharedFlagState();
  state.reader = undefined;
  state.reportedConflictKey = undefined;
}

function clearSharedFlagsOnShutdown(pi: ExtensionAPI, reader: OneShotSharedFlagReader): void {
  pi.on("session_shutdown", async () => {
    const state = sharedFlagState();
    if (state.reader === reader) state.reader = undefined;
    state.reportedConflictKey = undefined;
  });
}

export function registerOneShotSharedFlags(pi: ExtensionAPI): OneShotSharedFlagReader {
  const state = sharedFlagState();
  const currentReader = state.reader;
  if (currentReader && tryReadSharedFlags(currentReader)) return currentReader;

  pi.registerFlag(ONE_SHOT_ENGLISH_FLAG, {
    description: "Use English for one-shot skill flows",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(ONE_SHOT_JAPANESE_FLAG, {
    description: "Use Japanese for one-shot skill flows",
    type: "boolean",
    default: false,
  });
  pi.registerFlag(ONE_SHOT_BASE_FLAG, {
    description: "Base branch for one-shot skill flows",
    type: "string",
  });

  const reader: OneShotSharedFlagReader = () => ({
    english: pi.getFlag(ONE_SHOT_ENGLISH_FLAG),
    japanese: pi.getFlag(ONE_SHOT_JAPANESE_FLAG),
    base: pi.getFlag(ONE_SHOT_BASE_FLAG),
  });
  state.reader = reader;
  clearSharedFlagsOnShutdown(pi, reader);
  return reader;
}

export type OneShotPrimaryFlagConflictResult =
  | { ok: true }
  | { ok: false; message: string; shouldReport: boolean };

export function findOneShotPrimaryFlagConflict(
  argv: string[] = process.argv.slice(2),
): OneShotPrimaryFlagConflictResult {
  const selected = ONE_SHOT_PRIMARY_FLAGS.filter((flag) =>
    argv.some((arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`)),
  );
  if (selected.length < 2) return { ok: true };

  const key = selected.join("\0");
  const state = sharedFlagState();
  const shouldReport = state.reportedConflictKey !== key;
  state.reportedConflictKey = key;
  return {
    ok: false,
    message: `${selected.map((flag) => `--${flag}`).join(" と ")} は同時に指定できません。`,
    shouldReport,
  };
}

export type OneShotLanguageFlagsResult =
  | { ok: true; language?: OneShotLanguage }
  | { ok: false; message: string };

export function parseOneShotLanguageFlags(flags: {
  english: unknown;
  japanese: unknown;
}): OneShotLanguageFlagsResult {
  if (flags.english !== undefined && typeof flags.english !== "boolean") {
    return {
      ok: false,
      message: "--english は値を取らない boolean flag として指定してください。",
    };
  }
  if (flags.japanese !== undefined && typeof flags.japanese !== "boolean") {
    return {
      ok: false,
      message: "--japanese は値を取らない boolean flag として指定してください。",
    };
  }

  const english = flags.english === true;
  const japanese = flags.japanese === true;
  if (english && japanese) {
    return {
      ok: false,
      message: "--english と --japanese は同時に指定できません。",
    };
  }

  if (japanese) return { ok: true, language: "japanese" };
  if (english) return { ok: true, language: "english" };
  return { ok: true };
}

export type OneShotBaseFlagResult = { ok: true; base?: string } | { ok: false; message: string };

export function parseOneShotBaseFlag(baseValue: unknown): OneShotBaseFlagResult {
  const hasBase = baseValue !== undefined && baseValue !== null;
  if (hasBase && typeof baseValue !== "string") {
    return {
      ok: false,
      message: "--base には base branch 名を指定してください。",
    };
  }

  let base = typeof baseValue === "string" ? baseValue.trim() : undefined;
  if (hasBase && !base) {
    return {
      ok: false,
      message: "--base には空でない base branch 名を指定してください。",
    };
  }
  if (base) {
    try {
      base = normalizeBaseBranch(base);
    } catch {
      return {
        ok: false,
        message: "--base には main や origin/main のような安全な branch/ref 名を指定してください。",
      };
    }
  }

  return { ok: true, ...(base ? { base } : {}) };
}

export function getAvailableToolNames(pi: Pick<ExtensionAPI, "getAllTools">): Set<string> {
  return new Set(pi.getAllTools().map((tool) => tool.name));
}

export function availableOneShotTools(availableTools: Set<string>): string[] {
  return ONE_SHOT_SAFE_TOOLS.filter((tool) => availableTools.has(tool));
}

export function appendOneShotFreeInput(prompt: string, freeInputs: string[]): string {
  const freeInput = freeInputs
    .map((input) => input.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!freeInput) return prompt;
  const separator = prompt.includes(" ") ? "\n\n" : " ";
  return `${prompt}${separator}${freeInput}`;
}

export function expandOneShotSkillPrompt(
  pi: Pick<ExtensionAPI, "getCommands">,
  skillName: string,
  prompt: string,
): string {
  const command = `/skill:${skillName}`;
  if (prompt !== command && !prompt.startsWith(`${command} `)) return prompt;

  const skillCommand = pi
    .getCommands()
    .find((candidate) => candidate.source === "skill" && candidate.name === `skill:${skillName}`);
  if (!skillCommand) throw new Error(`skill:${skillName} が見つかりません。`);

  const skillPath = skillCommand.sourceInfo.path;
  const baseDir = skillCommand.sourceInfo.baseDir ?? dirname(skillPath);
  const body = stripOneShotFrontmatter(readFileSync(skillPath, "utf-8")).trim();
  const args = prompt.slice(command.length).trim();
  const skillBlock = `<skill name="${skillName}" location="${skillPath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
  return args ? `${skillBlock}\n\n${args}` : skillBlock;
}

function stripOneShotFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return normalized;
  return normalized.slice(endIndex + 4).trim();
}

export function collectOneShotCliFreeInputs(
  flowFlag: string,
  argv: string[] = process.argv.slice(2),
): OneShotCliFreeInputs {
  if (!argv.some((arg) => arg === `--${flowFlag}` || arg.startsWith(`--${flowFlag}=`))) {
    return { all: [], initialMessages: [] };
  }

  const requiredLongValueFlags = new Set([
    "api-key",
    "append-system-prompt",
    "exclude-tools",
    "export",
    "extension",
    "fork",
    "mode",
    "model",
    "models",
    "name",
    "prompt-template",
    "provider",
    "session",
    "session-dir",
    "session-id",
    "skill",
    "system-prompt",
    "theme",
    "thinking",
    "tools",
  ]);
  const optionalLongValueFlags = new Set(["list-models"]);
  const requiredShortValueFlags = new Set(["e", "n", "t", "xt"]);
  const oneShotBooleanFlags = new Set([flowFlag, "english", "japanese", "branch", "update"]);
  const entries: Array<{ text: string; initial: boolean }> = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg.startsWith("@")) continue;

    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      const flagName = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);

      if (flagName === "print" && eqIndex === -1) {
        const next = argv[index + 1];
        if (isPrintPromptToken(next)) {
          entries.push({ text: next.trim(), initial: true });
          index++;
        }
        continue;
      }

      if (oneShotBooleanFlags.has(flagName)) {
        if (eqIndex !== -1) {
          const value = arg.slice(eqIndex + 1).trim();
          if (value) entries.push({ text: value, initial: false });
          continue;
        }

        const next = argv[index + 1];
        if (isUnknownLongFlagValueToken(next)) {
          entries.push({ text: next.trim(), initial: false });
          index++;
        }
        continue;
      }

      if (eqIndex !== -1) continue;

      if (requiredLongValueFlags.has(flagName)) {
        if (argv[index + 1] !== undefined) index++;
        continue;
      }

      if (optionalLongValueFlags.has(flagName)) {
        if (isUnknownLongFlagValueToken(argv[index + 1])) index++;
        continue;
      }

      if (isUnknownLongFlagValueToken(argv[index + 1])) index++;
      continue;
    }

    if (arg.startsWith("-")) {
      const flagName = arg.slice(1);
      if (flagName === "p" && isPrintPromptToken(argv[index + 1])) {
        entries.push({ text: argv[index + 1].trim(), initial: true });
        index++;
      } else if (requiredShortValueFlags.has(flagName) && argv[index + 1] !== undefined) {
        index++;
      }
      continue;
    }

    entries.push({ text: arg.trim(), initial: true });
  }

  return {
    all: entries.map((entry) => entry.text).filter(Boolean),
    initialMessages: entries
      .filter((entry) => entry.initial)
      .map((entry) => entry.text)
      .filter(Boolean),
  };
}

function isUnknownLongFlagValueToken(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith("-") && !value.startsWith("@");
}

function isPrintPromptToken(value: string | undefined): value is string {
  return (
    value !== undefined &&
    !value.startsWith("@") &&
    (!value.startsWith("-") || value.startsWith("---"))
  );
}

export function captureOneShotFreeInput(event: {
  source?: unknown;
  text?: unknown;
}): string | null {
  if (event.source === "extension") return null;
  return typeof event.text === "string" ? event.text : "";
}

export function consumeOneShotFreeInput(
  pendingFreeInputs: string[],
  event: { source?: unknown; text?: unknown },
): boolean {
  if (pendingFreeInputs.length === 0) return false;

  const text = captureOneShotFreeInput(event)?.trim();
  if (!text) return false;

  const index = pendingFreeInputs.indexOf(text);
  if (index === -1) return false;
  pendingFreeInputs.splice(index, 1);
  return true;
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

function expandedSkillTextMatchesPrompt(skillName: string, text: string, prompt: string): boolean {
  const command = `/skill:${skillName}`;
  if (!prompt.startsWith(command)) return false;
  const args = prompt.slice(command.length).trim();
  return text.startsWith(`<skill name="${skillName}" `) && (!args || text.endsWith(`\n\n${args}`));
}

function userTextMatchesPrompt(skillName: string, text: string, prompt: string): boolean {
  return text === prompt || expandedSkillTextMatchesPrompt(skillName, text, prompt);
}

export function agentEndIncludesSkillPrompt(
  messages: unknown,
  skillName: string,
  prompt: string,
): boolean {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const record = message as { role?: unknown; content?: unknown };
    const text = record.role === "user" ? textFromContent(record.content) : undefined;
    return text !== undefined && userTextMatchesPrompt(skillName, text, prompt);
  });
}
