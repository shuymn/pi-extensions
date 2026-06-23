import { describe, expect, test } from "bun:test";
import { ASK_USER_QUESTION_POLICY_EVENT } from "../ask-user-question/policy";
import commitExtension, {
  buildCommitSkillPrompt,
  COMMIT_BASE_FLAG,
  COMMIT_BRANCH_FLAG,
  COMMIT_FLAG,
  COMMIT_LANGUAGE_FLAG,
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
};

const DEFAULT_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "ask_user_question",
  "todo",
];

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

function userMessage(content: string) {
  return { role: "user", content: [{ type: "text", text: content }] };
}

function expandedCommitSkillMessage(args = "--english") {
  return userMessage(
    `<skill name="commit" location="/skills/commit/SKILL.md">\nbody\n</skill>\n\n${args}`,
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

describe("commit extension", () => {
  test("registers commit startup flags", () => {
    const pi = createFakePi();

    commitExtension(pi as never);

    expect(pi.flagDefinitions.get(COMMIT_FLAG)).toEqual({
      description: "Launch the commit skill as a bounded one-shot flow",
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(COMMIT_LANGUAGE_FLAG)).toMatchObject({
      type: "string",
      default: "english",
    });
    expect(pi.flagDefinitions.get(COMMIT_BRANCH_FLAG)).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(pi.flagDefinitions.get(COMMIT_BASE_FLAG)).toMatchObject({ type: "string" });
    expect(pi.getEventHandlers("session_start")).toHaveLength(1);
    expect(pi.getEventHandlers("agent_end")).toHaveLength(1);
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

  test("launches the English commit skill with bounded questionnaire mode by default", async () => {
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
    expect(pi.sentUserMessages).toEqual(["/skill:commit --english"]);
    expect(ctx.shutdowns).toBe(0);
  });

  test("builds Japanese branch/base commit skill prompts", async () => {
    const pi = createFakePi({
      flags: {
        [COMMIT_FLAG]: true,
        [COMMIT_LANGUAGE_FLAG]: "japanese",
        [COMMIT_BRANCH_FLAG]: true,
        [COMMIT_BASE_FLAG]: "main",
      },
    });
    commitExtension(pi as never);

    await sessionStart(pi);

    expect(pi.sentUserMessages).toEqual(["/skill:commit --japanese --branch --base=main"]);
  });

  test("filters active tools to the available commit-safe allowlist", async () => {
    const pi = createFakePi({
      flags: { [COMMIT_FLAG]: true },
      tools: ["read", "bash", "write", "edit", "ask_user_question", "todo"],
    });
    commitExtension(pi as never);

    await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([["read", "bash", "ask_user_question"]]);
    expect(pi.sentUserMessages).toEqual(["/skill:commit --english"]);
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

  test("rejects --commit-base without --commit-branch", async () => {
    const pi = createFakePi({
      flags: { [COMMIT_FLAG]: true, [COMMIT_BASE_FLAG]: "main" },
    });
    commitExtension(pi as never);

    const ctx = await sessionStart(pi);

    expect(pi.activeToolsCalls).toEqual([]);
    expect(pi.emittedEvents).toEqual([]);
    expect(pi.sentUserMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      { message: "--commit-base は --commit-branch と一緒に指定してください。", level: "error" },
    ]);
    expect(ctx.shutdowns).toBe(1);
  });

  test("launches only once and shuts down after the active commit agent run ends", async () => {
    const pi = createFakePi({ flags: { [COMMIT_FLAG]: true } });
    commitExtension(pi as never);
    const ctx = createContext();

    await sessionStart(pi, ctx);
    await sessionStart(pi, ctx);

    expect(pi.sentUserMessages).toEqual(["/skill:commit --english"]);
    expect(pi.emittedEvents).toHaveLength(1);

    await agentEnd(pi, ctx, [expandedCommitSkillMessage()]);
    await agentEnd(pi, ctx, [expandedCommitSkillMessage()]);

    expect(ctx.shutdowns).toBe(1);
    expect(pi.emittedEvents).toEqual([
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: false } },
      { name: ASK_USER_QUESTION_POLICY_EVENT, data: { allowChatAboutThis: true } },
    ]);
  });

  test("ignores non-matching agent_end before the commit agent run ends", async () => {
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
    expect(
      parseCommitLaunchOptions({ language: undefined, branch: undefined, base: undefined }),
    ).toEqual({ ok: true, options: { language: "english", branch: false } });
    expect(
      parseCommitLaunchOptions({ language: "klingon", branch: false, base: undefined }),
    ).toEqual({
      ok: false,
      message: "--commit-language には english または japanese を指定してください。",
    });
    expect(parseCommitLaunchOptions({ language: "english", branch: true, base: "  " })).toEqual({
      ok: false,
      message: "--commit-base には空でない base branch 名を指定してください。",
    });
    for (const base of ["main --japanese", "main\nnext", "--main", "@{upstream}"]) {
      expect(parseCommitLaunchOptions({ language: "english", branch: true, base })).toEqual({
        ok: false,
        message:
          "--commit-base には main や origin/main のような安全な branch/ref 名を指定してください。",
      });
    }
    expect(buildCommitSkillPrompt({ language: "japanese", branch: true, base: "develop" })).toBe(
      "/skill:commit --japanese --branch --base=develop",
    );
  });
});
