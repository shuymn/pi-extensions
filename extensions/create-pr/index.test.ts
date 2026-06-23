import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOneShotSharedFlagsForTest } from "../../lib/one-shot-flow";
import { ASK_USER_QUESTION_POLICY_EVENT } from "../ask-user-question/policy";
import commitExtension, { COMMIT_FLAG } from "../commit";
import createPrExtension, {
  buildCreatePrSkillPrompt,
  CREATE_PR_BASE_FLAG,
  CREATE_PR_ENGLISH_FLAG,
  CREATE_PR_FLAG,
  CREATE_PR_JAPANESE_FLAG,
  CREATE_PR_SAFE_TOOLS,
  CREATE_PR_UPDATE_FLAG,
  parseCreatePrLaunchOptions,
} from "./index";

type FlagDefinition = {
  description: string;
  type: "boolean" | "string";
  default?: unknown;
};

type Handler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;

type FakeContext = {
  hasUI: boolean;
  notifications: Array<{ message: string; level: "info" | "warning" | "error" }>;
  shutdowns: number;
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
  };
  shutdown: () => void;
};

const DEFAULT_TOOLS = [...CREATE_PR_SAFE_TOOLS, "edit", "write", "todo"];

function createSkillFixture(skillName: string) {
  const skillDir = mkdtempSync(join(tmpdir(), `pi-${skillName}-skill-`));
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillPath,
    `---\nname: ${skillName}\ndescription: Test ${skillName} skill\n---\n\n# ${skillName} skill\n`,
  );
  return { skillDir, skillPath };
}

const COMMIT_SKILL = createSkillFixture("commit");
const CREATE_PR_SKILL = createSkillFixture("create-pr");

function expandedSkillPrompt(skillName: "commit" | "create-pr", args = "") {
  const skill = skillName === "commit" ? COMMIT_SKILL : CREATE_PR_SKILL;
  const suffix = args ? `\n\n${args}` : "";
  return `<skill name="${skillName}" location="${skill.skillPath}">\nReferences are relative to ${skill.skillDir}.\n\n# ${skillName} skill\n</skill>${suffix}`;
}

function createFakePi(
  options: {
    flags?: Record<string, unknown>;
    tools?: string[];
    failSendUserMessage?: boolean;
  } = {},
) {
  const flags = new Map(Object.entries(options.flags ?? {}));
  const flagDefinitions = new Map<string, FlagDefinition>();
  const flagRegistrations: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const sentUserMessages: string[] = [];
  const activeToolsCalls: string[][] = [];
  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const tools = options.tools ?? DEFAULT_TOOLS;

  return {
    flagDefinitions,
    flagRegistrations,
    sentUserMessages,
    activeToolsCalls,
    emittedEvents,
    registerFlag(name: string, definition: FlagDefinition) {
      flagRegistrations.push(name);
      flagDefinitions.set(name, definition);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    getAllTools() {
      return tools.map((name) => ({ name }));
    },
    getCommands() {
      return [
        {
          name: "skill:commit",
          source: "skill",
          sourceInfo: { path: COMMIT_SKILL.skillPath, baseDir: COMMIT_SKILL.skillDir },
        },
        {
          name: "skill:create-pr",
          source: "skill",
          sourceInfo: { path: CREATE_PR_SKILL.skillPath, baseDir: CREATE_PR_SKILL.skillDir },
        },
      ];
    },
    setActiveTools(names: string[]) {
      activeToolsCalls.push([...names]);
    },
    sendUserMessage(message: string) {
      if (options.failSendUserMessage) throw new Error("send failed");
      sentUserMessages.push(message);
    },
    events: {
      emit(name: string, data: unknown) {
        emittedEvents.push({ name, data });
      },
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getEventHandlers(event: string) {
      return handlers.get(event) ?? [];
    },
  };
}

function createContext(hasUI = true): FakeContext {
  const ctx: FakeContext = {
    hasUI,
    notifications: [],
    shutdowns: 0,
    ui: {
      notify(message, level) {
        ctx.notifications.push({ message, level });
      },
    },
    shutdown() {
      ctx.shutdowns += 1;
    },
  };
  return ctx;
}

async function sessionStart(pi: ReturnType<typeof createFakePi>, ctx = createContext()) {
  await pi.getEventHandlers("session_start")[0]!({ reason: "startup" }, ctx);
  return ctx;
}

async function sessionStartAll(pi: ReturnType<typeof createFakePi>, ctx = createContext()) {
  for (const handler of pi.getEventHandlers("session_start")) {
    await handler({ reason: "startup" }, ctx);
  }
  return ctx;
}

function userMessage(content: string) {
  return { role: "user", content: [{ type: "text", text: content }] };
}

function expandedCreatePrSkillMessage(args = "") {
  const suffix = args ? `\n\n${args}` : "";
  return userMessage(
    `<skill name="create-pr" location="/skills/create-pr/SKILL.md">\nbody\n</skill>${suffix}`,
  );
}

async function agentEnd(
  pi: ReturnType<typeof createFakePi>,
  ctx = createContext(),
  messages: unknown[] = [],
) {
  await pi.getEventHandlers("agent_end")[0]!({ messages }, ctx);
  return ctx;
}

type CreatePrFlagValues = Parameters<typeof parseCreatePrLaunchOptions>[0];

function parseOptions(overrides: Partial<CreatePrFlagValues> = {}) {
  return parseCreatePrLaunchOptions({
    english: undefined,
    japanese: undefined,
    update: undefined,
    base: undefined,
    ...overrides,
  });
}

function withArgv<T>(argv: string[], callback: () => T): T {
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "bun", originalArgv[1] ?? "pi", ...argv];
  try {
    return callback();
  } finally {
    process.argv = originalArgv;
  }
}

async function withArgvAsync<T>(argv: string[], callback: () => Promise<T>): Promise<T> {
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "bun", originalArgv[1] ?? "pi", ...argv];
  try {
    return await callback();
  } finally {
    process.argv = originalArgv;
  }
}

describe("create-pr extension", () => {
  beforeEach(() => {
    resetOneShotSharedFlagsForTest();
  });

  test("registers create-pr startup flags", () => {
    const pi = createFakePi();

    createPrExtension(pi as never);

    expect(pi.flagDefinitions.get(CREATE_PR_FLAG)).toEqual({
      description: "Launch the create-pr skill as a bounded one-shot flow",
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(CREATE_PR_ENGLISH_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(CREATE_PR_JAPANESE_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(CREATE_PR_UPDATE_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(CREATE_PR_BASE_FLAG)).toMatchObject({ type: "string" });
    expect(pi.getEventHandlers("session_start")).toHaveLength(1);
    expect(pi.getEventHandlers("agent_end")).toHaveLength(1);
  });

  test("registers shared one-shot flags only once with commit extension", async () => {
    const pi = createFakePi({
      flags: { [CREATE_PR_FLAG]: true, [CREATE_PR_JAPANESE_FLAG]: true },
    });

    commitExtension(pi as never);
    createPrExtension(pi as never);
    const ctx = await sessionStartAll(pi);

    expect(pi.flagRegistrations.filter((name) => name === CREATE_PR_ENGLISH_FLAG)).toHaveLength(1);
    expect(pi.flagRegistrations.filter((name) => name === CREATE_PR_JAPANESE_FLAG)).toHaveLength(1);
    expect(pi.flagRegistrations.filter((name) => name === CREATE_PR_BASE_FLAG)).toHaveLength(1);
    expect(pi.sentUserMessages).toEqual([expandedSkillPrompt("create-pr", "--japanese")]);
    expect(ctx.shutdowns).toBe(0);
  });

  test("shared one-shot flags work when create-pr loads before commit", async () => {
    const pi = createFakePi({ flags: { [COMMIT_FLAG]: true, [CREATE_PR_ENGLISH_FLAG]: true } });

    createPrExtension(pi as never);
    commitExtension(pi as never);
    const ctx = await sessionStartAll(pi);

    expect(pi.flagRegistrations.filter((name) => name === CREATE_PR_ENGLISH_FLAG)).toHaveLength(1);
    expect(pi.sentUserMessages).toEqual([expandedSkillPrompt("commit", "--english")]);
    expect(ctx.shutdowns).toBe(0);
  });

  test("rejects multiple primary one-shot flags", async () => {
    const argv = ["--commit", "--create-pr"];
    const pi = withArgv(argv, () =>
      createFakePi({ flags: { [COMMIT_FLAG]: true, [CREATE_PR_FLAG]: true } }),
    );
    withArgv(argv, () => {
      commitExtension(pi as never);
      createPrExtension(pi as never);
    });

    const ctx = await withArgvAsync(argv, () => sessionStartAll(pi));

    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(pi.sentUserMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      { message: "--commit と --create-pr は同時に指定できません。", level: "error" },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("is inert when --create-pr is not present", async () => {
    const pi = createFakePi();
    createPrExtension(pi as never);
    const ctx = await sessionStart(pi);
    await agentEnd(pi, ctx);

    expect(pi.sentUserMessages).toEqual([]);
    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(ctx.notifications).toEqual([]);
    expect(ctx.shutdowns).toBe(0);
  });

  test("launches the create-pr skill with bounded questionnaire mode by default", async () => {
    const pi = createFakePi({ flags: { [CREATE_PR_FLAG]: true } });
    createPrExtension(pi as never);

    const ctx = await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([[...CREATE_PR_SAFE_TOOLS]]);
    expect(pi.emittedEvents).toEqual([
      {
        name: ASK_USER_QUESTION_POLICY_EVENT,
        data: { allowChatAboutThis: false },
      },
    ]);
    expect(pi.sentUserMessages).toEqual([expandedSkillPrompt("create-pr")]);
    expect(ctx.shutdowns).toBe(0);
  });

  test("builds Japanese base and update create-pr skill prompts", async () => {
    const createPi = createFakePi({
      flags: {
        [CREATE_PR_FLAG]: true,
        [CREATE_PR_JAPANESE_FLAG]: true,
        [CREATE_PR_BASE_FLAG]: "main",
      },
    });
    createPrExtension(createPi as never);

    await sessionStart(createPi);

    expect(createPi.sentUserMessages).toEqual([
      expandedSkillPrompt("create-pr", "--japanese --base=main"),
    ]);

    resetOneShotSharedFlagsForTest();
    const updatePi = createFakePi({
      flags: {
        [CREATE_PR_FLAG]: true,
        [CREATE_PR_JAPANESE_FLAG]: true,
        [CREATE_PR_UPDATE_FLAG]: true,
      },
    });
    createPrExtension(updatePi as never);

    await sessionStart(updatePi);

    expect(updatePi.sentUserMessages).toEqual([
      expandedSkillPrompt("create-pr", "--japanese --update"),
    ]);
  });

  test("appends CLI free-form input and handles the duplicate initial prompt", async () => {
    const argv = ["--create-pr", "--japanese", "draft only", "extra note"];
    const pi = withArgv(argv, () =>
      createFakePi({ flags: { [CREATE_PR_FLAG]: true, [CREATE_PR_JAPANESE_FLAG]: true } }),
    );
    withArgv(argv, () => createPrExtension(pi as never));

    const ctx = await sessionStart(pi);

    expect(pi.sentUserMessages).toEqual([
      expandedSkillPrompt("create-pr", "--japanese\n\ndraft only\n\nextra note"),
    ]);
    await expect(
      pi.getEventHandlers("input")[0]!(
        { source: "interactive", text: "extra note" },
        createContext(),
      ),
    ).resolves.toEqual({ action: "handled" });

    await agentEnd(pi, ctx, [
      expandedCreatePrSkillMessage("--japanese\n\ndraft only\n\nextra note"),
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("filters active tools to the available create-pr-safe allowlist", async () => {
    const pi = createFakePi({
      flags: { [CREATE_PR_FLAG]: true },
      tools: ["read", "bash", "write", "edit", "ask_user_question", "todo"],
    });
    createPrExtension(pi as never);

    await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([["read", "bash", "ask_user_question"]]);
    expect(pi.sentUserMessages).toEqual([expandedSkillPrompt("create-pr")]);
  });

  test("does not launch when ask_user_question is unavailable", async () => {
    const pi = createFakePi({
      flags: { [CREATE_PR_FLAG]: true },
      tools: ["read", "bash", "grep", "find", "ls"],
    });
    createPrExtension(pi as never);

    const ctx = await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(pi.sentUserMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      {
        message:
          "--create-pr には ask_user_question LLM Tool が必要です。create-pr skill は起動しません。",
        level: "error",
      },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("rejects --base with --update", async () => {
    const pi = createFakePi({
      flags: {
        [CREATE_PR_FLAG]: true,
        [CREATE_PR_UPDATE_FLAG]: true,
        [CREATE_PR_BASE_FLAG]: "main",
      },
    });
    createPrExtension(pi as never);

    const ctx = await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(pi.sentUserMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      { message: "--base は --update と同時に指定できません。", level: "error" },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("launches only once and shuts down after the active create-pr agent run ends", async () => {
    const pi = createFakePi({ flags: { [CREATE_PR_FLAG]: true } });
    createPrExtension(pi as never);
    const ctx = createContext();

    await sessionStart(pi, ctx);
    await sessionStart(pi, ctx);

    expect(pi.sentUserMessages).toEqual([expandedSkillPrompt("create-pr")]);
    expect(pi.emittedEvents).toHaveLength(1);

    await agentEnd(pi, ctx, [expandedCreatePrSkillMessage()]);
    await agentEnd(pi, ctx, [expandedCreatePrSkillMessage()]);

    expect(ctx.shutdowns).toBe(1);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: true } },
    ]);
  });

  test("ignores non-matching agent_end before the create-pr agent run ends", async () => {
    const pi = createFakePi({ flags: { [CREATE_PR_FLAG]: true } });
    createPrExtension(pi as never);
    const ctx = createContext();

    await sessionStart(pi, ctx);
    await agentEnd(pi, ctx, [userMessage("Unrelated prompt")]);

    expect(ctx.shutdowns).toBe(0);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
    ]);

    await agentEnd(pi, ctx, [expandedCreatePrSkillMessage()]);

    expect(ctx.shutdowns).toBe(1);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: true } },
    ]);
  });

  test("startup send failures reset questionnaire policy and request shutdown", async () => {
    const pi = createFakePi({ flags: { [CREATE_PR_FLAG]: true }, failSendUserMessage: true });
    createPrExtension(pi as never);

    const ctx = await sessionStart(pi);
    await agentEnd(pi, ctx, [expandedCreatePrSkillMessage()]);

    expect(pi.sentUserMessages).toEqual([]);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: true } },
    ]);
    expect(ctx.notifications).toEqual([
      { message: "create-pr one-shot の起動に失敗しました: send failed", level: "error" },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("validates option flags and builds prompts deterministically", () => {
    expect(parseOptions()).toEqual({ ok: true, options: { update: false } });
    expect(parseOptions({ english: true, japanese: false, update: false })).toEqual({
      ok: true,
      options: { language: "english", update: false },
    });
    expect(parseOptions({ english: true, japanese: true, update: false })).toEqual({
      ok: false,
      message: "--english と --japanese は同時に指定できません。",
    });
    expect(parseOptions({ update: false, base: "  " })).toEqual({
      ok: false,
      message: "--base には空でない base branch 名を指定してください。",
    });
    for (const base of ["main --japanese", "main\nnext", "--main", "@{upstream}"]) {
      expect(parseOptions({ update: false, base })).toEqual({
        ok: false,
        message: "--base には main や origin/main のような安全な branch/ref 名を指定してください。",
      });
    }
    expect(buildCreatePrSkillPrompt({ update: false, base: "develop" })).toBe(
      "/skill:create-pr --base=develop",
    );
    expect(buildCreatePrSkillPrompt({ language: "english", update: false })).toBe(
      "/skill:create-pr",
    );
    expect(buildCreatePrSkillPrompt({ language: "japanese", update: true })).toBe(
      "/skill:create-pr --japanese --update",
    );
  });
});
