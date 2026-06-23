import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installTypeboxMock } from "../tests/support/typebox-mock";
import type { CliExec } from "./cli";

mock.module("@earendil-works/pi-ai", () => ({
  StringEnum: (values: readonly string[], options = {}) => ({ enum: values, ...options }),
}));

installTypeboxMock();

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileImpl = (
  file: string,
  args: string[],
  options: unknown,
  callback: ExecFileCallback,
) => EventEmitter;

const gitCalls: string[][] = [];

let execFileImpl: ExecFileImpl = (_file, args, _options, callback) => {
  gitCalls.push(args);
  callback(new Error("execFile mock not configured"), "", "");
  return new EventEmitter();
};

mock.module("node:child_process", () => ({
  execFile: (file: string, args: string[], options: unknown, callback: ExecFileCallback) =>
    execFileImpl(file, args, options, callback),
}));

type CloneResult = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    name: string;
    path: string;
    url: string;
    tempRoot: string;
    alreadyAdded: boolean;
    ref?: string;
    subPath?: string;
  };
};

const fakeExec: CliExec = async () => ({ code: 0, stdout: "{}", stderr: "" });
const tempDirs: string[] = [];

async function createCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "investigation-tools-test-"));
  tempDirs.push(dir);
  return dir;
}

function mockGitCloneSuccess(): void {
  execFileImpl = (_file, args, _options, callback) => {
    const child = new EventEmitter();
    if (args[0] === "clone") {
      const targetPath = args.at(-1) as string;
      tempDirs.push(dirname(targetPath));
      mkdir(targetPath, { recursive: true }).then(
        () => callback(null, "", ""),
        (error) => callback(error as Error, "", ""),
      );
      return child;
    }
    callback(new Error(`Unexpected git args: ${args.join(" ")}`), "", "");
    return child;
  };
}

function mockTreeCloneSuccess(): void {
  execFileImpl = (_file, args, _options, callback) => {
    gitCalls.push(args);
    const child = new EventEmitter();
    if (args[0] === "ls-remote") {
      callback(null, "0123456789abcdef\trefs/heads/main\n", "");
      return child;
    }
    if (args[0] === "clone") {
      const targetPath = args.at(-1) as string;
      tempDirs.push(dirname(targetPath));
      mkdir(targetPath, { recursive: true }).then(
        () => callback(null, "", ""),
        (error) => callback(error as Error, "", ""),
      );
      return child;
    }
    callback(new Error(`Unexpected git args: ${args.join(" ")}`), "", "");
    return child;
  };
}

async function loadToolset() {
  return await import("./investigation-tools");
}

async function listGithubTempRoots(): Promise<Set<string>> {
  const entries = await readdir(tmpdir());
  return new Set(
    entries
      .filter((entry) => entry.startsWith("pi-github-workspace-"))
      .map((entry) => join(tmpdir(), entry)),
  );
}

async function waitForNoNewGithubTempRoots(before: Set<string>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await listGithubTempRoots();
    const leaked = [...current].filter((root) => !before.has(root));
    if (leaked.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const current = await listGithubTempRoots();
  const leaked = [...current].filter((root) => !before.has(root));
  expect(leaked).toEqual([]);
}

afterEach(async () => {
  execFileImpl = (_file, args, _options, callback) => {
    gitCalls.push(args);
    callback(new Error("execFile mock not configured"), "", "");
    return new EventEmitter();
  };
  gitCalls.splice(0);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createInvestigationToolset", () => {
  test("exposes the six investigation tools in a stable order", async () => {
    const { createInvestigationToolset, INVESTIGATION_TOOL_NAMES } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });

    expect(toolset.toolNames).toEqual([...INVESTIGATION_TOOL_NAMES]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual([...INVESTIGATION_TOOL_NAMES]);
    expect(INVESTIGATION_TOOL_NAMES).toEqual([
      "tavily_search",
      "tavily_extract",
      "tavily_map",
      "tavily_crawl",
      "tavily_auth_status",
      "github_clone_workspace",
    ]);
  });

  test("rejects empty/null and command-injection-shaped GitHub inputs before git", async () => {
    const { createInvestigationToolset } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });
    const cwd = await createCwd();

    const clone = toolset.tools.find((tool) => tool.name === "github_clone_workspace");
    if (!clone) throw new Error("clone tool missing");

    const invalidParams = [
      { url: "" },
      { url: null },
      { url: undefined },
      { url: "https://github.com/owner%3Btouch%20pwned/repo" },
      { url: "https://github.com/owner/repo%3Btouch%20pwned" },
      { url: "https://github.com/owner/repo", directoryName: "repo;touch-pwned" },
      { url: "https://github.com/owner/repo", directoryName: "../escape" },
    ];

    for (const params of invalidParams) {
      await expect(
        clone.execute("call", params as never, undefined, undefined, { cwd } as never),
      ).rejects.toThrow();
    }

    expect(gitCalls).toEqual([]);
    await toolset.cleanup();
  });

  test("clone registers detached and cleanup removes the tracked temp root", async () => {
    const { createInvestigationToolset } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });
    const cwd = await createCwd();
    mockGitCloneSuccess();

    const clone = toolset.tools.find((tool) => tool.name === "github_clone_workspace");
    if (!clone) throw new Error("clone tool missing");

    const result = (await clone.execute(
      "call",
      { url: "https://github.com/owner/repo" },
      undefined,
      undefined,
      { cwd } as never,
    )) as CloneResult;

    expect(result.details.alreadyAdded).toBe(false);
    expect(result.details.name).toBe("repo");
    expect(result.details.url).toBe("https://github.com/owner/repo");
    expect(result.content[0].text).toContain("Cloned and registered GitHub workspace.");
    await expect(stat(result.details.tempRoot)).resolves.toBeTruthy();

    await toolset.cleanup();
    await expect(stat(result.details.tempRoot)).rejects.toThrow();
  });

  test("encoded absolute tree path is rejected and removes the cloned temp root", async () => {
    const { createInvestigationToolset } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });
    const cwd = await createCwd();
    mockTreeCloneSuccess();

    const clone = toolset.tools.find((tool) => tool.name === "github_clone_workspace");
    if (!clone) throw new Error("clone tool missing");

    await expect(
      clone.execute(
        "call",
        { url: "https://github.com/owner/repo/tree/main/%2Ftmp" },
        undefined,
        undefined,
        { cwd } as never,
      ),
    ).rejects.toThrow("escapes the cloned repository");

    expect(gitCalls.map((args) => args[0])).toEqual(["ls-remote", "clone"]);
    const tempRoot = tempDirs.find((dir) => dir.includes("pi-github-workspace-"));
    expect(tempRoot).toBeDefined();
    await expect(stat(tempRoot as string)).rejects.toThrow();
    await toolset.cleanup();
  });

  test("cleanup is idempotent and memoized", async () => {
    const { createInvestigationToolset } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });

    const first = toolset.cleanup();
    const second = toolset.cleanup();
    expect(first).toBe(second);
    await expect(Promise.all([first, second])).resolves.toBeDefined();
    await expect(toolset.cleanup()).resolves.toBeUndefined();
  });

  test("clone error path removes and untracks the temp root", async () => {
    const { createInvestigationToolset } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });
    const cwd = await createCwd();

    let capturedTempRoot: string | undefined;
    execFileImpl = (_file, args, _options, callback) => {
      const child = new EventEmitter();
      if (args[0] === "clone") {
        capturedTempRoot = dirname(args.at(-1) as string);
      }
      callback(new Error("clone failed"), "", "");
      return child;
    };

    const clone = toolset.tools.find((tool) => tool.name === "github_clone_workspace");
    if (!clone) throw new Error("clone tool missing");

    await expect(
      clone.execute("call", { url: "https://github.com/owner/repo" }, undefined, undefined, {
        cwd,
      } as never),
    ).rejects.toThrow("clone failed");

    expect(capturedTempRoot).toBeDefined();
    await expect(stat(capturedTempRoot as string)).rejects.toThrow();
    // Nothing left tracked, so cleanup is a no-op that still resolves.
    await expect(toolset.cleanup()).resolves.toBeUndefined();
  });

  test("pre-aborted clone signal rejects before git and removes the temp root", async () => {
    const { createInvestigationToolset } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });
    const cwd = await createCwd();
    const clone = toolset.tools.find((tool) => tool.name === "github_clone_workspace");
    if (!clone) throw new Error("clone tool missing");

    const rootsBefore = await listGithubTempRoots();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      clone.execute(
        "call",
        { url: "https://github.com/owner/repo" },
        abortController.signal,
        undefined,
        {
          cwd,
        } as never,
      ),
    ).rejects.toThrow("aborted");

    expect(gitCalls).toEqual([]);
    await waitForNoNewGithubTempRoots(rootsBefore);
    await toolset.cleanup();
  });

  test("tracking after shutdown removes the new root and throws", async () => {
    const { createInvestigationToolset } = await loadToolset();
    const toolset = createInvestigationToolset({ exec: fakeExec });
    const cwd = await createCwd();
    await toolset.cleanup();

    let capturedTempRoot: string | undefined;
    execFileImpl = (_file, args, _options, callback) => {
      gitCalls.push(args);
      if (args[0] === "clone") {
        capturedTempRoot = dirname(args.at(-1) as string);
      }
      callback(new Error(`git should not run after shutdown: ${args.join(" ")}`), "", "");
      return new EventEmitter();
    };

    const clone = toolset.tools.find((tool) => tool.name === "github_clone_workspace");
    if (!clone) throw new Error("clone tool missing");

    const rootsBefore = await listGithubTempRoots();
    await expect(
      clone.execute("call", { url: "https://github.com/owner/repo" }, undefined, undefined, {
        cwd,
      } as never),
    ).rejects.toThrow("shut down");

    expect(gitCalls).toEqual([]);
    expect(capturedTempRoot).toBeUndefined();
    await waitForNoNewGithubTempRoots(rootsBefore);
  });
});
