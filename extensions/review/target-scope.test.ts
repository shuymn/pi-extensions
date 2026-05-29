import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, ExecGit } from "../../lib/command";
import { prepareTargetScope } from "./target-scope";

type GitCall = string[];

const tempDirs: string[] = [];

function gitResult(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

function createExecGit(handler: (args: string[]) => CommandResult | Promise<CommandResult>): {
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

describe("prepareTargetScope", () => {
  test("explicit-file mode returns normalized explicit targets and skips git", async () => {
    const { execGit, calls } = createExecGit(() => gitResult("unexpected", 1));

    const scope = await prepareTargetScope({
      execGit,
      cwd: "/repo",
      files: ["@src/app.ts", "docs/readme.md"],
      staged: false,
    });

    expect(calls).toEqual([]);
    expect(scope).toEqual({
      scope: { kind: "explicit", files: ["@src/app.ts", "docs/readme.md"] },
      targets: [
        { path: "src/app.ts", status: "explicit", source: "explicit" },
        { path: "docs/readme.md", status: "explicit", source: "explicit" },
      ],
      diff: "",
    });
  });

  test("pr mode collects pull request file targets and patch diff when local HEAD matches a clean worktree", async () => {
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") return gitResult("abc123\n");
      if (key === "status --porcelain") return gitResult("");
      return gitResult("", 1, `unexpected git ${key}`);
    });
    const ghCalls: GitCall[] = [];
    const execGh = async (args: string[]) => {
      ghCalls.push(args);
      const key = args.join(" ");
      if (key === "pr view 123 --json files,headRefOid") {
        return gitResult(
          JSON.stringify({
            files: [{ path: "src/app.ts" }, { path: "docs/readme.md" }],
            headRefOid: "abc123",
          }),
        );
      }
      if (key === "pr diff 123 --patch") return gitResult("pr patch");
      return gitResult("", 1, `unexpected gh ${key}`);
    };

    const scope = await prepareTargetScope({
      execGit,
      execGh,
      cwd: "/repo",
      files: [],
      staged: false,
      pr: "123",
    });

    expect(ghCalls.map((args) => args.join(" "))).toEqual([
      "pr view 123 --json files,headRefOid",
      "pr diff 123 --patch",
    ]);
    expect(calls.map((args) => args.join(" "))).toEqual(["rev-parse HEAD", "status --porcelain"]);
    expect(scope).toEqual({
      scope: { kind: "pr", selector: "123" },
      targets: [
        { path: "src/app.ts", status: "pr", source: "pr" },
        { path: "docs/readme.md", status: "pr", source: "pr" },
      ],
      diff: '## Pull request diff for "123"\n\npr patch',
    });
  });

  test("pr mode downgrades to no-fix when worktree is dirty even though local HEAD matches", async () => {
    const { execGit, calls } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") return gitResult("abc123\n");
      if (key === "status --porcelain") return gitResult(" M src/app.ts\n");
      return gitResult("", 1, `unexpected git ${key}`);
    });
    const execGh = async (args: string[]) => {
      const key = args.join(" ");
      if (key === "pr view 123 --json files,headRefOid") {
        return gitResult(JSON.stringify({ files: [{ path: "src/app.ts" }], headRefOid: "abc123" }));
      }
      if (key === "pr diff 123 --patch") return gitResult("pr patch");
      return gitResult("", 1, `unexpected gh ${key}`);
    };

    const scope = await prepareTargetScope({
      execGit,
      execGh,
      cwd: "/repo",
      files: [],
      staged: false,
      pr: "123",
    });

    expect(calls.map((args) => args.join(" "))).toEqual(["rev-parse HEAD", "status --porcelain"]);
    expect(scope.noFixReason).toEqual({ kind: "pr_worktree_dirty" });
  });

  test("pr mode skips safety and diff calls when pull request has no files", async () => {
    const { execGit, calls } = createExecGit(() => gitResult("unexpected", 1));
    const ghCalls: GitCall[] = [];
    const execGh = async (args: string[]) => {
      ghCalls.push(args);
      const key = args.join(" ");
      if (key === "pr view 123 --json files,headRefOid") {
        return gitResult(JSON.stringify({ files: [], headRefOid: "abc123" }));
      }
      return gitResult("", 1, `unexpected gh ${key}`);
    };

    const scope = await prepareTargetScope({
      execGit,
      execGh,
      cwd: "/repo",
      files: [],
      staged: false,
      pr: "123",
    });

    expect(scope).toEqual({ scope: { kind: "pr", selector: "123" }, targets: [], diff: "" });
    expect(calls).toEqual([]);
    expect(ghCalls.map((args) => args.join(" "))).toEqual(["pr view 123 --json files,headRefOid"]);
  });

  test("pr mode converts cross-repo selectors to GitHub pull request URLs", async () => {
    const { execGit } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") return gitResult("abc123\n");
      if (key === "status --porcelain") return gitResult("");
      return gitResult("", 1, `unexpected git ${key}`);
    });
    const ghCalls: GitCall[] = [];
    const execGh = async (args: string[]) => {
      ghCalls.push(args);
      const key = args.join(" ");
      if (key === "pr view https://github.com/owner/repo/pull/123 --json files,headRefOid") {
        return gitResult(JSON.stringify({ files: [{ path: "src/app.ts" }], headRefOid: "abc123" }));
      }
      if (key === "pr diff https://github.com/owner/repo/pull/123 --patch") {
        return gitResult("pr patch");
      }
      return gitResult("", 1, `unexpected gh ${key}`);
    };

    await prepareTargetScope({
      execGit,
      execGh,
      cwd: "/repo",
      files: [],
      staged: false,
      pr: "https://github.com/owner/repo/pull/123",
    });

    expect(ghCalls.map((args) => args.join(" "))).toEqual([
      "pr view https://github.com/owner/repo/pull/123 --json files,headRefOid",
      "pr diff https://github.com/owner/repo/pull/123 --patch",
    ]);
  });

  test("pr mode rejects malformed pull request file metadata", async () => {
    const { execGit } = createExecGit(() => gitResult("unexpected", 1));
    const execGh = async (args: string[]) => {
      const key = args.join(" ");
      if (key === "pr view 123 --json files,headRefOid") {
        return gitResult(
          JSON.stringify({ files: [{ filename: "src/app.ts" }], headRefOid: "abc123" }),
        );
      }
      return gitResult("", 1, `unexpected gh ${key}`);
    };

    await expect(
      prepareTargetScope({
        execGit,
        execGh,
        cwd: "/repo",
        files: [],
        staged: false,
        pr: "123",
      }),
    ).rejects.toThrow("pull request file at index 0 did not include a valid path");
  });

  test("pr mode rejects unsafe pull request file paths", async () => {
    const { execGit } = createExecGit(() => gitResult("unexpected", 1));
    const execGh = async (args: string[]) => {
      const key = args.join(" ");
      if (key === "pr view 123 --json files,headRefOid") {
        return gitResult(
          JSON.stringify({ files: [{ path: "../outside.ts" }], headRefOid: "abc123" }),
        );
      }
      return gitResult("", 1, `unexpected gh ${key}`);
    };

    await expect(
      prepareTargetScope({
        execGit,
        execGh,
        cwd: "/repo",
        files: [],
        staged: false,
        pr: "123",
      }),
    ).rejects.toThrow("Unsafe pull request file path");
  });

  test("pr mode adds no-fix reason when local HEAD differs from PR head", async () => {
    const { execGit } = createExecGit((args) => {
      if (args.join(" ") === "rev-parse HEAD") return gitResult("local456\n");
      return gitResult("", 1, `unexpected git ${args.join(" ")}`);
    });
    const execGh = async (args: string[]) => {
      const key = args.join(" ");
      if (key === "pr view 123 --json files,headRefOid") {
        return gitResult(JSON.stringify({ files: [{ path: "src/app.ts" }], headRefOid: "pr123" }));
      }
      if (key === "pr diff 123 --patch") return gitResult("pr patch");
      return gitResult("", 1, `unexpected gh ${key}`);
    };

    const scope = await prepareTargetScope({
      execGit,
      execGh,
      cwd: "/repo",
      files: [],
      staged: false,
      pr: "123",
    });

    expect(scope.noFixReason).toEqual({
      kind: "pr_head_mismatch",
      prHeadOid: "pr123",
      localHeadOid: "local456",
    });
  });

  test("pr mode requires an explicit gh executor", async () => {
    const { execGit } = createExecGit(() => gitResult("unexpected", 1));

    await expect(
      prepareTargetScope({
        execGit,
        cwd: "/repo",
        files: [],
        staged: false,
        pr: "123",
      }),
    ).rejects.toThrow("requires a gh executor");
  });

  test("pr mode propagates pull request lookup failures", async () => {
    const { execGit } = createExecGit((args) => {
      const key = args.join(" ");
      if (key === "pr view missing --json files,headRefOid") return gitResult("", 1, "not found");
      return gitResult("", 1, `unexpected ${key}`);
    });

    await expect(
      prepareTargetScope({
        execGit,
        execGh: execGit,
        cwd: "/repo",
        files: [],
        staged: false,
        pr: "missing",
      }),
    ).rejects.toThrow('Collecting pull request targets for "missing" failed');
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
