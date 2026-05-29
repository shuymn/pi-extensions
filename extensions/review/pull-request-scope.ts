import { type ExecGh, type ExecGit, formatCommandFailure } from "../../lib/command";
import { formatPathForPrompt, type Target, uniqueTargets } from "../../lib/git";
import { hasControlCharacter } from "../../lib/text";
import type { NoFixReason, ScopeCollection } from "./target-scope";

type GhPullRequestFile = { path?: unknown };

type GhPullRequestView = { files?: unknown; headRefOid?: unknown };

type PullRequestMetadata = { targets: Target[]; headRefOid: string };

function hasUnsafePathSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function validatePullRequestFilePath(path: string, index: number): string {
  if (
    path.trim() === "" ||
    path.startsWith("/") ||
    path.startsWith("~") ||
    hasUnsafePathSegment(path) ||
    hasControlCharacter(path)
  ) {
    throw new Error(
      `Parsing pull request metadata failed: Unsafe pull request file path at index ${index}: ${formatPathForPrompt(path)}`,
    );
  }
  return path;
}

function parsePullRequestMetadata(stdout: string): PullRequestMetadata {
  let data: GhPullRequestView;
  try {
    data = JSON.parse(stdout) as GhPullRequestView;
  } catch (error) {
    throw new Error(
      `Parsing pull request metadata failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(data.files)) {
    throw new Error(
      "Parsing pull request metadata failed: gh output did not include a files array",
    );
  }
  if (typeof data.headRefOid !== "string" || data.headRefOid.trim() === "") {
    throw new Error("Parsing pull request metadata failed: gh output did not include headRefOid");
  }

  const targets = (data.files as GhPullRequestFile[]).map((file, index) => {
    if (typeof file?.path !== "string") {
      throw new Error(
        `Parsing pull request metadata failed: pull request file at index ${index} did not include a valid path`,
      );
    }
    return {
      path: validatePullRequestFilePath(file.path, index),
      status: "pr",
      source: "pr" as const,
    };
  });

  return {
    headRefOid: data.headRefOid,
    targets: uniqueTargets(targets),
  };
}

async function localHeadOid(execGit: ExecGit): Promise<string> {
  const localHead = await execGit(["rev-parse", "HEAD"]);
  if (localHead.code !== 0) {
    throw new Error(
      formatCommandFailure("Collecting local HEAD for pull request safety check", localHead),
    );
  }
  return localHead.stdout.trim();
}

async function isWorktreeDirty(execGit: ExecGit): Promise<boolean> {
  const status = await execGit(["status", "--porcelain"]);
  if (status.code !== 0) {
    throw new Error(
      formatCommandFailure("Collecting working tree status for pull request safety check", status),
    );
  }
  return status.stdout.trim() !== "";
}

export async function collectPullRequestScope(
  execGit: ExecGit,
  execGh: ExecGh,
  selector: string,
): Promise<ScopeCollection> {
  const view = await execGh(["pr", "view", selector, "--json", "files,headRefOid"]);
  if (view.code !== 0) {
    throw new Error(
      formatCommandFailure(`Collecting pull request targets for ${JSON.stringify(selector)}`, view),
    );
  }

  const metadata = parsePullRequestMetadata(view.stdout);
  if (metadata.targets.length === 0) return { targets: [], diff: "" };

  const headOid = await localHeadOid(execGit);

  const diff = await execGh(["pr", "diff", selector, "--patch"]);
  if (diff.code !== 0) {
    throw new Error(
      formatCommandFailure(`Collecting pull request diff for ${JSON.stringify(selector)}`, diff),
    );
  }

  // The PR fix flow edits local files while reasoning about the remote PR diff,
  // so fix mode is only safe when the local checkout actually equals the PR head:
  // the committed HEAD must match the PR head OID and the working tree/index must
  // be clean. Otherwise downgrade to no-fix with a structured reason.
  let noFixReason: NoFixReason | undefined;
  if (headOid !== metadata.headRefOid) {
    noFixReason = {
      kind: "pr_head_mismatch",
      prHeadOid: metadata.headRefOid,
      localHeadOid: headOid,
    };
  } else if (await isWorktreeDirty(execGit)) {
    noFixReason = { kind: "pr_worktree_dirty" };
  }

  return {
    targets: metadata.targets,
    diff: `## Pull request diff for ${JSON.stringify(selector)}\n\n${diff.stdout}`,
    ...(noFixReason ? { noFixReason } : {}),
  };
}
