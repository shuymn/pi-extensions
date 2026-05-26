import { describe, expect, test } from "bun:test";

import {
  buildRepoSandboxConfig,
  captureRepoFingerprint,
  createFailClosedBashOperations,
  resetSandboxState,
  resolveRepoGitPaths,
  type ExecFn,
  type RepoGitPaths,
} from "./protected-bash";

function makeMockExec(
  responses: Map<string, { code: number; stdout: string; stderr: string }>,
): ExecFn {
  return async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const response = responses.get(key);
    if (response) return response;
    return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
  };
}

function repoPaths(): RepoGitPaths {
  return {
    worktree: "/home/user/project",
    dotGit: "/home/user/project/.git",
    gitDir: "/home/user/project/.git",
    gitCommonDir: "/home/user/project/.git",
  };
}

describe("resolveRepoGitPaths", () => {
  test("resolves worktree, .git, gitDir, and commonDir", async () => {
    const exec = makeMockExec(
      new Map([
        [
          "git -C /my/repo rev-parse --show-toplevel",
          { code: 0, stdout: "/my/repo\n", stderr: "" },
        ],
        ["git -C /my/repo rev-parse --git-dir", { code: 0, stdout: ".git\n", stderr: "" }],
        ["git -C /my/repo rev-parse --git-common-dir", { code: 0, stdout: ".git\n", stderr: "" }],
      ]),
    );

    const paths = await resolveRepoGitPaths(exec, "/my/repo");
    expect(paths.worktree).toBe("/my/repo");
    expect(paths.gitDir).toBe("/my/repo/.git");
    expect(paths.gitCommonDir).toBe("/my/repo/.git");
    expect(paths.dotGit).toBe("/my/repo/.git");
  });

  test("handles separate git dir (submodule or worktree)", async () => {
    const exec = makeMockExec(
      new Map([
        [
          "git -C /my/repo/sub rev-parse --show-toplevel",
          { code: 0, stdout: "/my/repo/sub\n", stderr: "" },
        ],
        [
          "git -C /my/repo/sub rev-parse --git-dir",
          {
            code: 0,
            stdout: "/my/repo/.git/modules/sub\n",
            stderr: "",
          },
        ],
        [
          "git -C /my/repo/sub rev-parse --git-common-dir",
          {
            code: 0,
            stdout: "/my/repo/.git/modules/sub\n",
            stderr: "",
          },
        ],
      ]),
    );

    const paths = await resolveRepoGitPaths(exec, "/my/repo/sub");
    expect(paths.worktree).toBe("/my/repo/sub");
    expect(paths.gitDir).toBe("/my/repo/.git/modules/sub");
    expect(paths.gitCommonDir).toBe("/my/repo/.git/modules/sub");
    expect(paths.dotGit).toBe("/my/repo/sub/.git");
  });

  test("throws when worktree resolution fails", async () => {
    const exec = makeMockExec(
      new Map([
        [
          "git -C /not-a-repo rev-parse --show-toplevel",
          { code: 128, stdout: "", stderr: "fatal: not a git repository\n" },
        ],
        [
          "git -C /not-a-repo rev-parse --git-dir",
          { code: 128, stdout: "", stderr: "fatal: not a git repository\n" },
        ],
        [
          "git -C /not-a-repo rev-parse --git-common-dir",
          { code: 128, stdout: "", stderr: "fatal: not a git repository\n" },
        ],
      ]),
    );

    await expect(resolveRepoGitPaths(exec, "/not-a-repo")).rejects.toThrow(
      "Failed to resolve git worktree",
    );
  });
});

describe("buildRepoSandboxConfig", () => {
  test("denies writes to worktree and all git directories", () => {
    const paths = repoPaths();
    const config = buildRepoSandboxConfig(paths);

    expect(config.filesystem.denyWrite).toContain(paths.worktree);
    expect(config.filesystem.denyWrite).toContain(paths.gitDir);
    expect(config.filesystem.denyWrite).toContain(paths.gitCommonDir);
    expect(config.filesystem.denyWrite).toContain(paths.dotGit);
  });

  test("uses platform-safe repository-external write allow paths", () => {
    const config = buildRepoSandboxConfig(repoPaths());

    if (process.platform === "darwin") {
      expect(config.filesystem.allowWrite).toContain("/");
    } else {
      expect(config.filesystem.allowWrite).not.toContain("/");
      expect(config.filesystem.allowWrite).toContain("/tmp");
    }
  });

  test("allows local network binding for proxy support", () => {
    const config = buildRepoSandboxConfig(repoPaths());
    expect(config.network.allowLocalBinding).toBe(true);
  });
});

describe("captureRepoFingerprint", () => {
  test("returns a SHA-256 hash of git status output", async () => {
    const exec = makeMockExec(
      new Map([
        [
          "git -C /my/repo status --porcelain=v1 -z --untracked-files=all",
          { code: 0, stdout: " M tracked.ts\0", stderr: "" },
        ],
      ]),
    );

    const fingerprint = await captureRepoFingerprint(exec, "/my/repo");
    // Should be 64 hex chars (SHA-256)
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("produces different fingerprints for different states", async () => {
    const execEmpty = makeMockExec(
      new Map([
        [
          "git -C /my/repo status --porcelain=v1 -z --untracked-files=all",
          { code: 0, stdout: "", stderr: "" },
        ],
      ]),
    );

    const execDirty = makeMockExec(
      new Map([
        [
          "git -C /my/repo status --porcelain=v1 -z --untracked-files=all",
          { code: 0, stdout: " M file.ts\0", stderr: "" },
        ],
      ]),
    );

    const fpEmpty = await captureRepoFingerprint(execEmpty, "/my/repo");
    const fpDirty = await captureRepoFingerprint(execDirty, "/my/repo");
    expect(fpEmpty).not.toBe(fpDirty);
  });

  test("produces same fingerprint for same state", async () => {
    const execA = makeMockExec(
      new Map([
        [
          "git -C /my/repo status --porcelain=v1 -z --untracked-files=all",
          { code: 0, stdout: " M app.ts\0?? notes.txt\0", stderr: "" },
        ],
      ]),
    );
    const execB = makeMockExec(
      new Map([
        [
          "git -C /my/repo status --porcelain=v1 -z --untracked-files=all",
          { code: 0, stdout: " M app.ts\0?? notes.txt\0", stderr: "" },
        ],
      ]),
    );

    const fpA = await captureRepoFingerprint(execA, "/my/repo");
    const fpB = await captureRepoFingerprint(execB, "/my/repo");
    expect(fpA).toBe(fpB);
  });

  test("throws when git status fails", async () => {
    const exec = makeMockExec(
      new Map([
        [
          "git -C /my/repo status --porcelain=v1 -z --untracked-files=all",
          { code: 128, stdout: "", stderr: "fatal: not a git repository" },
        ],
      ]),
    );

    await expect(captureRepoFingerprint(exec, "/my/repo")).rejects.toThrow(
      "Failed to capture repo fingerprint",
    );
  });
});

describe("createFailClosedBashOperations", () => {
  test("throws the provided reason on exec", async () => {
    const ops = createFailClosedBashOperations("PROTECTED_READ_ONLY_BASH: Sandbox is unavailable.");

    await expect(
      ops.exec("echo hello", "/tmp", {
        onData: () => {},
      }),
    ).rejects.toThrow("PROTECTED_READ_ONLY_BASH: Sandbox is unavailable.");
  });
});

describe("resetSandboxState", () => {
  test("does not throw when called", async () => {
    await expect(resetSandboxState()).resolves.toBeUndefined();
  });
});
