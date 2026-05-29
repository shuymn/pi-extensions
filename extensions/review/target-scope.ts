import { lstat, open, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, ExecGh, ExecGit } from "../../lib/command";
import { formatCommandFailure } from "../../lib/command";
import {
  branchDiffRange,
  collectChangedTargets,
  formatPathForPrompt,
  isExplicitFileMode,
  readablePathGitArgs,
  type Target,
  targetPathsForDiff,
} from "../../lib/git";
import { truncate } from "../../lib/text";
import { collectPullRequestScope } from "./pull-request-scope";

const REVIEW_MAX_DIFF_CHARS = 80_000;
const REVIEW_MAX_UNTRACKED_FILE_CHARS = 20_000;

export type ReviewScope =
  | { kind: "explicit"; files: string[] }
  | { kind: "pr"; selector: string }
  | { kind: "base"; base: string }
  | { kind: "staged" }
  | { kind: "workingTree" };

export type NoFixReason =
  | { kind: "pr_head_mismatch"; prHeadOid: string; localHeadOid: string }
  | { kind: "pr_worktree_dirty" };

export type PrepareTargetScopeOptions = {
  execGit: ExecGit;
  execGh?: ExecGh;
  cwd: string;
  files: string[];
  staged: boolean;
  base?: string;
  pr?: string;
};

export type ScopeCollection = {
  targets: Target[];
  diff: string;
  noFixReason?: NoFixReason;
};

export type PreparedTargetScope = ScopeCollection & {
  scope: ReviewScope;
};

export function reviewScopeFromOptions(
  options: Pick<PrepareTargetScopeOptions, "files" | "staged" | "base" | "pr">,
): ReviewScope {
  if (options.files.length > 0) return { kind: "explicit", files: options.files };
  if (options.pr) return { kind: "pr", selector: options.pr };
  if (options.base) return { kind: "base", base: options.base };
  if (options.staged) return { kind: "staged" };
  return { kind: "workingTree" };
}

async function readTextPrefix(path: string, maxChars: number): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxChars + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return bytesRead > maxChars ? truncate(text, maxChars) : text;
  } finally {
    await file.close();
  }
}

async function collectUntrackedFileChunk(cwd: string, target: Target): Promise<string | undefined> {
  if (target.status !== "untracked") return undefined;

  const heading = `## Untracked file: ${formatPathForPrompt(target.path)}`;
  try {
    const absolutePath = join(cwd, target.path);
    const info = await lstat(absolutePath);

    if (info.isSymbolicLink()) {
      const linkTarget = await readlink(absolutePath);
      return `${heading}\n\n[Skipped symlink -> ${formatPathForPrompt(linkTarget)}]`;
    }

    const content =
      info.size > REVIEW_MAX_UNTRACKED_FILE_CHARS
        ? await readTextPrefix(absolutePath, REVIEW_MAX_UNTRACKED_FILE_CHARS)
        : await readFile(absolutePath, "utf8");
    if (content.includes("\0")) {
      return `${heading}\n\n[Skipped binary-looking file content]`;
    }

    return `${heading}\n\n${truncate(content, REVIEW_MAX_UNTRACKED_FILE_CHARS)}`;
  } catch (error) {
    return `${heading}\n\n[Could not read file: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function addDiffChunk(chunks: string[], label: string, result: CommandResult): void {
  if (result.code === 0 && result.stdout.trim()) chunks.push(`## ${label}\n\n${result.stdout}`);
}

function addRequiredDiffChunk(chunks: string[], label: string, result: CommandResult): void {
  if (result.code !== 0) throw new Error(formatCommandFailure(`Collecting ${label}`, result));
  addDiffChunk(chunks, label, result);
}

async function collectReviewDiff(
  execGit: ExecGit,
  cwd: string,
  staged: boolean,
  base: string | undefined,
  targets: Target[],
): Promise<string> {
  if (isExplicitFileMode(targets)) return "";

  const chunks: string[] = [];
  const trackedPaths = targetPathsForDiff(targets);

  if (trackedPaths.length > 0) {
    if (base) {
      addRequiredDiffChunk(
        chunks,
        `Diff against ${JSON.stringify(base)}`,
        await execGit(readablePathGitArgs(["diff", branchDiffRange(base), "--", ...trackedPaths])),
      );
    } else if (staged) {
      addDiffChunk(
        chunks,
        "Staged diff",
        await execGit(readablePathGitArgs(["diff", "--cached", "--", ...trackedPaths])),
      );
    } else {
      addDiffChunk(
        chunks,
        "Combined diff against HEAD",
        await execGit(readablePathGitArgs(["diff", "HEAD", "--", ...trackedPaths])),
      );
    }
  }

  const untrackedChunks = await Promise.all(
    targets
      .filter((target) => target.status === "untracked")
      .map((target) => collectUntrackedFileChunk(cwd, target)),
  );
  chunks.push(...untrackedChunks.filter((chunk): chunk is string => Boolean(chunk)));

  return truncate(chunks.join("\n\n"), REVIEW_MAX_DIFF_CHARS);
}

export async function prepareTargetScope(
  options: PrepareTargetScopeOptions,
): Promise<PreparedTargetScope> {
  const scope = reviewScopeFromOptions(options);

  if (scope.kind === "pr") {
    if (!options.execGh) throw new Error("Preparing pull request scope requires a gh executor");
    const collected = await collectPullRequestScope(
      options.execGit,
      options.execGh,
      scope.selector,
    );
    return {
      scope,
      targets: collected.targets,
      diff: collected.diff ? truncate(collected.diff, REVIEW_MAX_DIFF_CHARS) : collected.diff,
      ...(collected.noFixReason ? { noFixReason: collected.noFixReason } : {}),
    };
  }

  const collectOptions = {
    files: scope.kind === "explicit" ? scope.files : [],
    staged: scope.kind === "staged",
    base: scope.kind === "base" ? scope.base : undefined,
    preserveOldPath: true,
  };
  const targets = await collectChangedTargets(options.execGit, collectOptions);
  return {
    scope,
    targets,
    diff: await collectReviewDiff(
      options.execGit,
      options.cwd,
      collectOptions.staged,
      collectOptions.base,
      targets,
    ),
  };
}
