import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOneShotFreeInput,
  collectOneShotCliFreeInputs,
  expandOneShotSkillPrompt,
  registerOneShotSharedFlags,
  resetOneShotSharedFlagsForTest,
} from "./one-shot-flow";

function createSkillFixture(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `pi-${name}-skill-`));
  const skillDir = join(dir, name);
  mkdirSync(skillDir);
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillPath,
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name} skill\n\nUse this skill.\n`,
  );
  return { skillDir, skillPath };
}

function createSharedFlagPi(values: Record<string, unknown>) {
  const registered = new Set<string>();
  const shutdownHandlers: Array<() => unknown | Promise<unknown>> = [];

  return {
    registered,
    shutdownHandlers,
    registerFlag(name: string) {
      registered.add(name);
    },
    getFlag(name: string) {
      return registered.has(name) ? values[name] : undefined;
    },
    on(event: string, handler: () => unknown | Promise<unknown>) {
      if (event === "session_shutdown") shutdownHandlers.push(handler);
    },
  };
}

describe("one-shot flow helpers", () => {
  test("appends free-form input as skill arguments", () => {
    expect(appendOneShotFreeInput("/skill:commit", [" focus staged files "])).toBe(
      "/skill:commit focus staged files",
    );
    expect(appendOneShotFreeInput("/skill:create-pr --japanese", [" draft only "])).toBe(
      "/skill:create-pr --japanese\n\ndraft only",
    );
  });

  test("expands one-shot skill prompts before extension sendUserMessage", () => {
    const { skillDir, skillPath } = createSkillFixture("commit");
    const pi = {
      getCommands() {
        return [
          {
            name: "skill:commit",
            source: "skill",
            sourceInfo: { path: skillPath, baseDir: skillDir },
          },
        ];
      },
    };

    expect(expandOneShotSkillPrompt(pi as never, "commit", "/skill:commit --english")).toBe(
      `<skill name="commit" location="${skillPath}">\nReferences are relative to ${skillDir}.\n\n# commit skill\n\nUse this skill.\n</skill>\n\n--english`,
    );
  });

  test("collects CLI free-form input lost behind boolean one-shot flags", () => {
    expect(
      collectOneShotCliFreeInputs("commit", [
        "--model",
        "provider/model",
        "--commit",
        "--english",
        "focus staged files",
        "--base",
        "main",
        "extra instruction",
      ]),
    ).toEqual({
      all: ["focus staged files", "extra instruction"],
      initialMessages: ["extra instruction"],
    });
  });

  test("matches Pi CLI parsing for neighboring value flags and print prompts", () => {
    expect(collectOneShotCliFreeInputs("commit", ["--commit", "--other", "value", "note"])).toEqual(
      {
        all: ["note"],
        initialMessages: ["note"],
      },
    );
    expect(collectOneShotCliFreeInputs("commit", ["--commit", "-p", "---note"])).toEqual({
      all: ["---note"],
      initialMessages: ["---note"],
    });
    expect(collectOneShotCliFreeInputs("commit", ["--commit", "--print", "---note"])).toEqual({
      all: ["---note"],
      initialMessages: ["---note"],
    });
    expect(collectOneShotCliFreeInputs("commit", ["--commit", "--name", "--base", "main"])).toEqual(
      {
        all: ["main"],
        initialMessages: ["main"],
      },
    );
    expect(
      collectOneShotCliFreeInputs("commit", ["--commit", "--name", "--english", "msg"]),
    ).toEqual({
      all: ["msg"],
      initialMessages: ["msg"],
    });
  });

  test("ignores argv unless the matching one-shot flag is present", () => {
    expect(collectOneShotCliFreeInputs("create-pr", ["--commit", "note"])).toEqual({
      all: [],
      initialMessages: [],
    });
  });

  test("clears shared flag reader on session shutdown", async () => {
    resetOneShotSharedFlagsForTest();
    const firstPi = createSharedFlagPi({ english: true, japanese: false, base: "old-main" });
    const firstReader = registerOneShotSharedFlags(firstPi as never);
    expect(firstPi.registered.has("english")).toBe(true);

    for (const handler of firstPi.shutdownHandlers) await handler();

    const secondPi = createSharedFlagPi({ english: false, japanese: true, base: "new-main" });
    const secondReader = registerOneShotSharedFlags(secondPi as never);

    expect(secondReader).not.toBe(firstReader);
    expect(secondPi.registered.has("english")).toBe(true);
    expect(secondReader()).toEqual({ english: false, japanese: true, base: "new-main" });
  });
});
