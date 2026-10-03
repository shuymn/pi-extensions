import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { installTypeboxMock } from "../../tests/support/typebox-mock";

installTypeboxMock();

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileImplementation = (
  file: string,
  args: string[],
  options: unknown,
  callback: ExecFileCallback,
) => EventEmitter;

let execFileImplementation: ExecFileImplementation = (_file, _args, _options, callback) => {
  callback(new Error("execFile mock not configured"), "", "");
  return new EventEmitter();
};

mock.module("node:child_process", () => ({
  execFile: mock((file: string, args: string[], options: unknown, callback: ExecFileCallback) =>
    execFileImplementation(file, args, options, callback),
  ),
}));

mock.module("@earendil-works/pi-coding-agent", () => ({}));

type NotifyLevel = "info" | "error";
type CommandHandler = (args: string, ctx: FakeCommandContext) => Promise<void> | void;
type CommandDefinition = {
  description?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Promise<AutocompleteItem[] | null> | AutocompleteItem[] | null;
  handler: CommandHandler;
};
type EventHandler = (event: any, ctx?: any) => Promise<any> | any;
type ToolDefinition = {
  name: string;
  execute: (
    toolCallId: string,
    params: { url: string; directoryName?: string },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<unknown>;
};

type CloneResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { name: string; path: string; ref?: string; subPath?: string; tempRoot: string };
};

type FakeCommandContext = {
  cwd: string;
  ui: { notify: (message: string, level: NotifyLevel) => void };
};

function createFakePi() {
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const events = new Map<string, EventHandler[]>();
  const appendedEntries: Array<{ type: string; data: unknown }> = [];

  return {
    commands,
    tools,
    events,
    appendedEntries,
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    on(eventName: string, handler: EventHandler) {
      events.set(eventName, [...(events.get(eventName) ?? []), handler]);
    },
    appendEntry(type: string, data: unknown) {
      appendedEntries.push({ type, data });
    },
  };
}

function createCommandContext(cwd: string) {
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  return {
    ctx: {
      cwd,
      ui: {
        notify(message: string, level: NotifyLevel) {
          notifications.push({ message, level });
        },
      },
    },
    notifications,
  };
}

async function getAddDirCompletions(pi: ReturnType<typeof createFakePi>, prefix: string) {
  return (await pi.commands.get("add-dir")?.getArgumentCompletions?.(prefix)) ?? null;
}

async function loadExtension() {
  return (await import("./index")).default;
}

async function startSession(pi: ReturnType<typeof createFakePi>, cwd: string) {
  await pi.events.get("session_start")![0]({}, { cwd, sessionManager: { getEntries: () => [] } });
}

async function createStartedPi(cwd: string) {
  const extension = await loadExtension();
  const pi = createFakePi();
  extension(pi as never);
  await startSession(pi, cwd);
  return pi;
}

async function createTempDir(prefix = "add-dir-test-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function mockGhqList(query: string, stdout: string, stderr = "") {
  execFileImplementation = (file, args, _options, callback) => {
    const child = new EventEmitter();
    if (file !== "ghq" || args.join(" ") !== `list -p --exact -- ${query}`) {
      callback(new Error(`Unexpected command: ${file} ${args.join(" ")}`), "", "");
      return child;
    }

    callback(null, stdout, stderr);
    return child;
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  execFileImplementation = (_file, _args, _options, callback) => {
    callback(new Error("execFile mock not configured"), "", "");
    return new EventEmitter();
  };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("add-dir extension", () => {
  test("registers commands, lifecycle hooks, and github clone tool", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();

    extension(pi as never);

    expect([...pi.commands.keys()].sort()).toEqual(["add-dir", "list-dir", "remove-dir"]);
    expect(pi.commands.get("add-dir")!.description).toContain("ghq:<repo>");
    expect(pi.commands.get("add-dir")!.getArgumentCompletions).toBeFunction();
    expect([...pi.tools.keys()]).toEqual(["github_clone_workspace"]);
    expect([...pi.events.keys()].sort()).toEqual([
      "before_agent_start",
      "session_shutdown",
      "session_start",
    ]);
  });

  test("completes sibling directories for ../ prefixes", async () => {
    const root = await createTempDir();
    const cwd = join(root, "current");
    await mkdir(cwd);
    await mkdir(join(root, "bar"));
    await mkdir(join(root, "foo"));
    await writeFile(join(root, "notes.txt"), "not a directory");

    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, "../")).resolves.toEqual([
      { value: "../bar/", label: "../bar/" },
      { value: "../current/", label: "../current/" },
      { value: "../foo/", label: "../foo/" },
    ]);
  });

  test("completes multi-parent prefixes with or without the trailing slash", async () => {
    const root = await createTempDir();
    const parent = join(root, "parent");
    const cwd = join(parent, "current");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, "beta"));
    await writeFile(join(root, "root-file.txt"), "not a directory");

    const pi = await createStartedPi(cwd);

    const expected = [
      { value: "../../alpha/", label: "../../alpha/" },
      { value: "../../beta/", label: "../../beta/" },
      { value: "../../parent/", label: "../../parent/" },
    ];

    await expect(getAddDirCompletions(pi, "../..")).resolves.toEqual(expected);
    await expect(getAddDirCompletions(pi, "../../")).resolves.toEqual(expected);
  });

  test("filters completion candidates by the typed leaf prefix", async () => {
    const root = await createTempDir();
    const cwd = join(root, "current");
    await mkdir(cwd);
    await mkdir(join(root, "foo"));
    await mkdir(join(root, "format"));
    await mkdir(join(root, "bar"));

    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, "../fo")).resolves.toEqual([
      { value: "../foo/", label: "../foo/" },
      { value: "../format/", label: "../format/" },
    ]);
  });

  test("does not include non-directory entries in completions", async () => {
    const cwd = await createTempDir();
    await mkdir(join(cwd, "alpha"));
    await writeFile(join(cwd, "beta.txt"), "not a directory");

    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, "")).resolves.toEqual([
      { value: "alpha/", label: "alpha/" },
    ]);
  });

  test("trims leading whitespace from completion prefixes", async () => {
    const root = await createTempDir();
    const cwd = join(root, "current");
    await mkdir(cwd);
    await mkdir(join(root, "foo"));

    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, " ../fo")).resolves.toEqual([
      { value: "../foo/", label: "../foo/" },
    ]);
  });

  test("prefixes unsafe bare directory names and supports literal ~foo paths", async () => {
    const cwd = await createTempDir();
    await mkdir(join(cwd, "~"));
    await mkdir(join(cwd, "ghq:repo"));
    await mkdir(join(cwd, " leading"));
    await mkdir(join(cwd, "~foo"));

    const pi = await createStartedPi(cwd);
    const completions = await getAddDirCompletions(pi, "");

    expect(completions).toContainEqual({ value: "./~/", label: "./~/" });
    expect(completions).toContainEqual({ value: "./ghq:repo/", label: "./ghq:repo/" });
    expect(completions).toContainEqual({ value: "./ leading/", label: "./ leading/" });
    expect(completions).toContainEqual({ value: "~foo/", label: "~foo/" });
    await expect(getAddDirCompletions(pi, "~f")).resolves.toEqual([
      { value: "~foo/", label: "~foo/" },
    ]);
  });

  test("completes absolute directory prefixes", async () => {
    const cwd = await createTempDir();
    const root = await createTempDir();
    await mkdir(join(root, "foo"));
    await mkdir(join(root, "format"));
    await mkdir(join(root, "bar"));

    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, `${root}${sep}fo`)).resolves.toEqual([
      { value: `${root}${sep}foo${sep}`, label: `${root}${sep}foo${sep}` },
      { value: `${root}${sep}format${sep}`, label: `${root}${sep}format${sep}` },
    ]);
  });

  test("returns no filesystem completions for ghq prefixes", async () => {
    const cwd = await createTempDir();
    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, "ghq:repo")).resolves.toBeNull();
  });

  test("returns no completions when the base directory is missing or unreadable", async () => {
    const cwd = await createTempDir();
    const locked = join(cwd, "locked");
    await mkdir(locked);

    const pi = await createStartedPi(cwd);
    const missing = await getAddDirCompletions(pi, "missing/");
    let unreadable: AutocompleteItem[] | null;

    if (process.platform === "win32") {
      await writeFile(join(cwd, "not-a-dir"), "plain file");
      unreadable = await getAddDirCompletions(pi, "not-a-dir/");
    } else {
      await chmod(locked, 0);
      try {
        unreadable = await getAddDirCompletions(pi, "locked/");
      } finally {
        await chmod(locked, 0o700);
      }
    }

    expect(missing).toBeNull();
    expect(unreadable).toBeNull();
  });

  test("includes symlinked directories in completions", async () => {
    const root = await createTempDir();
    const cwd = join(root, "current");
    const target = join(root, "target");
    await mkdir(cwd);
    await mkdir(target);
    await symlink(target, join(cwd, "link"), "dir");

    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, "")).resolves.toContainEqual({
      value: "link/",
      label: "link/",
    });
  });

  test("clears filesystem completions after shutdown until the next session starts", async () => {
    const firstRoot = await createTempDir();
    const firstCwd = join(firstRoot, "current");
    await mkdir(firstCwd);
    await mkdir(join(firstRoot, "foo"));

    const pi = await createStartedPi(firstCwd);

    await expect(getAddDirCompletions(pi, "../fo")).resolves.toEqual([
      { value: "../foo/", label: "../foo/" },
    ]);

    await pi.events.get("session_shutdown")![0]({ reason: "exit" });
    await expect(getAddDirCompletions(pi, "../fo")).resolves.toBeNull();

    const secondRoot = await createTempDir();
    const secondCwd = join(secondRoot, "current");
    await mkdir(secondCwd);
    await mkdir(join(secondRoot, "bar"));
    await startSession(pi, secondCwd);

    await expect(getAddDirCompletions(pi, "../ba")).resolves.toEqual([
      { value: "../bar/", label: "../bar/" },
    ]);
  });

  test("completes Windows-native prefixes on Windows", async () => {
    if (process.platform !== "win32") return;

    const root = await createTempDir();
    const cwd = join(root, "current");
    await mkdir(cwd);
    await mkdir(join(root, "foo"));
    await mkdir(join(root, "format"));

    const pi = await createStartedPi(cwd);

    await expect(getAddDirCompletions(pi, "..\\fo")).resolves.toEqual([
      { value: "..\\foo\\", label: "..\\foo\\" },
      { value: "..\\format\\", label: "..\\format\\" },
    ]);
    await expect(getAddDirCompletions(pi, `${root}\\fo`)).resolves.toEqual([
      { value: `${root}\\foo\\`, label: `${root}\\foo\\` },
      { value: `${root}\\format\\`, label: `${root}\\format\\` },
    ]);
  });

  test("adds a real directory, persists canonical state, lists it, and injects agent context", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const project = join(cwd, "project");
    await mkdir(project);
    const canonicalProject = await realpath(project);
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("./project", ctx);

    expect(notifications).toEqual([
      {
        message: `ディレクトリを追加しました: project: ${canonicalProject}`,
        level: "info",
      },
    ]);
    expect(pi.appendedEntries).toEqual([
      {
        type: "add-dir-state",
        data: { dirs: [{ name: "project", path: canonicalProject }] },
      },
    ]);

    await pi.commands.get("list-dir")!.handler("", ctx);
    expect(notifications.at(-1)).toEqual({
      message: `- project: ${canonicalProject}`,
      level: "info",
    });

    const result = await pi.events.get("before_agent_start")![0]({
      systemPrompt: "base prompt",
    });
    const expectedContext = [
      "Additional workspace roots registered by the user for this session:",
      `- project: ${canonicalProject}`,
      "",
      "When the user refers to one of the names above, interpret it as the corresponding absolute path.",
      "Use absolute paths when accessing these additional roots.",
    ].join("\n");

    expect(result.systemPrompt).toContain("base prompt");
    expect(result.systemPrompt).toContain(expectedContext);
  });

  test.each([
    ["repo name", "ghq", "ghq:ghq"],
    ["org/repo name", "x-motemen/ghq", "ghq:x-motemen/ghq"],
    ["host/org/repo name", "github.com/x-motemen/ghq", "ghq:github.com/x-motemen/ghq"],
    ["nested group name", "gitlab.example/team/group/ghq", "ghq:gitlab.example/team/group/ghq"],
    ["Unicode and punctuation", "会社/調査+用 repo", "ghq:会社/調査+用 repo"],
    ["option-like query", "--help", "ghq:--help"],
  ])("registers a ghq repository by %s", async (_label, query, input) => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const repo = join(cwd, "github.com", "x-motemen", "ghq");
    await mkdir(repo, { recursive: true });
    const canonicalRepo = await realpath(repo);
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });
    mockGhqList(query, `${canonicalRepo}\n`);

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler(input, ctx);

    expect(notifications).toEqual([
      {
        message: `ディレクトリを追加しました: ghq: ${canonicalRepo}`,
        level: "info",
      },
    ]);
    expect(pi.appendedEntries).toEqual([
      {
        type: "add-dir-state",
        data: { dirs: [{ name: "ghq", path: canonicalRepo }] },
      },
    ]);
  });

  test("accepts ghq prefix case-insensitively", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const repo = join(cwd, "github.com", "x-motemen", "ghq");
    await mkdir(repo, { recursive: true });
    const canonicalRepo = await realpath(repo);
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });
    mockGhqList("ghq", `${canonicalRepo}\n`);

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("GHQ:ghq", ctx);

    expect(notifications).toEqual([
      {
        message: `ディレクトリを追加しました: ghq: ${canonicalRepo}`,
        level: "info",
      },
    ]);
  });

  test("rejects an empty ghq query before lookup", async () => {
    const cwd = await createTempDir();
    const pi = await createStartedPi(cwd);
    execFileImplementation = () => {
      throw new Error("ghq lookup should not run");
    };

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("ghq:   ", ctx);

    expect(notifications).toEqual([
      {
        message: "ghq: の後にリポジトリ名を指定してください。例: /add-dir ghq:<repo>",
        level: "error",
      },
    ]);
    expect(pi.appendedEntries).toEqual([]);
  });

  test("does not register a directory when ghq has no matches", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });
    mockGhqList("missing", "\n");

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("ghq:missing", ctx);

    expect(notifications).toEqual([
      {
        message: "既存の ghq リポジトリが見つかりませんでした: missing",
        level: "error",
      },
    ]);
    expect(pi.appendedEntries).toEqual([]);
  });

  test("does not register a directory when ghq has multiple matches", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const left = join(cwd, "github.com", "left", "ghq");
    const right = join(cwd, "github.com", "right", "ghq");
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    const canonicalLeft = await realpath(left);
    const canonicalRight = await realpath(right);
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });
    mockGhqList("ghq", `${canonicalLeft}\n${canonicalRight}\n`);

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("ghq:ghq", ctx);

    expect(notifications).toEqual([
      {
        message: [
          "複数の ghq リポジトリが見つかりました: ghq",
          `- ${canonicalLeft}`,
          `- ${canonicalRight}`,
          "ghq:<org>/<repo> など、より具体的な指定にしてください。",
        ].join("\n"),
        level: "error",
      },
    ]);
    expect(pi.appendedEntries).toEqual([]);
  });

  test("reports ghq command failure without mutating registered directories", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });
    let calledWith: { file: string; args: string[] } | undefined;
    execFileImplementation = (file, args, _options, callback) => {
      const child = new EventEmitter();
      calledWith = { file, args };
      callback(new Error("ghq failed"), "", "ghq stderr");
      return child;
    };

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("ghq:ghq", ctx);

    expect(calledWith).toEqual({ file: "ghq", args: ["list", "-p", "--exact", "--", "ghq"] });
    expect(notifications).toEqual([
      {
        message: "ghq リポジトリの検索に失敗しました: ghq stderr",
        level: "error",
      },
    ]);
    expect(pi.appendedEntries).toEqual([]);
  });

  test("reports ghq command failure fallback messages", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });

    const { ctx, notifications } = createCommandContext(cwd);
    execFileImplementation = (_file, _args, _options, callback) => {
      const child = new EventEmitter();
      callback(new Error("ghq not found"), "", "");
      return child;
    };
    await pi.commands.get("add-dir")!.handler("ghq:ghq", ctx);

    execFileImplementation = (_file, _args, _options, callback) => {
      const child = new EventEmitter();
      callback(new Error(""), "", "");
      return child;
    };
    await pi.commands.get("add-dir")!.handler("ghq:ghq", ctx);

    expect(notifications).toEqual([
      {
        message: "ghq リポジトリの検索に失敗しました: ghq not found",
        level: "error",
      },
      {
        message: "ghq リポジトリの検索に失敗しました: ghq list command failed",
        level: "error",
      },
    ]);
    expect(pi.appendedEntries).toEqual([]);
  });

  test("reports ghq registration failure without leaking through the outer handler", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const left = join(cwd, "left", "same-name");
    const missing = join(cwd, "missing", "same-name");
    await mkdir(left, { recursive: true });
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("left/same-name", ctx);
    mockGhqList("same-name", `${missing}\n`);
    await pi.commands.get("add-dir")!.handler("ghq:same-name", ctx);

    expect(notifications.at(-1)?.level).toBe("error");
    expect(notifications.at(-1)?.message).toStartWith(
      `ディレクトリの登録に失敗しました (${missing}):`,
    );
    expect(pi.appendedEntries).toHaveLength(1);
  });

  test("shows ghq usage when add-dir has no arguments", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("", ctx);

    expect(notifications).toEqual([
      {
        message: "使い方: /add-dir <path> または /add-dir ghq:<repo>",
        level: "error",
      },
    ]);
  });

  test("does not mutate registered directories when persistence fails", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const project = join(cwd, "project");
    await mkdir(project);
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });

    pi.appendEntry = () => {
      throw new Error("persist failed");
    };

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("project", ctx);
    expect(notifications.at(-1)).toEqual({
      message: "persist failed",
      level: "error",
    });

    await pi.commands.get("list-dir")!.handler("", ctx);
    expect(notifications.at(-1)).toEqual({
      message: "追加ディレクトリは登録されていません。",
      level: "info",
    });
  });

  test("disambiguates duplicate basenames, skips occupied suffixes, and deduplicates by path", async () => {
    const cwd = await createTempDir();
    const left = join(cwd, "left", "same-name");
    const right = join(cwd, "right", "same-name");
    const occupied = join(cwd, "same-name-2");
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    await mkdir(occupied);
    const canonicalLeft = await realpath(left);
    const canonicalRight = await realpath(right);
    const canonicalOccupied = await realpath(occupied);
    const pi = await createStartedPi(cwd);
    const { ctx, notifications } = createCommandContext(cwd);

    await pi.commands.get("add-dir")!.handler("left/same-name", ctx);
    await pi.commands.get("add-dir")!.handler("same-name-2", ctx);
    mockGhqList("same-name", `${canonicalRight}\n`);
    await pi.commands.get("add-dir")!.handler("ghq:same-name", ctx);
    expect(notifications.at(-1)).toEqual({
      message: `ディレクトリを追加しました: same-name-3: ${canonicalRight}`,
      level: "info",
    });
    expect(pi.appendedEntries.at(-1)).toEqual({
      type: "add-dir-state",
      data: {
        dirs: [
          { name: "same-name", path: canonicalLeft },
          { name: "same-name-2", path: canonicalOccupied },
          { name: "same-name-3", path: canonicalRight },
        ],
      },
    });

    await pi.commands.get("add-dir")!.handler("right/same-name", ctx);
    expect(notifications.at(-1)?.message).toBe(
      `すでに登録済みです: same-name-3: ${canonicalRight}`,
    );
    expect(pi.appendedEntries).toHaveLength(3);
    await pi.commands.get("remove-dir")!.handler("same-name-3", ctx);
    await pi.commands.get("list-dir")!.handler("", ctx);
    expect(notifications.at(-1)?.message).toBe(
      `- same-name: ${canonicalLeft}\n- same-name-2: ${canonicalOccupied}`,
    );
    await expect(stat(right)).resolves.toBeTruthy();
  });

  test("removes by name or path and persists the remaining directories", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const alpha = join(cwd, "alpha");
    const beta = join(cwd, "beta");
    await mkdir(alpha);
    await mkdir(beta);
    const canonicalBeta = await realpath(beta);
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("alpha", ctx);
    await pi.commands.get("add-dir")!.handler("beta", ctx);
    await pi.commands.get("remove-dir")!.handler("alpha", ctx);

    expect(notifications.at(-1)).toEqual({
      message: `ディレクトリを削除しました。残り:\n- beta: ${canonicalBeta}`,
      level: "info",
    });
    expect(pi.appendedEntries.at(-1)).toEqual({
      type: "add-dir-state",
      data: { dirs: [{ name: "beta", path: canonicalBeta }] },
    });

    await pi.commands.get("remove-dir")!.handler(canonicalBeta, ctx);
    expect(notifications.at(-1)).toEqual({
      message: "ディレクトリを削除しました。追加ディレクトリはありません。",
      level: "info",
    });
  });

  test("restores only valid session entries and drops stale temporary directories", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const existing = join(cwd, "existing");
    await mkdir(existing);
    const canonicalExisting = await realpath(existing);
    const staleTemporary = join(cwd, "missing-temp");
    const stalePermanent = join(cwd, "missing-permanent");

    await pi.events.get("session_start")![0](
      {},
      {
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "different",
              data: { dirs: [{ name: "ignored", path: existing }] },
            },
            {
              type: "custom",
              customType: "add-dir-state",
              data: {
                dirs: [
                  null,
                  { name: "existing", path: canonicalExisting },
                  { name: "bad" },
                  { name: "tmp", path: staleTemporary, temporary: true },
                  { name: "permanent", path: stalePermanent },
                ],
              },
            },
          ],
        },
      },
    );

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("list-dir")!.handler("", ctx);

    expect(notifications.at(-1)).toEqual({
      message: [`- existing: ${canonicalExisting}`, `- permanent: ${stalePermanent}`].join("\n"),
      level: "info",
    });
  });

  test("cleans restored temporary clone roots on shutdown except reload", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const tempRoot = await createTempDir("pi-github-workspace-");
    const clone = join(tempRoot, "repo");
    await mkdir(clone);
    await pi.events.get("session_start")![0](
      {},
      {
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "add-dir-state",
              data: {
                dirs: [{ name: "repo", path: clone, temporary: true, tempRoot }],
              },
            },
          ],
        },
      },
    );

    await pi.events.get("session_shutdown")![0]({ reason: "reload" });
    await expect(stat(tempRoot)).resolves.toBeTruthy();

    await pi.events.get("session_shutdown")![0]({ reason: "exit" });
    await expect(stat(tempRoot)).rejects.toThrow();
  });

  test("removing a temporary clone root deletes it before reload can orphan it", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const tempRoot = await createTempDir("pi-github-workspace-");
    const clone = join(tempRoot, "repo");
    await mkdir(clone);
    await pi.events.get("session_start")![0](
      {},
      {
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "add-dir-state",
              data: {
                dirs: [{ name: "repo", path: clone, temporary: true, tempRoot }],
              },
            },
          ],
        },
      },
    );

    const appendedEntries = pi.appendedEntries;
    let rootExistedAtPersist: boolean | undefined;
    pi.appendEntry = (type: string, data: unknown) => {
      rootExistedAtPersist = existsSync(tempRoot);
      appendedEntries.push({ type, data });
    };

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("remove-dir")!.handler("repo", ctx);

    expect(rootExistedAtPersist).toBe(false);
    expect(notifications.at(-1)).toEqual({
      message: "ディレクトリを削除しました。追加ディレクトリはありません。",
      level: "info",
    });
    expect(pi.appendedEntries.at(-1)).toEqual({ type: "add-dir-state", data: { dirs: [] } });
    await expect(stat(tempRoot)).rejects.toThrow();

    await pi.events.get("session_shutdown")![0]({ reason: "reload" });
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });
    await pi.events.get("session_shutdown")![0]({ reason: "exit" });
    await expect(stat(tempRoot)).rejects.toThrow();
  });

  test("keeps failed temporary cleanup roots tracked for shutdown retry", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const tempRoot = await createTempDir("pi-github-workspace-");
    const clone = join(tempRoot, "repo");
    const locked = join(clone, "locked");
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, "file.txt"), "content");
    await chmod(locked, 0o500);
    await pi.events.get("session_start")![0](
      {},
      {
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "add-dir-state",
              data: {
                dirs: [{ name: "repo", path: clone, temporary: true, tempRoot }],
              },
            },
          ],
        },
      },
    );

    const { ctx } = createCommandContext(cwd);
    await pi.commands.get("remove-dir")!.handler("repo", ctx);

    expect(pi.appendedEntries.at(-1)).toEqual({ type: "add-dir-state", data: { dirs: [] } });
    await expect(stat(tempRoot)).resolves.toBeTruthy();

    await chmod(locked, 0o700);
    await pi.events.get("session_shutdown")![0]({ reason: "exit" });
    await expect(stat(tempRoot)).rejects.toThrow();
  });

  test("drops restored temporary clone roots outside the managed temp area", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const unsafeRoot = await createTempDir();
    const clone = join(unsafeRoot, "repo");
    await mkdir(clone);
    await pi.events.get("session_start")![0](
      {},
      {
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "add-dir-state",
              data: {
                dirs: [{ name: "repo", path: clone, temporary: true, tempRoot: cwd }],
              },
            },
          ],
        },
      },
    );

    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("list-dir")!.handler("", ctx);
    expect(notifications.at(-1)).toEqual({
      message: "追加ディレクトリは登録されていません。",
      level: "info",
    });

    await pi.events.get("session_shutdown")![0]({ reason: "exit" });
    await expect(stat(cwd)).resolves.toBeTruthy();
  });

  test("github clone tool registers a GitHub tree URL subdirectory directly", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const tool = pi.tools.get("github_clone_workspace")!;
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });

    execFileImplementation = (_file, args, _options, callback) => {
      const child = new EventEmitter();
      if (args[0] === "ls-remote") {
        callback(
          null,
          [
            "0000000000000000000000000000000000000000\trefs/heads/main",
            "1111111111111111111111111111111111111111\trefs/heads/feature/deep",
          ].join("\n"),
          "",
        );
        return child;
      }

      if (args[0] === "clone") {
        const targetPath = args.at(-1)!;
        mkdir(join(targetPath, "packages", "edb-auto-name-session"), {
          recursive: true,
        }).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", ""),
        );
        return child;
      }

      callback(new Error(`Unexpected git args: ${args.join(" ")}`), "", "");
      return child;
    };

    const result = (await tool.execute(
      "call",
      {
        url: "https://github.com/agnishcc/pi-extention-monorepo/tree/main/packages/edb-auto-name-session",
        directoryName: "custom-clone",
      },
      undefined,
      undefined,
      { cwd },
    )) as {
      content: Array<{ type: "text"; text: string }>;
      details: {
        name: string;
        path: string;
        ref: string;
        subPath: string;
        tempRoot: string;
      };
    };

    expect(result.details.name).toBe("edb-auto-name-session");
    expect(result.details.ref).toBe("main");
    expect(result.details.subPath).toBe("packages/edb-auto-name-session");
    expect(result.details.path).toEndWith("/custom-clone/packages/edb-auto-name-session");
    expect(result.content[0].text).toContain(`path: ${result.details.path}`);
    expect(result.content[0].text).toContain("ref: main");
    expect(result.content[0].text).toContain("subPath: packages/edb-auto-name-session");
    expect(pi.appendedEntries.at(-1)).toEqual({
      type: "add-dir-state",
      data: {
        dirs: [
          {
            name: "edb-auto-name-session",
            path: result.details.path,
            temporary: true,
            tempRoot: result.details.tempRoot,
          },
        ],
      },
    });
  });

  test.each([
    ["refs/heads/機能/調査+改善", "機能/調査+改善", "調査用 (copy)+1"],
    ["refs/tags/v1+補修", "v1+補修", "repo;literal"],
    ["refs/heads/調査\u00A0用", "調査\u00A0用", " leading and trailing "],
  ])("clones advertised ref %s into a normal single-component directory name", async (advertised, ref, directoryName) => {
    const cwd = await createTempDir();
    const pi = await createStartedPi(cwd);
    const gitCalls: string[][] = [];
    execFileImplementation = (file, args, options, callback) => {
      expect(file).toBe("git");
      expect(options).toMatchObject({ timeout: 30_000 });
      gitCalls.push(args);
      const child = new EventEmitter();
      if (args[0] === "ls-remote") {
        callback(null, `0123456789abcdef\t${advertised}\n`, "");
      } else if (args[0] === "clone") {
        mkdir(args.at(-1)!, { recursive: true }).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", ""),
        );
      } else {
        callback(new Error(`Unexpected command: ${args.join(" ")}`), "", "");
      }
      return child;
    };

    const result = (await pi.tools
      .get("github_clone_workspace")!
      .execute(
        "call",
        { url: `https://github.com/owner/repo/tree/${encodeURIComponent(ref)}`, directoryName },
        undefined,
        undefined,
        { cwd },
      )) as CloneResult;
    tempDirs.push(result.details.tempRoot);

    expect(result.details.name).toBe(directoryName);
    expect(result.details.path).toBe(join(await realpath(result.details.tempRoot), directoryName));
    expect(result.details.ref).toBe(ref);
    expect(gitCalls[1]).toEqual([
      "clone",
      "--depth",
      "1",
      "--filter=blob:none",
      "--single-branch",
      "--branch",
      ref,
      "https://github.com/owner/repo.git",
      join(result.details.tempRoot, directoryName),
    ]);
    const { ctx } = createCommandContext(cwd);
    await pi.commands.get("remove-dir")!.handler(JSON.stringify(result.details.name), ctx);
    expect((pi.appendedEntries.at(-1)?.data as { dirs: unknown[] }).dirs).toEqual([]);
    await expect(stat(result.details.tempRoot)).rejects.toThrow();
  });

  test("duplicate cloned subtree names retain existing workspaces and clean only their owned roots", async () => {
    const cwd = await createTempDir();
    const existing = join(cwd, "shared");
    await mkdir(existing);
    const canonicalExisting = await realpath(existing);
    const pi = await createStartedPi(cwd);
    const { ctx, notifications } = createCommandContext(cwd);
    await pi.commands.get("add-dir")!.handler("shared", ctx);
    execFileImplementation = (_file, args, _options, callback) => {
      const child = new EventEmitter();
      if (args[0] === "ls-remote") {
        callback(null, "0123456789abcdef\trefs/heads/main\n", "");
      } else if (args[0] === "clone") {
        mkdir(join(args.at(-1)!, "packages", "shared"), { recursive: true }).then(
          () => callback(null, "", ""),
          (error) => callback(error, "", ""),
        );
      } else {
        callback(new Error(`Unexpected command: ${args.join(" ")}`), "", "");
      }
      return child;
    };

    const tool = pi.tools.get("github_clone_workspace")!;
    const params = { url: "https://github.com/owner/repo/tree/main/packages/shared" };
    const first = (await tool.execute("first", params, undefined, undefined, {
      cwd,
    })) as CloneResult;
    const second = (await tool.execute("second", params, undefined, undefined, {
      cwd,
    })) as CloneResult;
    tempDirs.push(first.details.tempRoot, second.details.tempRoot);
    expect(first.details.name).toBe("shared-2");
    expect(second.details.name).toBe("shared-3");
    const context = await pi.events.get("before_agent_start")![0]({ systemPrompt: "base" });
    expect(context.systemPrompt).toContain(`- shared: ${canonicalExisting}`);
    expect(context.systemPrompt).toContain(`- shared-2: ${first.details.path}`);
    expect(context.systemPrompt).toContain(`- shared-3: ${second.details.path}`);

    await pi.commands.get("remove-dir")!.handler("shared-2", ctx);
    await expect(stat(first.details.tempRoot)).rejects.toThrow();
    await expect(stat(second.details.path)).resolves.toBeTruthy();
    await expect(stat(existing)).resolves.toBeTruthy();
    await pi.commands.get("list-dir")!.handler("", ctx);
    expect(notifications.at(-1)?.message).toBe(
      `- shared: ${canonicalExisting}\n- shared-3: ${second.details.path}`,
    );
    await pi.events.get("session_shutdown")![0]({ reason: "reload" });
    await expect(stat(second.details.path)).resolves.toBeTruthy();
    await pi.events.get("session_shutdown")![0]({ reason: "exit" });
    await expect(stat(second.details.tempRoot)).rejects.toThrow();
    await expect(stat(existing)).resolves.toBeTruthy();
  });

  test.each([
    "",
    ".",
    "..",
    "../escape",
    "sub/directory",
    "/absolute",
    "bad\0name",
  ])("rejects directoryName %j before invoking Git", async (directoryName) => {
    const cwd = await createTempDir();
    const pi = await createStartedPi(cwd);
    const calls: string[][] = [];
    execFileImplementation = (_file, args, _options, callback) => {
      calls.push(args);
      callback(new Error("Git must not run"), "", "");
      return new EventEmitter();
    };
    await expect(
      pi.tools
        .get("github_clone_workspace")!
        .execute(
          "call",
          { url: "https://github.com/owner/repo", directoryName },
          undefined,
          undefined,
          { cwd },
        ),
    ).rejects.toThrow("Directory name");
    expect(calls).toEqual([]);
    expect(pi.appendedEntries).toEqual([]);
  });

  test("github clone tool rejects subdirectories that resolve outside the clone", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const outside = await createTempDir();
    const canonicalOutside = await realpath(outside);
    const tool = pi.tools.get("github_clone_workspace")!;
    await pi.events.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } });

    execFileImplementation = (_file, args, _options, callback) => {
      const child = new EventEmitter();
      if (args[0] === "ls-remote") {
        callback(null, "0000000000000000000000000000000000000000\trefs/heads/main", "");
        return child;
      }

      if (args[0] === "clone") {
        const targetPath = args.at(-1)!;
        mkdir(targetPath, { recursive: true })
          .then(
            () => symlink(outside, join(targetPath, "escape"), "dir"),
            (error) => Promise.reject(error),
          )
          .then(
            () => callback(null, "", ""),
            (error) => callback(error, "", ""),
          );
        return child;
      }

      callback(new Error(`Unexpected git args: ${args.join(" ")}`), "", "");
      return child;
    };

    await expect(
      tool.execute(
        "call",
        { url: "https://github.com/owner/repo/tree/main/escape" },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(
      `GitHub URL path resolves outside the cloned repository: ${canonicalOutside}`,
    );
    expect(pi.appendedEntries).toEqual([]);
  });

  test("github clone tool rejects unsupported URLs before cloning", async () => {
    const extension = await loadExtension();
    const pi = createFakePi();
    extension(pi as never);

    const cwd = await createTempDir();
    const tool = pi.tools.get("github_clone_workspace")!;

    await expect(
      tool.execute("call", { url: "git@github.com:owner/repo.git" }, undefined, undefined, { cwd }),
    ).rejects.toThrow(
      "github_clone_workspace only accepts full https://github.com/owner/repo URLs.",
    );
    await expect(
      tool.execute("call", { url: "https://example.com/owner/repo" }, undefined, undefined, {
        cwd,
      }),
    ).rejects.toThrow("github_clone_workspace only accepts https://github.com URLs.");
    await expect(
      tool.execute(
        "call",
        { url: "https://github.com/owner/repo/blob/main/src/index.ts" },
        undefined,
        undefined,
        { cwd },
      ),
    ).rejects.toThrow(
      "GitHub blob URLs point to files and are not supported. Use the repository URL or a /tree/<ref>/<directory> URL instead.",
    );
  });
});
