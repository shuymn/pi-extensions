import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { notifyIfUI } from "../../lib/tui";

const COMMAND_NAME = "copy-file";
const RESULT_FILE_PREFIX = "RESULT_";
const RESULT_FILE_EXTENSION = ".md";
const MAX_FILENAME_ATTEMPTS = 10;

type TextContentBlock = { type?: string; text?: string };
type AssistantMessageLike = {
  role?: string;
  content?: unknown;
};
type SessionEntryLike = {
  type?: string;
  message?: unknown;
};

type CopyResultOptions = {
  createUniqueIdentifier?: () => string;
};

function collectTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts = content
    .map((block): string | undefined => {
      if (block == null) return undefined;
      const candidate = block as TextContentBlock;
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : undefined;
    })
    .filter((part): part is string => part !== undefined && part !== "");

  return parts.length > 0 ? parts.join("\n").trimEnd() : undefined;
}

function getAssistantText(message: unknown): string | undefined {
  const candidate = message as AssistantMessageLike;
  if (candidate?.role !== "assistant") return undefined;
  return collectTextContent(candidate.content);
}

export function getLatestAssistantTextFromEntries(entries: unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as SessionEntryLike;
    if (entry?.type !== "message") continue;

    const text = getAssistantText(entry.message);
    if (text !== undefined && text.trim().length > 0) return text;
  }

  return undefined;
}

export function createResultFileName(uniqueIdentifier: string): string {
  return `${RESULT_FILE_PREFIX}${uniqueIdentifier}${RESULT_FILE_EXTENSION}`;
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function writeUniqueResultFile(
  cwd: string,
  text: string,
  createUniqueIdentifier: () => string,
): Promise<string> {
  const data = `${text.trimEnd()}\n`;

  for (let attempt = 0; attempt < MAX_FILENAME_ATTEMPTS; attempt += 1) {
    const fileName = createResultFileName(createUniqueIdentifier());
    const path = join(cwd, fileName);

    try {
      await writeFile(path, data, { flag: "wx" });
      return fileName;
    } catch (error) {
      if (isFileExistsError(error)) continue;
      throw error;
    }
  }

  throw new Error(
    `RESULT_*.md のファイル名が ${MAX_FILENAME_ATTEMPTS} 回連続で衝突しました。不要な RESULT_*.md を削除して再実行してください。`,
  );
}

export default function copyFileExtension(pi: ExtensionAPI, options: CopyResultOptions = {}) {
  const createUniqueIdentifier = options.createUniqueIdentifier ?? (() => crypto.randomUUID());

  pi.registerCommand(COMMAND_NAME, {
    description: "Write the last assistant message to RESULT_<unique_identifier>.md in cwd",
    handler: async (_args, ctx) => {
      const text = getLatestAssistantTextFromEntries(ctx.sessionManager.getBranch());
      if (!text) {
        notifyIfUI(ctx, "保存できるアシスタントメッセージがまだありません。", "warning");
        return;
      }

      try {
        const fileName = await writeUniqueResultFile(ctx.cwd, text, createUniqueIdentifier);
        notifyIfUI(ctx, `${fileName} に保存しました。`, "info");
      } catch (error) {
        notifyIfUI(
          ctx,
          `RESULT ファイルの保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
