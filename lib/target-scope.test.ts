import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecGit, GitResult } from "./git";
import { prepareTargetScope } from "./target-scope";

type GitCall = string[];

const tempDirs: string[] = [];

function gitResult(stdout = "", code = 0, stderr = ""): GitResult {
  return { code, stdout, stderr };
}

function createExecGit(handler: (args: string[]) => GitResult | Promise<GitResult>): {
  execGit: ExecGit;
  calls: GitCall[];
} {
  const calls: GitCall[] = [];
  return {
    calls,
    execGit: async (args) => {
      calls.push(args);
      const result = await handler(args);
      if (result === undefined) throw new Error(`No git fixture for: ${args.join(" ")}`);
      return result;
    },
  };
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "target-scope-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("prepareTargetScope review policy", () => {
  test("explicit-file mode returns normalized explicit targets and skips git", async () => {
    const { execGit, calls } = createExecGit(() => gitResult("unexpected", 1));

    const scope = await prepareTargetScope({
      kind: "review",
      execGit,
      cwd: "/repo",
      files: ["@src/app.ts", "docs/readme.md"],
      staged: false,
    });

    expect(calls).toEqual([]);
    expect(scope).toEqual({
      targets: [
        { path: "src/app.ts", status: "explicit", source: "explicit" },
        { path: "docs/readme.md", status: "explicit", source: "explicit" },
      ],
      diff: "",
    });
  });

  test("base mode preserves rename old paths and collects branch path-limited diff", async () => {
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z main...HEAD") {
        return gitResult("R100\0old.ts\0new.ts\0M\0src/app.ts\0");
      }
      if (key === "-c core.quotepath=false diff main...HEAD -- old.ts new.ts src/app.ts") {
        return gitResult("branch diff");
      }
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "review",
      execGit,
      cwd: "/repo",
      files: [],
      staged: false,
      base: "main",
    });

    expect(calls.map((args) => args.join(" "))).toEqual([
      "diff --name-status -z main...HEAD",
      "-c core.quotepath=false diff main...HEAD -- old.ts new.ts src/app.ts",
    ]);
    expect(scope.targets).toEqual([
      { path: "new.ts", oldPath: "old.ts", status: "R100", source: "diff" },
      { path: "src/app.ts", status: "M", source: "diff" },
    ]);
    expect(scope.diff).toBe('## Diff against "main"\n\nbranch diff');
  });

  test("base mode propagates branch path-limited diff failures", async () => {
    const { execGit } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z main...HEAD") return gitResult("M\0src/app.ts\0");
      if (key === "-c core.quotepath=false diff main...HEAD -- src/app.ts") {
        return gitResult("", 128, "bad revision");
      }
      return gitResult("", 1, `unexpected ${key}`);
    });

    await expect(
      prepareTargetScope({
        kind: "review",
        execGit,
        cwd: "/repo",
        files: [],
        staged: false,
        base: "main",
      }),
    ).rejects.toThrow('Collecting Diff against "main" failed');
  });

  test("staged mode preserves rename old paths and collects cached path-limited diff", async () => {
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --cached --name-status -z") {
        return gitResult("R100\0old.ts\0new.ts\0M\0src/app.ts\0");
      }
      if (key === "-c core.quotepath=false diff --cached -- old.ts new.ts src/app.ts") {
        return gitResult("cached diff");
      }
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "review",
      execGit,
      cwd: "/repo",
      files: [],
      staged: true,
    });

    expect(calls.map((args) => args.join(" "))).toEqual([
      "diff --cached --name-status -z",
      "-c core.quotepath=false diff --cached -- old.ts new.ts src/app.ts",
    ]);
    expect(scope.targets).toEqual([
      { path: "new.ts", oldPath: "old.ts", status: "R100", source: "diff" },
      { path: "src/app.ts", status: "M", source: "diff" },
    ]);
    expect(scope.diff).toBe("## Staged diff\n\ncached diff");
  });

  test("unstaged mode collects combined HEAD diff and untracked file chunks", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "notes.txt"), "hello notes");
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z") return gitResult("M\0src/app.ts\0");
      if (key === "diff --cached --name-status -z") return gitResult("A\0src/staged.ts\0");
      if (key === "ls-files --others --exclude-standard -z") return gitResult("notes.txt\0");
      if (key === "-c core.quotepath=false diff HEAD -- src/app.ts src/staged.ts")
        return gitResult("combined diff");
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "review",
      execGit,
      cwd,
      files: [],
      staged: false,
    });

    expect(calls.map((args) => args.join(" "))).toEqual([
      "diff --name-status -z",
      "diff --cached --name-status -z",
      "ls-files --others --exclude-standard -z",
      "-c core.quotepath=false diff HEAD -- src/app.ts src/staged.ts",
    ]);
    expect(scope.targets).toEqual([
      { path: "src/app.ts", status: "M", source: "diff" },
      { path: "src/staged.ts", status: "A", source: "diff" },
      { path: "notes.txt", status: "untracked", source: "diff" },
    ]);
    expect(scope.diff).toContain("## Combined diff against HEAD\n\ncombined diff");
    expect(scope.diff).toContain('## Untracked file: "notes.txt"\n\nhello notes');
  });

  test("untracked file chunks preserve symlink, binary-looking, and read-error handling", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "target.txt"), "target");
    await symlink("target.txt", join(cwd, "link.txt"));
    await writeFile(join(cwd, "binary.bin"), "a\0b");
    await writeFile(join(cwd, "blocked.txt"), "secret");
    await chmod(join(cwd, "blocked.txt"), 0o000);

    const { execGit } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z") return gitResult("");
      if (key === "diff --cached --name-status -z") return gitResult("");
      if (key === "ls-files --others --exclude-standard -z") {
        return gitResult("link.txt\0binary.bin\0missing.txt\0blocked.txt\0");
      }
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "review",
      execGit,
      cwd,
      files: [],
      staged: false,
    });

    expect(scope.diff).toContain(
      '## Untracked file: "link.txt"\n\n[Skipped symlink -> "target.txt"]',
    );
    expect(scope.diff).toContain(
      '## Untracked file: "binary.bin"\n\n[Skipped binary-looking file content]',
    );
    expect(scope.diff).toContain('## Untracked file: "missing.txt"\n\n[Could not read file:');
  });

  test("review diff context is truncated", async () => {
    const longDiff = "x".repeat(80_050);
    const { execGit } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z") return gitResult("M\0src/app.ts\0");
      if (key === "diff --cached --name-status -z") return gitResult("");
      if (key === "ls-files --others --exclude-standard -z") return gitResult("");
      if (key === "-c core.quotepath=false diff HEAD -- src/app.ts") return gitResult(longDiff);
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "review",
      execGit,
      cwd: "/repo",
      files: [],
      staged: false,
    });

    expect(scope.diff).not.toContain(longDiff);
    expect(scope.diff).toContain(
      "[diff truncated at 80000 chars; inspect files directly before editing]",
    );
  });
});

describe("prepareTargetScope simplify policy", () => {
  test("explicit-file mode returns normalized explicit targets and skips git", async () => {
    const { execGit, calls } = createExecGit(() => gitResult("unexpected", 1));

    const scope = await prepareTargetScope({
      kind: "simplify",
      execGit,
      cwd: "/repo",
      files: ["@src/app.ts", "docs/readme.md"],
      staged: false,
    });

    expect(calls).toEqual([]);
    expect(scope).toEqual({
      targets: [
        { path: "src/app.ts", status: "explicit", source: "explicit" },
        { path: "docs/readme.md", status: "explicit", source: "explicit" },
      ],
      diff: "",
    });
  });

  test("base mode collects branch targets and branch diff without recent fallback", async () => {
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z main...HEAD") return gitResult("M\0src/app.ts\0");
      if (key === "-c core.quotepath=false diff main...HEAD") return gitResult("branch diff");
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "simplify",
      execGit,
      cwd: "/repo",
      files: [],
      staged: false,
      base: "main",
    });

    expect(calls.map((args) => args.join(" "))).toEqual([
      "diff --name-status -z main...HEAD",
      "-c core.quotepath=false diff main...HEAD",
    ]);
    expect(scope.targets).toEqual([{ path: "src/app.ts", status: "M", source: "diff" }]);
    expect(scope.diff).toBe('## Diff against "main"\n\nbranch diff');
  });

  test("base mode propagates simplify diff failures", async () => {
    const { execGit } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z main...HEAD") return gitResult("M\0src/app.ts\0");
      if (key === "-c core.quotepath=false diff main...HEAD") {
        return gitResult("", 128, "bad revision");
      }
      return gitResult("", 1, `unexpected ${key}`);
    });

    await expect(
      prepareTargetScope({
        kind: "simplify",
        execGit,
        cwd: "/repo",
        files: [],
        staged: false,
        base: "main",
      }),
    ).rejects.toThrow('Collecting Diff against "main" failed');
  });

  test("staged mode collects changed targets and cached diff", async () => {
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --cached --name-status -z") return gitResult("M\0staged-only.ts\0");
      if (key === "-c core.quotepath=false diff --cached") return gitResult("cached diff only");
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "simplify",
      execGit,
      cwd: "/repo",
      files: [],
      staged: true,
    });

    expect(calls.map((args) => args.join(" "))).toEqual([
      "diff --cached --name-status -z",
      "-c core.quotepath=false diff --cached",
    ]);
    expect(scope.targets).toEqual([{ path: "staged-only.ts", status: "M", source: "diff" }]);
    expect(scope.diff).toBe("## Staged diff\n\ncached diff only");
  });

  test("unstaged mode collects changed targets with unstaged and staged diff chunks", async () => {
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z")
        return gitResult("M\0src/app.ts\0R100\0old.ts\0new.ts\0");
      if (key === "diff --cached --name-status -z") return gitResult("A\0src/staged.ts\0");
      if (key === "ls-files --others --exclude-standard -z") return gitResult("notes.txt\0");
      if (key === "-c core.quotepath=false diff") return gitResult("unstaged diff");
      if (key === "-c core.quotepath=false diff --cached") return gitResult("staged diff");
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "simplify",
      execGit,
      cwd: "/repo",
      files: [],
      staged: false,
    });

    expect(calls.map((args) => args.join(" "))).toEqual([
      "diff --name-status -z",
      "diff --cached --name-status -z",
      "ls-files --others --exclude-standard -z",
      "-c core.quotepath=false diff",
      "-c core.quotepath=false diff --cached",
    ]);
    expect(scope.targets).toEqual([
      { path: "src/app.ts", status: "M", source: "diff" },
      { path: "new.ts", status: "R100", source: "diff" },
      { path: "src/staged.ts", status: "A", source: "diff" },
      { path: "notes.txt", status: "untracked", source: "diff" },
    ]);
    expect(scope.diff).toBe("## Unstaged diff\n\nunstaged diff\n\n## Staged diff\n\nstaged diff");
  });

  test("falls back to recent tracked files and leaves all-recent diff empty", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "recent-a.ts"), "a");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(join(cwd, "recent-b.ts"), "b");
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (
        [
          "diff --name-status -z",
          "diff --cached --name-status -z",
          "ls-files --others --exclude-standard -z",
        ].includes(key)
      ) {
        return gitResult("");
      }
      if (key === "ls-files -z") return gitResult("recent-a.ts\0missing.ts\0recent-b.ts\0");
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "simplify",
      execGit,
      cwd,
      files: [],
      staged: false,
    });

    expect(calls.map((args) => args.join(" "))).toEqual([
      "diff --name-status -z",
      "diff --cached --name-status -z",
      "ls-files --others --exclude-standard -z",
      "ls-files -z",
    ]);
    expect(scope.targets).toEqual([
      { path: "recent-b.ts", status: "recent", source: "recent" },
      { path: "recent-a.ts", status: "recent", source: "recent" },
    ]);
    expect(scope.diff).toBe("");
  });

  test("simplify diff context is truncated", async () => {
    const longDiff = "x".repeat(60_050);
    const { execGit } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "diff --name-status -z") return gitResult("M\0src/app.ts\0");
      if (key === "diff --cached --name-status -z") return gitResult("");
      if (key === "ls-files --others --exclude-standard -z") return gitResult("");
      if (key === "-c core.quotepath=false diff") return gitResult(longDiff);
      if (key === "-c core.quotepath=false diff --cached") return gitResult("");
      return gitResult("", 1, `unexpected ${key}`);
    });

    const scope = await prepareTargetScope({
      kind: "simplify",
      execGit,
      cwd: "/repo",
      files: [],
      staged: false,
    });

    expect(scope.diff).not.toContain(longDiff);
    expect(scope.diff).toContain(
      "[diff truncated at 60000 chars; inspect files directly before editing]",
    );
  });
});
