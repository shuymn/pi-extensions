import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createFakePi as createBaseFakePi } from "../../tests/support/fake-pi";
import copyFileExtension, {
  createResultFileName,
  getLatestAssistantTextFromEntries,
} from "./index";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
};

type FakeCommandContext = {
  cwd: string;
  hasUI: boolean;
  sessionManager: {
    getBranch: () => unknown[];
  };
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
  };
};

function createFakePi() {
  return createBaseFakePi<never, CommandDefinition>();
}

function createContext(cwd: string, entries: unknown[]) {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  const ctx: FakeCommandContext = {
    cwd,
    hasUI: true,
    sessionManager: {
      getBranch: () => entries,
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  return { ctx, notifications };
}

function assistantEntry(text: string) {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

describe("copy-file extension", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("registers /copy-file command", () => {
    const pi = createFakePi();

    copyFileExtension(pi as never);

    expect(pi.commands.get("copy-file")?.description).toBe(
      "Write the last assistant message to RESULT_<unique_identifier>.md in cwd",
    );
  });

  test("creates RESULT_<unique_identifier>.md containing the latest assistant message", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "copy-file-test-"));
    const pi = createFakePi();
    copyFileExtension(pi as never);
    const { ctx, notifications } = createContext(tempDir, [
      assistantEntry("old"),
      { type: "message", message: { role: "user", content: "continue" } },
      assistantEntry("new result"),
    ]);

    await pi.commands.get("copy-file")!.handler("", ctx);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("info");
    const match = notifications[0]!.message.match(/RESULT_[a-f0-9-]+\.md/);
    expect(match).not.toBeNull();
    const fileName = match![0]!;
    expect(basename(fileName)).toBe(fileName);
    expect(existsSync(join(tempDir, fileName))).toBe(true);
    expect(readFileSync(join(tempDir, fileName), "utf8")).toBe("new result\n");
  });

  test("does not overwrite when generated identifier collides", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "copy-file-collision-test-"));
    const fileName = createResultFileName("duplicate");
    const existingPath = join(tempDir, fileName);
    await Bun.write(existingPath, "existing");

    const pi = createFakePi();
    copyFileExtension(pi as never, {
      createUniqueIdentifier: (() => {
        const values = ["duplicate", "unique"];
        return () => values.shift() ?? "unexpected";
      })(),
    });
    const { ctx } = createContext(tempDir, [assistantEntry("content")]);

    await pi.commands.get("copy-file")!.handler("", ctx);

    expect(readFileSync(existingPath, "utf8")).toBe("existing");
    expect(readFileSync(join(tempDir, createResultFileName("unique")), "utf8")).toBe("content\n");
  });

  test("reports exhausted filename collisions in Japanese", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "copy-file-collision-limit-test-"));
    const existingPath = join(tempDir, createResultFileName("duplicate"));
    await Bun.write(existingPath, "existing");

    const pi = createFakePi();
    copyFileExtension(pi as never, { createUniqueIdentifier: () => "duplicate" });
    const { ctx, notifications } = createContext(tempDir, [assistantEntry("content")]);

    await pi.commands.get("copy-file")!.handler("", ctx);

    expect(readFileSync(existingPath, "utf8")).toBe("existing");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("error");
    expect(notifications[0]!.message).toContain(
      "RESULT_*.md のファイル名が 10 回連続で衝突しました。",
    );
    expect(notifications[0]!.message).not.toContain("collision limit exceeded");
  });

  test("does not append a duplicate trailing newline", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "copy-file-newline-test-"));
    const pi = createFakePi();
    copyFileExtension(pi as never, { createUniqueIdentifier: () => "newline" });
    const { ctx } = createContext(tempDir, [assistantEntry("content\n")]);

    await pi.commands.get("copy-file")!.handler("", ctx);

    expect(readFileSync(join(tempDir, createResultFileName("newline")), "utf8")).toBe("content\n");
  });

  test("warns when no assistant message exists", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "copy-file-empty-test-"));
    const pi = createFakePi();
    copyFileExtension(pi as never);
    const { ctx, notifications } = createContext(tempDir, [
      { type: "message", message: { role: "user", content: "hello" } },
    ]);

    await pi.commands.get("copy-file")!.handler("", ctx);

    expect(notifications).toEqual([
      { message: "保存できるアシスタントメッセージがまだありません。", level: "warning" },
    ]);
  });

  test("extracts latest assistant text from branch entries", () => {
    expect(
      getLatestAssistantTextFromEntries([assistantEntry("first"), assistantEntry("second\npart")]),
    ).toBe("second\npart");
  });

  test("ignores malformed and empty assistant content blocks", () => {
    expect(
      getLatestAssistantTextFromEntries([
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              null,
              undefined,
              { type: "text", text: "" },
              { type: "tool_use", text: "ignored" },
              { type: "text", text: "usable" },
            ],
          },
        },
      ]),
    ).toBe("usable");
  });
});
