import {
  type ExecResult,
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { hasWhitespaceOrControl } from "../../lib/text";

const COMMAND_NAME = "wt";
const COMMAND_DESCRIPTION = "Create a git-wt worktree and continue this persisted session there";
const GIT_WT_TIMEOUT_MS = 120_000;
const SESSION_MOVE_MESSAGE_TYPE = "wt-session-move";
const DEFAULT_IGNORABLE_CHARACTER_PATTERN = /\p{Default_Ignorable_Code_Point}/u;

export type WtArguments = {
  worktreeName: string;
  startPoint?: string;
};

type ParseWtArgumentsOptions = {
  now?: Date;
};

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function createDefaultWorktreeName(now = new Date()): string {
  return [
    "wip/",
    now.getFullYear().toString(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function hasUnsafeCharacter(value: string): boolean {
  return hasWhitespaceOrControl(value) || DEFAULT_IGNORABLE_CHARACTER_PATTERN.test(value);
}

function assertSafeGitArgument(value: string, label: string): void {
  if (!value) throw new Error(`${label} を指定してください。`);
  if (hasUnsafeCharacter(value)) {
    throw new Error(`${label} に空白文字・制御文字・不可視文字は使用できません: ${value}`);
  }
  if (value.startsWith("-") || value.startsWith("@")) {
    throw new Error(`${label} は '-' または '@' で開始できません: ${value}`);
  }
  if (value.includes("..") || value.includes("@{")) {
    throw new Error(`${label} に unsafe な git ref 構文は使用できません: ${value}`);
  }
  if (value.endsWith("/") || value.endsWith(".")) {
    throw new Error(`${label} は '/' または '.' で終了できません: ${value}`);
  }
  if (value.endsWith(".lock")) {
    throw new Error(`${label} は .lock で終了できません: ${value}`);
  }
}

function trimAsciiWhitespace(value: string): string {
  return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

export function parseWtArguments(args: string, options: ParseWtArgumentsOptions = {}): WtArguments {
  const trimmedArgs = trimAsciiWhitespace(args);
  const tokens = trimmedArgs.length === 0 ? [] : trimmedArgs.split(/[\t\n\r ]+/u);
  if (tokens.length > 2) {
    throw new Error("使い方: /wt [worktree-name] [start-point]");
  }

  const worktreeName = tokens[0] ?? createDefaultWorktreeName(options.now);
  const startPoint = tokens[1];
  assertSafeGitArgument(worktreeName, "worktree name");
  if (startPoint !== undefined) assertSafeGitArgument(startPoint, "start point");

  return { worktreeName, startPoint };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function findWorktreeSpecificPath(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const path = findWorktreeSpecificPath(item);
      if (path) return path;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["worktreePath", "worktree_path"]) {
    const path = asNonEmptyString(record[key]);
    if (path) return path;
  }

  const worktreePath = asNonEmptyString(record.worktree) ?? findGenericPath(record.worktree);
  if (worktreePath) return worktreePath;

  for (const [key, nested] of Object.entries(record)) {
    if (["worktree", "worktreePath", "worktree_path"].includes(key)) continue;
    const path = findWorktreeSpecificPath(nested);
    if (path) return path;
  }
  return undefined;
}

function findGenericPath(value: unknown): string | undefined {
  const plainPath = asNonEmptyString(value);
  if (plainPath) return plainPath;
  if (value === null || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (const item of value) {
      const path = findGenericPath(item);
      if (path) return path;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const path = asNonEmptyString(record.path);
  if (path) return path;

  for (const [key, nested] of Object.entries(record)) {
    if (key === "path") continue;
    const nestedPath = findGenericPath(nested);
    if (nestedPath) return nestedPath;
  }
  return undefined;
}

function findPathInJson(value: unknown): string | undefined {
  return findWorktreeSpecificPath(value) ?? findGenericPath(value);
}

function isPlainPathLine(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export function parseGitWtCreatePath(stdout: string): string {
  const output = stdout.trim();
  if (!output) throw new Error("git-wt の出力から worktree path を取得できませんでした。");

  if (output.startsWith("{") || output.startsWith("[")) {
    try {
      const parsed = JSON.parse(output);
      const path = asNonEmptyString(parsed) ?? findPathInJson(parsed);
      if (path) return path;
    } catch {
      // Fall through to plain-line parsing for compatibility with non-JSON output.
    }
  }

  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !(line.startsWith("{") || line.startsWith("[")));

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (isPlainPathLine(line)) return line;
  }
  if (lines.length === 1) return lines[0]!;

  throw new Error("git-wt の出力から worktree path を取得できませんでした。");
}

export type WtExtensionOptions = {
  now?: () => Date;
};

type SessionMoveDetails = {
  fromCwd: string;
  toCwd: string;
  worktreeName: string;
  startPoint?: string;
};

function formatCommandOutput(stderr: string, stdout: string): string {
  return [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createSessionMoveMessage(details: SessionMoveDetails): string {
  return [
    "The current Pi session has moved into a git-wt worktree.",
    `Previous cwd: ${details.fromCwd}`,
    `Current cwd: ${details.toCwd}`,
    `Worktree name: ${details.worktreeName}`,
    details.startPoint ? `Start point: ${details.startPoint}` : undefined,
    "Use the current cwd for future file operations unless the user explicitly asks otherwise.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export default function wtExtension(pi: ExtensionAPI, options: WtExtensionOptions = {}) {
  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      let parsed: WtArguments;
      try {
        parsed = parseWtArguments(args, { now: options.now?.() });
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      const sourceSessionFile = ctx.sessionManager.getSessionFile();
      if (!sourceSessionFile) {
        ctx.ui.notify("永続化されたセッションがないため /wt を実行できません。", "error");
        return;
      }

      const gitWtArgs = ["--nocd", "--json", parsed.worktreeName];
      if (parsed.startPoint) gitWtArgs.push(parsed.startPoint);

      let result: ExecResult;
      try {
        result = await pi.exec("git-wt", gitWtArgs, {
          cwd: ctx.cwd,
          timeout: GIT_WT_TIMEOUT_MS,
        });
      } catch (error) {
        ctx.ui.notify(`git-wt の実行に失敗しました: ${errorMessage(error)}`, "error");
        return;
      }

      if (result.code !== 0) {
        const output = formatCommandOutput(result.stderr, result.stdout);
        ctx.ui.notify(
          `git-wt の実行に失敗しました (exit ${result.code})${output ? `: ${output}` : ""}`,
          "error",
        );
        return;
      }

      let worktreePath: string;
      try {
        worktreePath = parseGitWtCreatePath(result.stdout);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      let forkedSessionManager: SessionManager;
      try {
        forkedSessionManager = SessionManager.forkFrom(sourceSessionFile, worktreePath);
      } catch (error) {
        ctx.ui.notify(`セッションのコピーに失敗しました: ${errorMessage(error)}`, "error");
        return;
      }

      // SessionManager.forkFrom always returns a persisted session.
      const forkedSessionFile = forkedSessionManager.getSessionFile()!;

      const details: SessionMoveDetails = {
        fromCwd: ctx.cwd,
        toCwd: worktreePath,
        worktreeName: parsed.worktreeName,
        ...(parsed.startPoint ? { startPoint: parsed.startPoint } : {}),
      };
      forkedSessionManager.appendCustomMessageEntry(
        SESSION_MOVE_MESSAGE_TYPE,
        createSessionMoveMessage(details),
        true,
        details,
      );

      const switchResult = await ctx.switchSession(forkedSessionFile, {
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify(`worktree に移動しました: ${worktreePath}`, "info");
        },
      });

      if (switchResult.cancelled) {
        ctx.ui.notify(
          `worktree とセッションを作成しましたが、セッション切替はキャンセルされました: ${worktreePath}`,
          "warning",
        );
      }
    },
  });
}
