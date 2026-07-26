import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOneShotSharedFlagsForTest } from "../../lib/one-shot-flow";
import { ASK_USER_QUESTION_POLICY_EVENT } from "../ask-user-question/policy";
import commitExtension, {
  buildCommitSkillPrompt,
  COMMIT_BASE_FLAG,
  COMMIT_BRANCH_FLAG,
  COMMIT_ENGLISH_FLAG,
  COMMIT_FLAG,
  COMMIT_JAPANESE_FLAG,
  COMMIT_SAFE_TOOLS,
  parseCommitLaunchOptions,
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
  isIdle: () => boolean;
};

const DEFAULT_TOOLS = [...COMMIT_SAFE_TOOLS, "edit", "write", "todo"];
const COMMIT_SKILL_DIR = mkdtempSync(join(tmpdir(), "pi-commit-skill-"));
const COMMIT_SKILL_PATH = join(COMMIT_SKILL_DIR, "SKILL.md");
writeFileSync(
  COMMIT_SKILL_PATH,
  "---\nname: commit\ndescription: Test commit skill\n---\n\n# Commit skill\n",
);

function expandedCommitSkillPrompt(args = "") {
  const suffix = args ? `\n\n${args}` : "";
  return `<skill name="commit" location="${COMMIT_SKILL_PATH}">\nReferences are relative to ${COMMIT_SKILL_DIR}.\n\n# Commit skill\n</skill>${suffix}`;
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
  const handlers = new Map<string, Handler[]>();
  const sentUserMessages: string[] = [];
  const activeToolsCalls: string[][] = [];
  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const tools = options.tools ?? DEFAULT_TOOLS;

  return {
    flagDefinitions,
    sentUserMessages,
    activeToolsCalls,
    emittedEvents,
    registerFlag(name: string, definition: FlagDefinition) {
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
          sourceInfo: { path: COMMIT_SKILL_PATH, baseDir: COMMIT_SKILL_DIR },
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

function createContext(hasUI = true, idle = true): FakeContext {
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
    isIdle: () => idle,
  };
  return ctx;
}

async function sessionStart(pi: ReturnType<typeof createFakePi>, ctx = createContext()) {
  await pi.getEventHandlers("session_start")[0]!({ reason: "startup" }, ctx);
  return ctx;
}

function userMessage(content: string) {
  return { role: "user", content: [{ type: "text", text: content }] };
}

function expandedCommitSkillMessage(args = "") {
  const suffix = args ? `\n\n${args}` : "";
  return userMessage(
    `<skill name="commit" location="/skills/commit/SKILL.md">\nbody\n</skill>${suffix}`,
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

async function agentSettled(pi: ReturnType<typeof createFakePi>, ctx = createContext()) {
  await pi.getEventHandlers("agent_settled")[0]!({}, ctx);
  return ctx;
}

type CommitFlagValues = Parameters<typeof parseCommitLaunchOptions>[0];

function parseOptions(overrides: Partial<CommitFlagValues> = {}) {
  return parseCommitLaunchOptions({
    english: undefined,
    japanese: undefined,
    branch: undefined,
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

describe("commit extension", () => {
  beforeEach(() => {
    resetOneShotSharedFlagsForTest();
  });
  test("registers commit startup flags", () => {
    const pi = createFakePi();

    commitExtension(pi as never);

    expect(pi.flagDefinitions.get(COMMIT_FLAG)).toEqual({
      description: "Launch the commit skill as a bounded one-shot flow",
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(COMMIT_ENGLISH_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(COMMIT_JAPANESE_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(COMMIT_BRANCH_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(COMMIT_BASE_FLAG)).toMatchObject({ type: "string" });
    expect(pi.getEventHandlers("session_start")).toHaveLength(1);
    expect(pi.getEventHandlers("agent_end")).toHaveLength(1);
    expect(pi.getEventHandlers("agent_settled")).toHaveLength(1);
  });

  test("is inert when --commit is not present", async () => {
    const pi = createFakePi();
    commitExtension(pi as never);
    const ctx = await sessionStart(pi);
    await agentEnd(pi, ctx);

    expect(pi.sentUserMessages).toEqual([]);
    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(ctx.notifications).toEqual([]);
    expect(ctx.shutdowns).toBe(0);
  });

  test("launches the commit skill with bounded questionnaire mode by default", async () => {
    const pi = createFakePi({ flags: { [COMMIT_FLAG]: true } });
    commitExtension(pi as never);

    const ctx = await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([[...COMMIT_SAFE_TOOLS]]);
    expect(pi.emittedEvents).toEqual([
      {
        name: ASK_USER_QUESTION_POLICY_EVENT,
        data: { allowChatAboutThis: false },
      },
    ]);
    expect(pi.sentUserMessages).toEqual([expandedCommitSkillPrompt()]);
    expect(ctx.shutdowns).toBe(0);
  });

  test("builds English commit skill prompts when requested", async () => {
    const pi = createFakePi({
      flags: { [COMMIT_FLAG]: true, [COMMIT_ENGLISH_FLAG]: true },
    });
    commitExtension(pi as never);

    await sessionStart(pi);

    expect(pi.sentUserMessages).toEqual([expandedCommitSkillPrompt("--english")]);
  });

  test("builds Japanese branch/base commit skill prompts", async () => {
    const pi = createFakePi({
      flags: {
        [COMMIT_FLAG]: true,
        [COMMIT_JAPANESE_FLAG]: true,
        [COMMIT_BRANCH_FLAG]: true,
        [COMMIT_BASE_FLAG]: "main",
      },
    });
    commitExtension(pi as never);

    await sessionStart(pi);

    expect(pi.sentUserMessages).toEqual([
      expandedCommitSkillPrompt("--japanese --branch --base=main"),
    ]);
  });

  test("appends CLI free-form input and handles the duplicate initial prompt", async () => {
    const pi = withArgv(["--commit", "--english", "focus staged files", "additional note"], () =>
      createFakePi({ flags: { [COMMIT_FLAG]: true, [COMMIT_ENGLISH_FLAG]: true } }),
    );
    withArgv(["--commit", "--english", "focus staged files", "additional note"], () =>
      commitExtension(pi as never),
    );

    const ctx = await sessionStart(pi);

    expect(pi.sentUserMessages).toEqual([
      expandedCommitSkillPrompt("--english\n\nfocus staged files\n\nadditional note"),
    ]);
    await expect(
      pi.getEventHandlers("input")[0]!(
        { source: "interactive", text: "additional note" },
        createContext(),
      ),
    ).resolves.toEqual({ action: "handled" });

    await agentEnd(pi, ctx, [
      expandedCommitSkillMessage("--english\n\nfocus staged files\n\nadditional note"),
    ]);
    expect(ctx.shutdowns).toBe(0);
    await agentSettled(pi, ctx);
    expect(ctx.shutdowns).toBe(1);
  });

  test("filters active tools to the available commit-safe allowlist", async () => {
    const pi = createFakePi({
      flags: { [COMMIT_FLAG]: true },
      tools: ["read", "bash", "write", "edit", "ask_user_question", "todo"],
    });
    commitExtension(pi as never);

    await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([["read", "bash", "ask_user_question"]]);
    expect(pi.sentUserMessages).toEqual([expandedCommitSkillPrompt()]);
  });

  test("does not launch when ask_user_question is unavailable", async () => {
    const pi = createFakePi({
      flags: { [COMMIT_FLAG]: true },
      tools: ["read", "bash", "grep", "find", "ls"],
    });
    commitExtension(pi as never);

    const ctx = await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(pi.sentUserMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      {
        message:
          "--commit には ask_user_question LLM Tool が必要です。commit skill は起動しません。",
        level: "error",
      },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("rejects --base without --branch", async () => {
    const pi = createFakePi({
      flags: { [COMMIT_FLAG]: true, [COMMIT_BASE_FLAG]: "main" },
    });
    commitExtension(pi as never);

    const ctx = await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(pi.sentUserMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      { message: "--base は --branch と一緒に指定してください。", level: "error" },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("launches only once and shuts down after the active commit agent run settles", async () => {
    const pi = createFakePi({ flags: { [COMMIT_FLAG]: true } });
    commitExtension(pi as never);
    const ctx = createContext();

    await sessionStart(pi, ctx);
    await sessionStart(pi, ctx);

    expect(pi.sentUserMessages).toEqual([expandedCommitSkillPrompt()]);
    expect(pi.emittedEvents).toHaveLength(1);

    await agentEnd(pi, ctx, [expandedCommitSkillMessage()]);
    await agentEnd(pi, ctx, [expandedCommitSkillMessage()]);

    expect(ctx.shutdowns).toBe(0);
    await agentSettled(pi, ctx);
    await agentSettled(pi, ctx);

    expect(ctx.shutdowns).toBe(1);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: true } },
    ]);
  });

  test("waits for an idle settled event before shutting down", async () => {
    const pi = createFakePi({ flags: { [COMMIT_FLAG]: true } });
    commitExtension(pi as never);
    const ctx = createContext();

    await sessionStart(pi, ctx);
    await agentEnd(pi, ctx, [{ role: "assistant", content: "provider failure" }]);
    await agentSettled(pi, createContext(true, false));
    expect(ctx.shutdowns).toBe(0);

    await agentSettled(pi, ctx);
    expect(ctx.shutdowns).toBe(1);
  });

  test("recognizes the active one-shot agent_end without transcript matching", async () => {
    const pi = createFakePi({ flags: { [COMMIT_FLAG]: true } });
    commitExtension(pi as never);
    const ctx = createContext();

    await sessionStart(pi, ctx);
    await agentEnd(pi, ctx, [userMessage("Unrelated prompt")]);

    expect(ctx.shutdowns).toBe(0);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
    ]);

    await agentEnd(pi, ctx, [expandedCommitSkillMessage()]);

    expect(ctx.shutdowns).toBe(0);
    await agentSettled(pi, ctx);
    expect(ctx.shutdowns).toBe(1);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: true } },
    ]);
  });

  test("startup send failures reset questionnaire policy and request shutdown", async () => {
    const pi = createFakePi({ flags: { [COMMIT_FLAG]: true }, failSendUserMessage: true });
    commitExtension(pi as never);

    const ctx = await sessionStart(pi);
    await agentEnd(pi, ctx, [expandedCommitSkillMessage()]);

    expect(pi.sentUserMessages).toEqual([]);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: true } },
    ]);
    expect(ctx.notifications).toEqual([
      { message: "commit one-shot の起動に失敗しました: send failed", level: "error" },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("validates option flags and builds prompts deterministically", () => {
    expect(parseOptions()).toEqual({ ok: true, options: { branch: false } });
    expect(parseOptions({ english: true, japanese: false, branch: false })).toEqual({
      ok: true,
      options: { language: "english", branch: false },
    });
    expect(parseOptions({ english: true, japanese: true, branch: false })).toEqual({
      ok: false,
      message: "--english と --japanese は同時に指定できません。",
    });
    expect(parseOptions({ branch: true, base: "  " })).toEqual({
      ok: false,
      message: "--base には空でない base branch 名を指定してください。",
    });
    for (const base of ["main --japanese", "main\nnext", "--main", "@{upstream}"]) {
      expect(parseOptions({ branch: true, base })).toEqual({
        ok: false,
        message: "--base には main や origin/main のような安全な branch/ref 名を指定してください。",
      });
    }
    expect(buildCommitSkillPrompt({ branch: true, base: "develop" })).toBe(
      "/skill:commit --branch --base=develop",
    );
    expect(buildCommitSkillPrompt({ language: "japanese", branch: true, base: "develop" })).toBe(
      "/skill:commit --japanese --branch --base=develop",
    );
  });
});
