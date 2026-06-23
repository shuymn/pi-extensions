import { afterEach, describe, expect, mock, test } from "bun:test";

import { createFakePi as createSharedFakePi, type ExecResult } from "../../tests/support/fake-pi";

let forkFromImplementation: (sourcePath: string, targetCwd: string) => FakeForkedSessionManager =
  () => {
    throw new Error("SessionManager.forkFrom mock not configured");
  };

mock.module("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    forkFrom: (sourcePath: string, targetCwd: string) =>
      forkFromImplementation(sourcePath, targetCwd),
  },
}));

type NotifyLevel = "info" | "warning" | "error";
type ExecBehavior =
  | ExecResult
  | ((
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => ExecResult | Promise<ExecResult>);
type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
};
type FakeForkedSessionManager = {
  getSessionFile: () => string | undefined;
  appendCustomMessageEntry: (
    customType: string,
    content: string,
    display: boolean,
    details?: unknown,
  ) => string;
};
type FakeCommandContext = {
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionFile: () => string | undefined };
  ui: { notify: (message: string, level: NotifyLevel) => void };
  switchSession: (
    sessionPath: string,
    options?: { withSession?: (ctx: FakeCommandContext) => Promise<void> },
  ) => Promise<{ cancelled: boolean }>;
};

function createFakePi(
  execBehavior: ExecBehavior = { code: 0, stdout: "/tmp/worktree\n", stderr: "" },
) {
  return createSharedFakePi<never, CommandDefinition>({
    exec: ({ command, args, options }) => {
      if (typeof execBehavior === "function") return execBehavior(command, args, options);
      return execBehavior;
    },
  });
}

function createForkedSessionManager(sessionFile = "/sessions/forked.jsonl") {
  const customMessages: Array<{
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }> = [];
  const manager: FakeForkedSessionManager = {
    getSessionFile: () => sessionFile,
    appendCustomMessageEntry(customType, content, display, details) {
      customMessages.push({ customType, content, display, details });
      return "custom-message-id";
    },
  };

  return { manager, customMessages };
}

function createCommandContext(
  options: { cwd?: string; sessionFile?: string; switchCancelled?: boolean } = {},
) {
  const notifications: Array<{ message: string; level: NotifyLevel; replacement: boolean }> = [];
  const switchCalls: Array<{ sessionPath: string; hasWithSession: boolean }> = [];
  const replacementCtx = createBareContext(
    options.cwd ?? "/repo/current-worktree",
    options.sessionFile ?? "/sessions/forked.jsonl",
    notifications,
    true,
  );
  const ctx = createBareContext(
    options.cwd ?? "/repo/current",
    options.sessionFile,
    notifications,
    false,
  );
  ctx.switchSession = async (sessionPath, switchOptions) => {
    switchCalls.push({
      sessionPath,
      hasWithSession: typeof switchOptions?.withSession === "function",
    });
    if (options.switchCancelled) return { cancelled: true };
    await switchOptions?.withSession?.(replacementCtx);
    return { cancelled: false };
  };

  return { ctx, notifications, switchCalls };
}

function createBareContext(
  cwd: string,
  sessionFile: string | undefined,
  notifications: Array<{ message: string; level: NotifyLevel; replacement: boolean }>,
  replacement: boolean,
): FakeCommandContext {
  return {
    cwd,
    hasUI: true,
    sessionManager: { getSessionFile: () => sessionFile },
    ui: {
      notify(message, level) {
        notifications.push({ message, level, replacement });
      },
    },
    switchSession: async () => ({ cancelled: false }),
  };
}

async function loadWtModule() {
  return await import("./index");
}

afterEach(() => {
  forkFromImplementation = () => {
    throw new Error("SessionManager.forkFrom mock not configured");
  };
});

describe("wt command helpers", () => {
  test("parses empty arguments into a deterministic default worktree name", async () => {
    const { parseWtArguments } = await loadWtModule();

    expect(parseWtArguments("", { now: new Date(2026, 5, 24, 2, 18, 15) })).toEqual({
      worktreeName: "wip/20260624-021815",
      startPoint: undefined,
    });
  });

  test("parses an explicit worktree name and optional start point", async () => {
    const { parseWtArguments } = await loadWtModule();

    expect(parseWtArguments(" fix-login   origin/main ")).toEqual({
      worktreeName: "fix-login",
      startPoint: "origin/main",
    });
  });

  test("accepts ordinary git branch names and refs", async () => {
    const { parseWtArguments } = await loadWtModule();

    for (const value of ["wip/20260624-021815", "fix-login", "main", "origin/main", "dc4569f"]) {
      expect(parseWtArguments(value).worktreeName).toBe(value);
      expect(parseWtArguments(`branch ${value}`).startPoint).toBe(value);
    }
  });

  test.each([
    ["too many arguments", "one two three"],
    ["leading dash", "-bad"],
    ["leading at sign", "@bad"],
    ["double dots", "bad..name"],
    ["reflog syntax", "bad@{1}"],
    ["trailing slash", "bad/"],
    ["trailing dot", "bad."],
    ["lock suffix", "bad.lock"],
    ["control character", "bad\u0007name"],
    ["zero width space", "bad\u200Bname"],
    ["zero width non-joiner", "bad\u200Cname"],
    ["zero width joiner", "bad\u200Dname"],
    ["byte-order mark", "bad\uFEFFname"],
    ["no-break space", "bad\u00A0name"],
  ])("rejects unsafe argument values: %s", async (_label, input) => {
    const { parseWtArguments } = await loadWtModule();

    expect(() => parseWtArguments(input)).toThrow();
  });

  test("parses git-wt create stdout as a plain path", async () => {
    const { parseGitWtCreatePath } = await loadWtModule();

    expect(parseGitWtCreatePath("/tmp/project-worktrees/fix-login\n")).toBe(
      "/tmp/project-worktrees/fix-login",
    );
  });

  test("parses git-wt create stdout as JSON when a future version emits structured output", async () => {
    const { parseGitWtCreatePath } = await loadWtModule();

    expect(parseGitWtCreatePath('{"worktree":{"path":"/tmp/project-worktrees/json"}}')).toBe(
      "/tmp/project-worktrees/json",
    );
  });

  test("prioritizes worktree paths in ambiguous future JSON output", async () => {
    const { parseGitWtCreatePath } = await loadWtModule();

    expect(
      parseGitWtCreatePath(
        '{"ok":true,"git":{"path":"/usr/bin/git"},"worktree":{"path":"/tmp/project-worktrees/json"}}',
      ),
    ).toBe("/tmp/project-worktrees/json");
    expect(parseGitWtCreatePath('["/tmp/project-worktrees/array"]')).toBe(
      "/tmp/project-worktrees/array",
    );
  });

  test("selects the last path-like line from plain git-wt output", async () => {
    const { parseGitWtCreatePath } = await loadWtModule();

    expect(
      parseGitWtCreatePath("/tmp/project-worktrees/fix-login\nwarning: post-create hook skipped\n"),
    ).toBe("/tmp/project-worktrees/fix-login");
  });

  test("rejects git-wt create stdout without a usable path", async () => {
    const { parseGitWtCreatePath } = await loadWtModule();

    expect(() => parseGitWtCreatePath("\n")).toThrow(
      "git-wt の出力から worktree path を取得できませんでした。",
    );
    expect(() => parseGitWtCreatePath('{"ok":true}')).toThrow(
      "git-wt の出力から worktree path を取得できませんでした。",
    );
  });
});

describe("wt command", () => {
  test("registers the /wt command with an English description", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi();

    wtExtension(pi as never);

    expect([...pi.commands.keys()]).toEqual(["wt"]);
    expect(pi.commands.get("wt")?.description).toBe(
      "Create a git-wt worktree and continue this persisted session there",
    );
  });

  test("promotes a persisted session with a generated default worktree name", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi({
      code: 0,
      stdout: "/repo-worktrees/wip/20260624-021815\n",
      stderr: "",
    });
    const { manager, customMessages } = createForkedSessionManager();
    const forkFromCalls: Array<{ sourcePath: string; targetCwd: string }> = [];
    forkFromImplementation = (sourcePath, targetCwd) => {
      forkFromCalls.push({ sourcePath, targetCwd });
      return manager;
    };
    wtExtension(pi as never, { now: () => new Date(2026, 5, 24, 2, 18, 15) });
    const { ctx, notifications, switchCalls } = createCommandContext({
      cwd: "/repo/current",
      sessionFile: "/sessions/current.jsonl",
    });

    await pi.commands.get("wt")!.handler("", ctx);

    expect(pi.execCalls).toEqual([
      {
        command: "git-wt",
        args: ["--nocd", "--json", "wip/20260624-021815"],
        options: { cwd: "/repo/current", timeout: 120_000 },
      },
    ]);
    expect(forkFromCalls).toEqual([
      { sourcePath: "/sessions/current.jsonl", targetCwd: "/repo-worktrees/wip/20260624-021815" },
    ]);
    expect(customMessages).toHaveLength(1);
    expect(customMessages[0]).toMatchObject({
      customType: "wt-session-move",
      display: true,
      details: {
        fromCwd: "/repo/current",
        toCwd: "/repo-worktrees/wip/20260624-021815",
        worktreeName: "wip/20260624-021815",
      },
    });
    expect(customMessages[0]!.content).toContain("Previous cwd: /repo/current");
    expect(customMessages[0]!.content).toContain(
      "Current cwd: /repo-worktrees/wip/20260624-021815",
    );
    expect(switchCalls).toEqual([{ sessionPath: "/sessions/forked.jsonl", hasWithSession: true }]);
    expect(notifications).toEqual([
      {
        message: "worktree に移動しました: /repo-worktrees/wip/20260624-021815",
        level: "info",
        replacement: true,
      },
    ]);
  });

  test("passes an explicit worktree name and start point to git-wt", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi({ code: 0, stdout: "/repo-worktrees/fix-login\n", stderr: "" });
    const { manager, customMessages } = createForkedSessionManager();
    forkFromImplementation = () => manager;
    wtExtension(pi as never);
    const { ctx } = createCommandContext({ sessionFile: "/sessions/current.jsonl" });

    await pi.commands.get("wt")!.handler("fix-login origin/main", ctx);

    expect(pi.execCalls[0]).toEqual({
      command: "git-wt",
      args: ["--nocd", "--json", "fix-login", "origin/main"],
      options: { cwd: "/repo/current", timeout: 120_000 },
    });
    expect(customMessages[0]!.details).toMatchObject({
      fromCwd: "/repo/current",
      toCwd: "/repo-worktrees/fix-login",
      worktreeName: "fix-login",
      startPoint: "origin/main",
    });
  });

  test("fails before git-wt when the current session is not persisted", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi();
    wtExtension(pi as never);
    const { ctx, notifications, switchCalls } = createCommandContext({ sessionFile: undefined });

    await pi.commands.get("wt")!.handler("fix-login", ctx);

    expect(pi.execCalls).toEqual([]);
    expect(switchCalls).toEqual([]);
    expect(notifications).toEqual([
      {
        message: "永続化されたセッションがないため /wt を実行できません。",
        level: "error",
        replacement: false,
      },
    ]);
  });

  test("reports git-wt failures without forking or switching", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi({ code: 1, stdout: "", stderr: "git-wt failed" });
    const { ctx, notifications, switchCalls } = createCommandContext({
      sessionFile: "/sessions/current.jsonl",
    });
    wtExtension(pi as never);

    await pi.commands.get("wt")!.handler("fix-login", ctx);

    expect(switchCalls).toEqual([]);
    expect(notifications).toEqual([
      {
        message: "git-wt の実行に失敗しました (exit 1): git-wt failed",
        level: "error",
        replacement: false,
      },
    ]);
  });

  test("reports git-wt execution exceptions without forking or switching", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi(() => {
      throw new Error("runtime is stale");
    });
    const { ctx, notifications, switchCalls } = createCommandContext({
      sessionFile: "/sessions/current.jsonl",
    });
    wtExtension(pi as never);

    await pi.commands.get("wt")!.handler("fix-login", ctx);

    expect(switchCalls).toEqual([]);
    expect(notifications).toEqual([
      {
        message: "git-wt の実行に失敗しました: runtime is stale",
        level: "error",
        replacement: false,
      },
    ]);
  });

  test("reports session fork failures without switching", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi({ code: 0, stdout: "/repo-worktrees/fix-login\n", stderr: "" });
    forkFromImplementation = () => {
      throw new Error("disk full");
    };
    wtExtension(pi as never);
    const { ctx, notifications, switchCalls } = createCommandContext({
      sessionFile: "/sessions/current.jsonl",
    });

    await pi.commands.get("wt")!.handler("fix-login", ctx);

    expect(switchCalls).toEqual([]);
    expect(notifications).toEqual([
      {
        message: "セッションのコピーに失敗しました: disk full",
        level: "error",
        replacement: false,
      },
    ]);
  });

  test("rejects unsafe arguments before running git-wt", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi();
    wtExtension(pi as never);
    const { ctx, notifications } = createCommandContext({ sessionFile: "/sessions/current.jsonl" });

    await pi.commands.get("wt")!.handler("-bad", ctx);

    expect(pi.execCalls).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe("error");
    expect(notifications[0]!.message).toContain("worktree name");
  });

  test("reports switch cancellation and leaves the created worktree session in place", async () => {
    const { default: wtExtension } = await loadWtModule();
    const pi = createFakePi({ code: 0, stdout: "/repo-worktrees/fix-login\n", stderr: "" });
    const { manager, customMessages } = createForkedSessionManager();
    forkFromImplementation = () => manager;
    wtExtension(pi as never);
    const { ctx, notifications, switchCalls } = createCommandContext({
      sessionFile: "/sessions/current.jsonl",
      switchCancelled: true,
    });

    await pi.commands.get("wt")!.handler("fix-login", ctx);

    expect(customMessages).toHaveLength(1);
    expect(switchCalls).toEqual([{ sessionPath: "/sessions/forked.jsonl", hasWithSession: true }]);
    expect(notifications).toEqual([
      {
        message:
          "worktree とセッションを作成しましたが、セッション切替はキャンセルされました: /repo-worktrees/fix-login",
        level: "warning",
        replacement: false,
      },
    ]);
  });
});
