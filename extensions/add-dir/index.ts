import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  createGithubCloneWorkspaceTool,
  GITHUB_CLONE_PREFIX,
  isPathInside,
  resolveExistingDirectory,
  SAFE_GITHUB_PART,
} from "../../lib/github-clone-workspace";

const STATE_TYPE = "add-dir-state";
const GHQ_PREFIX = "ghq:";

type AddedDir = {
  name: string;
  path: string;
  temporary?: boolean;
  tempRoot?: string;
};

type PathSeparator = "/" | "\\";

type PathCompletionQuery = {
  baseDirInput: string;
  entryPrefix: string;
  separator: PathSeparator;
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function getPathSeparator(argumentPrefix: string): PathSeparator {
  if (
    process.platform === "win32" &&
    argumentPrefix.lastIndexOf("\\") > argumentPrefix.lastIndexOf("/")
  ) {
    return "\\";
  }
  return "/";
}

function getLastPathSeparatorIndex(argumentPrefix: string): number {
  const lastSlashIndex = argumentPrefix.lastIndexOf("/");
  if (process.platform !== "win32") return lastSlashIndex;
  return Math.max(lastSlashIndex, argumentPrefix.lastIndexOf("\\"));
}

function parsePathCompletionPrefix(argumentPrefix: string): PathCompletionQuery {
  if (argumentPrefix === "~") return { baseDirInput: "~/", entryPrefix: "", separator: "/" };

  const separator = getPathSeparator(argumentPrefix);
  if (argumentPrefix.endsWith(separator)) {
    return { baseDirInput: argumentPrefix, entryPrefix: "", separator };
  }

  const lastSeparatorIndex = getLastPathSeparatorIndex(argumentPrefix);
  const baseDirInput =
    lastSeparatorIndex === -1 ? "" : argumentPrefix.slice(0, lastSeparatorIndex + 1);
  const entryPrefix =
    lastSeparatorIndex === -1 ? argumentPrefix : argumentPrefix.slice(lastSeparatorIndex + 1);
  if (entryPrefix === "." || entryPrefix === "..") {
    return {
      baseDirInput: `${baseDirInput}${entryPrefix}${separator}`,
      entryPrefix: "",
      separator,
    };
  }

  return {
    baseDirInput,
    entryPrefix,
    separator: lastSeparatorIndex === -1 ? "/" : separator,
  };
}

function isUnsafeBareCompletionName(name: string): boolean {
  return name === "~" || name.toLowerCase().startsWith(GHQ_PREFIX) || name.trimStart() !== name;
}

function formatDirectoryCompletionValue(
  baseDirInput: string,
  name: string,
  separator: PathSeparator,
): string {
  if (!baseDirInput) {
    if (isUnsafeBareCompletionName(name)) return `.${separator}${name}${separator}`;
    return `${name}${separator}`;
  }
  return `${baseDirInput}${name}${separator}`;
}

async function getDirectoryCompletions(
  argumentPrefix: string,
  cwd: string,
): Promise<AutocompleteItem[] | null> {
  const query = parsePathCompletionPrefix(argumentPrefix);
  const baseDirPath = resolve(cwd, expandHome(query.baseDirInput || "."));
  let entries: Dirent[];

  try {
    entries = await readdir(baseDirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const suggestions: AutocompleteItem[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(query.entryPrefix)) continue;

    let isDirectory = entry.isDirectory();
    if (!isDirectory) {
      if (!entry.isSymbolicLink()) continue;

      try {
        isDirectory = (await stat(resolve(baseDirPath, entry.name))).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
    }

    const value = formatDirectoryCompletionValue(query.baseDirInput, entry.name, query.separator);
    suggestions.push({ value, label: value });
  }

  suggestions.sort((left, right) => left.value.localeCompare(right.value));
  return suggestions.length > 0 ? suggestions : null;
}

function isAddedDir(value: unknown): value is AddedDir {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AddedDir).name === "string" &&
    typeof (value as AddedDir).path === "string" &&
    ((value as AddedDir).temporary === undefined ||
      typeof (value as AddedDir).temporary === "boolean") &&
    ((value as AddedDir).tempRoot === undefined || typeof (value as AddedDir).tempRoot === "string")
  );
}

function formatDirs(dirs: AddedDir[]): string {
  return dirs.map((dir) => `- ${dir.name}: ${dir.path}`).join("\n");
}

function validateGhqQuery(input: string): string {
  const query = input.trim();
  if (!query) {
    throw new Error("ghq: の後にリポジトリ名を指定してください。例: /add-dir ghq:<repo>");
  }

  const segments = query.split("/");
  if (segments.length > 2 || segments.some((segment) => segment.length === 0)) {
    throw new Error(
      "domain を含む ghq 指定は未対応です。ghq:<repo> または ghq:<org>/<repo> の形式で指定してください。",
    );
  }

  if (
    segments.some(
      (segment) => segment === "." || segment === ".." || !SAFE_GITHUB_PART.test(segment),
    )
  ) {
    throw new Error("ghq 指定には英数字、'.'、'_'、'-' のみ使用できます。例: /add-dir ghq:<repo>");
  }

  return query;
}

function listGhqRepositories(query: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    execFile("ghq", ["list", "-p", "--exact", "--", query], {}, (error, stdout, stderr) => {
      if (error) {
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(details || error.message || "ghq list command failed"));
        return;
      }

      resolvePromise(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
  });
}

export default function (pi: ExtensionAPI) {
  let dirs: AddedDir[] = [];
  let tempRoots: string[] = [];
  let sessionCwd: string | undefined;

  function persist(nextDirs: AddedDir[]) {
    pi.appendEntry(STATE_TYPE, { dirs: nextDirs });
  }

  function removedTemporaryRoots(previousDirs: AddedDir[], nextDirs: AddedDir[]): string[] {
    const retainedRoots = new Set(
      nextDirs.filter((dir) => dir.temporary && dir.tempRoot).map((dir) => dir.tempRoot as string),
    );
    return [
      ...new Set(
        previousDirs
          .filter((dir) => dir.temporary && dir.tempRoot && !retainedRoots.has(dir.tempRoot))
          .map((dir) => dir.tempRoot as string),
      ),
    ];
  }

  async function cleanupTemporaryRoots(roots: string[]): Promise<void> {
    if (roots.length === 0) return;
    const rootSet = new Set(roots);
    const uniqueRoots = [...rootSet];
    tempRoots = tempRoots.filter((root) => !rootSet.has(root));

    const results = await Promise.allSettled(
      uniqueRoots.map((root) => rm(root, { recursive: true, force: true })),
    );
    const failedRoots = uniqueRoots.filter((_, index) => results[index]?.status === "rejected");
    if (failedRoots.length > 0) {
      tempRoots = [...new Set([...tempRoots, ...failedRoots])];
    }
  }

  async function validateRestoredTemporaryDir(dir: AddedDir): Promise<AddedDir | undefined> {
    if (!dir.tempRoot) return undefined;

    try {
      const canonicalTempRoot = await realpath(dir.tempRoot);
      const canonicalTmpDir = await realpath(tmpdir());
      if (!basename(canonicalTempRoot).startsWith(GITHUB_CLONE_PREFIX)) {
        return undefined;
      }
      if (!isPathInside(canonicalTmpDir, canonicalTempRoot)) return undefined;

      const canonicalDirPath = await realpath(dir.path);
      if (!isPathInside(canonicalTempRoot, canonicalDirPath)) return undefined;

      return {
        ...dir,
        path: canonicalDirPath,
        tempRoot: canonicalTempRoot,
      };
    } catch {
      return undefined;
    }
  }

  async function addDirectory(
    input: string,
    cwd: string,
    metadata: Pick<AddedDir, "temporary" | "tempRoot"> = {},
    containmentRoot?: string,
  ): Promise<{ dir: AddedDir; alreadyAdded: boolean }> {
    const resolvedDir = await resolveExistingDirectory(input, cwd);
    if (containmentRoot && !isPathInside(containmentRoot, resolvedDir.path)) {
      throw new Error(
        `GitHub URL path resolves outside the cloned repository: ${resolvedDir.path}`,
      );
    }
    const dir: AddedDir = { ...resolvedDir, ...metadata };

    const samePath = dirs.find((existing) => existing.path === dir.path);
    if (samePath) {
      return { dir: samePath, alreadyAdded: true };
    }

    const sameName = dirs.find((existing) => existing.name === dir.name);
    if (sameName) {
      throw new Error(
        `Cannot add ${dir.path}: directory name "${dir.name}" is already registered for ${sameName.path}. Remove it first with /remove-dir ${dir.name}.`,
      );
    }

    const nextDirs = [...dirs, dir];
    persist(nextDirs);
    dirs = nextDirs;
    return { dir, alreadyAdded: false };
  }

  function notifyAddDirectoryResult(
    ui: { notify: (message: string, level: "info" | "error") => void },
    dir: AddedDir,
    alreadyAdded: boolean,
  ): void {
    ui.notify(
      alreadyAdded
        ? `すでに登録済みです: ${dir.name}: ${dir.path}`
        : `ディレクトリを追加しました: ${dir.name}: ${dir.path}`,
      "info",
    );
  }

  async function addGhqDirectory(
    queryInput: string,
    ctx: { cwd: string; ui: { notify: (message: string, level: "info" | "error") => void } },
  ): Promise<void> {
    const query = validateGhqQuery(queryInput);
    let candidates: string[];
    try {
      candidates = await listGhqRepositories(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`ghq リポジトリの検索に失敗しました: ${message}`, "error");
      return;
    }

    if (candidates.length === 0) {
      ctx.ui.notify(`既存の ghq リポジトリが見つかりませんでした: ${query}`, "error");
      return;
    }

    if (candidates.length > 1) {
      ctx.ui.notify(
        [
          `複数の ghq リポジトリが見つかりました: ${query}`,
          ...candidates.map((candidate) => `- ${candidate}`),
          "ghq:<org>/<repo> など、より具体的な指定にしてください。",
        ].join("\n"),
        "error",
      );
      return;
    }

    try {
      const { dir, alreadyAdded } = await addDirectory(candidates[0], ctx.cwd);
      notifyAddDirectoryResult(ctx.ui, dir, alreadyAdded);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`ディレクトリの登録に失敗しました (${candidates[0]}): ${message}`, "error");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    dirs = [];
    tempRoots = [];
    sessionCwd = ctx.cwd;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;

      const data = entry.data as { dirs?: unknown } | undefined;
      if (!Array.isArray(data?.dirs)) continue;

      dirs = data.dirs.filter(isAddedDir);
    }

    dirs = (
      await Promise.all(
        dirs.map(async (dir) => {
          try {
            const stats = await stat(dir.path);
            if (!stats.isDirectory()) return undefined;
            return dir.temporary ? validateRestoredTemporaryDir(dir) : dir;
          } catch {
            // Drop stale temporary paths from previous sessions.
            return dir.temporary ? undefined : dir;
          }
        }),
      )
    ).filter((dir): dir is AddedDir => dir !== undefined);
    tempRoots = dirs
      .filter((dir) => dir.temporary && dir.tempRoot)
      .map((dir) => dir.tempRoot as string);
  });

  pi.registerCommand("add-dir", {
    description:
      "Register an additional directory name for this session, including ghq repositories with ghq:<repo> or ghq:<org>/<repo>",
    getArgumentCompletions: async (argumentPrefix) => {
      if (!sessionCwd) return null;

      const normalizedPrefix = argumentPrefix.trimStart();
      if (normalizedPrefix.toLowerCase().startsWith(GHQ_PREFIX)) return null;
      return getDirectoryCompletions(normalizedPrefix, sessionCwd);
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("使い方: /add-dir <path> または /add-dir ghq:<repo>", "error");
        return;
      }

      try {
        if (input.toLowerCase().startsWith(GHQ_PREFIX)) {
          await addGhqDirectory(input.slice(GHQ_PREFIX.length), ctx);
          return;
        }

        const { dir, alreadyAdded } = await addDirectory(input, ctx.cwd);
        notifyAddDirectoryResult(ctx.ui, dir, alreadyAdded);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });

  pi.registerCommand("list-dir", {
    description: "List additional directories registered for this session",
    handler: async (_args, ctx) => {
      if (dirs.length === 0) {
        ctx.ui.notify("追加ディレクトリは登録されていません。", "info");
        return;
      }

      ctx.ui.notify(formatDirs(dirs), "info");
    },
  });

  pi.registerCommand("remove-dir", {
    description: "Remove an additional directory from this session",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify("使い方: /remove-dir <directory-name-or-path>", "error");
        return;
      }

      const expanded = expandHome(input);
      const resolved = resolve(ctx.cwd, expanded);
      const before = dirs.length;
      const nextDirs = dirs.filter(
        (dir) => dir.name !== input && dir.path !== input && dir.path !== resolved,
      );

      if (nextDirs.length === before) {
        ctx.ui.notify(`一致する登録ディレクトリがありません: ${input}`, "error");
        return;
      }

      const removedRoots = removedTemporaryRoots(dirs, nextDirs);
      await cleanupTemporaryRoots(removedRoots);
      persist(nextDirs);
      dirs = nextDirs;
      ctx.ui.notify(
        dirs.length === 0
          ? "ディレクトリを削除しました。追加ディレクトリはありません。"
          : `ディレクトリを削除しました。残り:\n${formatDirs(dirs)}`,
        "info",
      );
    },
  });

  pi.registerTool(
    createGithubCloneWorkspaceTool({
      register: (input, cwd, metadata, containmentRoot) =>
        addDirectory(input, cwd, metadata, containmentRoot),
      trackTempRoot: (root) => {
        tempRoots = [...tempRoots, root];
      },
      untrackTempRoot: (root) => {
        tempRoots = tempRoots.filter((path) => path !== root);
      },
    }),
  );

  pi.on("session_shutdown", async (event) => {
    sessionCwd = undefined;
    if (event.reason === "reload") return;

    await cleanupTemporaryRoots([...tempRoots]);
  });

  pi.on("before_agent_start", async (event) => {
    if (dirs.length === 0) return;

    const context = [
      "Additional workspace roots registered by the user for this session:",
      formatDirs(dirs),
      "",
      "When the user refers to one of the names above, interpret it as the corresponding absolute path.",
      "Use absolute paths when accessing these additional roots.",
    ].join("\n");

    return {
      systemPrompt: `${event.systemPrompt}\n\n${context}`,
    };
  });
}
