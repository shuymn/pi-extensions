import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { branchDiffRange, normalizeBaseBranch } from "../../lib/git";
import { normalizePullRequestSelector } from "../../lib/github";
import { hasControlCharacter } from "../../lib/text";
import type { ReviewControlsOptions, ReviewExec, ReviewPreparedScope, ReviewScope } from "./types";

const MAX_BYTES = 2 * 1024 * 1024;
type Host = Pick<ReviewControlsOptions, "cwd" | "execGit" | "execGh">;

/** Derive review scope and recheck repository facts immediately before an authorized fix. */
export async function prepareReviewScope(
  input: ReviewScope,
  host: Host,
  signal?: AbortSignal,
): Promise<ReviewPreparedScope> {
  const scope = normalizeScope(input);
  const root = await required(host.execGit, ["rev-parse", "--show-toplevel"], host, signal);
  if ((await realpath(root.trim())) !== (await realpath(host.cwd))) {
    throw new Error("Review cwd must be the repository root.");
  }
  let targetFiles: string[];
  let diff: string;
  let prHeadOid: string | undefined;
  let prCheckoutMatches: boolean | undefined;
  if (scope.mode === "files") {
    targetFiles = scope.files ?? [];
    diff = "Whole-file review, not a diff-only review.";
  } else if (scope.mode === "pr") {
    const metadata = JSON.parse(
      await required(
        host.execGh,
        ["pr", "view", scope.pr ?? "", "--json", "files,headRefOid"],
        host,
        signal,
      ),
    ) as { files?: unknown; headRefOid?: unknown };
    prHeadOid = headOid(metadata.headRefOid);
    if (!Array.isArray(metadata.files)) throw new Error("PR metadata did not include files.");
    targetFiles = metadata.files.map((file: unknown) => {
      if (!file || typeof file !== "object" || !("path" in file)) {
        throw new Error("Invalid PR file metadata.");
      }
      return safeRepositoryPath(file.path);
    });
    diff = await required(host.execGh, ["pr", "diff", scope.pr ?? ""], host, signal);
    prCheckoutMatches = await recheckPullRequest(scope.pr ?? "", prHeadOid, host, signal);
  } else {
    const revisions =
      scope.mode === "base"
        ? [branchDiffRange(scope.base ?? "")]
        : scope.mode === "staged"
          ? ["--cached"]
          : [];
    const [names, patch] = await Promise.all([
      required(host.execGit, ["diff", "--name-only", "-z", ...revisions], host, signal),
      required(
        host.execGit,
        ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...revisions],
        host,
        signal,
      ),
    ]);
    targetFiles = nulPaths(names);
    diff = patch;
    if (scope.mode === "working") {
      const [staged, untracked, stagedPatch] = await Promise.all([
        required(host.execGit, ["diff", "--cached", "--name-only", "-z"], host, signal),
        required(host.execGit, ["ls-files", "--others", "--exclude-standard", "-z"], host, signal),
        required(
          host.execGit,
          ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"],
          host,
          signal,
        ),
      ]);
      targetFiles.push(...nulPaths(staged), ...nulPaths(untracked));
      diff = `Unstaged changes:\n${patch}\nStaged changes:\n${stagedPatch}`;
    }
  }
  targetFiles = [...new Set(targetFiles.map(safeRepositoryPath))].sort();
  if (targetFiles.length > 500) throw new Error("Review scope exceeds 500 files; narrow it.");
  for (const file of targetFiles) {
    await containedPath(host.cwd, file);
    if (scope.mode === "files") {
      const stat = await lstat(resolve(host.cwd, file));
      if (!stat.isFile()) throw new Error(`Explicit review target is not a regular file: ${file}`);
    }
  }
  return {
    scope,
    targetFiles,
    diff,
    fingerprint: await fingerprint(targetFiles, host, signal),
    ...(prHeadOid === undefined ? {} : { prHeadOid, prCheckoutMatches }),
  };
}

/** No intervening agent work is permitted between this check and the mutating runner. */
export async function reauthorizeReviewFix(
  prepared: ReviewPreparedScope,
  host: Host,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if ((await fingerprint(prepared.targetFiles, host, signal)) !== prepared.fingerprint) {
      return false;
    }
    if (prepared.scope.mode !== "pr") return true;
    return (
      prepared.prCheckoutMatches === true &&
      prepared.prHeadOid !== undefined &&
      (await recheckPullRequest(prepared.scope.pr ?? "", prepared.prHeadOid, host, signal))
    );
  } catch {
    return false;
  }
}

function normalizeScope(input: ReviewScope): ReviewScope {
  const expected = input.mode === "files" ? "files" : input.mode === "pr" ? "pr" : "base";
  for (const key of ["files", "pr", "base"] as const) {
    if (
      input[key] !== undefined &&
      (key !== expected || ["staged", "working"].includes(input.mode))
    ) {
      throw new Error("Review scope must select exactly one mode and its matching argument.");
    }
  }
  if (input.mode === "files") {
    if (!input.files?.length) throw new Error("Files scope requires files.");
    return { mode: "files", files: [...new Set(input.files.map(safeRepositoryPath))].sort() };
  }
  if (input.mode === "pr") {
    const pr = normalizePullRequestSelector(input.pr);
    if (!pr) throw new Error("PR scope requires a selector.");
    return { mode: "pr", pr };
  }
  if (input.mode === "base") {
    const base = normalizeBaseBranch(input.base);
    if (!base) throw new Error("Base scope requires a base ref.");
    return { mode: "base", base };
  }
  return { mode: input.mode };
}

export function safeRepositoryPath(path: unknown): string {
  if (
    typeof path !== "string" ||
    path.trim() !== path ||
    !path ||
    path.startsWith("~") ||
    path.startsWith("-") ||
    path.includes("\\") ||
    path.includes(":") ||
    isAbsolute(path) ||
    hasControlCharacter(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error("Review target must be a safe repository-relative file path.");
  }
  return path;
}

async function containedPath(cwd: string, file: string): Promise<void> {
  const root = await realpath(cwd);
  let candidate = resolve(cwd, file);
  while (true) {
    try {
      const resolved = await realpath(candidate);
      const path = relative(root, resolved);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new Error(`Review target escapes the repository: ${file}`);
      }
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (candidate === dirname(candidate)) throw error;
      candidate = dirname(candidate);
    }
  }
}

async function fingerprint(files: string[], host: Host, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for (const args of [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    ["diff", "--no-ext-diff", "--no-textconv", "--binary"],
    ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"],
  ]) {
    hash.update(JSON.stringify([args, await required(host.execGit, args, host, signal)]));
  }
  for (const file of files) {
    signal?.throwIfAborted();
    await containedPath(host.cwd, file);
    try {
      const path = resolve(host.cwd, file);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_BYTES) {
        throw new Error(`Review target is not a bounded regular file: ${file}`);
      }
      const content = await readFile(path);
      if (content.byteLength > MAX_BYTES)
        throw new Error(`Review target grew beyond 2 MiB: ${file}`);
      hash.update(JSON.stringify([file, "file", content.byteLength]));
      hash.update(content);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      hash.update(JSON.stringify([file, "missing"]));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function recheckPullRequest(
  selector: string,
  expectedHead: string,
  host: Host,
  signal?: AbortSignal,
): Promise<boolean> {
  const [metadata, localHead, status] = await Promise.all([
    required(host.execGh, ["pr", "view", selector, "--json", "headRefOid"], host, signal),
    required(host.execGit, ["rev-parse", "HEAD"], host, signal),
    required(host.execGit, ["status", "--porcelain"], host, signal),
  ]);
  const value = JSON.parse(metadata) as { headRefOid?: unknown };
  return (
    headOid(value.headRefOid) === expectedHead &&
    localHead.trim() === expectedHead &&
    status.trim() === ""
  );
}

function headOid(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error("PR metadata did not include a valid headRefOid.");
  }
  return value;
}

function nulPaths(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean).map(safeRepositoryPath);
}

async function required(
  exec: ReviewExec,
  args: string[],
  host: Host,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const result = await exec(args, { cwd: host.cwd, signal, timeout: 10_000 });
  signal?.throwIfAborted();
  if (result.code !== 0)
    throw new Error(`Review preflight failed: ${result.stderr || result.stdout}`);
  if (Buffer.byteLength(result.stdout) > MAX_BYTES)
    throw new Error("Review command output exceeds 2 MiB; narrow the scope.");
  return result.stdout;
}
