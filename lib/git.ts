export type TargetSource = "diff" | "explicit" | "recent";

export type Target = {
  path: string;
  oldPath?: string;
  status: string;
  source: TargetSource;
};

export type GitResult = { code: number; stdout: string; stderr: string };
export type ExecGit = (args: string[]) => Promise<GitResult>;

export type CollectChangedTargetsOptions = {
  files: string[];
  staged: boolean;
  base?: string;
  preserveOldPath?: boolean;
};

export function normalizeFileArg(file: string): string {
  return file.replace(/^@/, "");
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} chars; inspect files directly before editing]`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function readablePathGitArgs(args: string[]): string[] {
  return ["-c", "core.quotepath=false", ...args];
}

function hasWhitespaceOrControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return char.trim() === "" || code < 32 || code === 127;
  });
}

export function normalizeBaseBranch(base: string | undefined): string | undefined {
  const trimmed = base?.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("-") ||
    trimmed.startsWith("@") ||
    hasWhitespaceOrControl(trimmed) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    trimmed.includes("@{") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith(".lock")
  ) {
    throw new Error(
      "Invalid base branch. Use a branch/ref name such as main or origin/main; whitespace, control characters, leading '-'/'@', and revision syntax are not allowed.",
    );
  }
  return trimmed;
}

export function branchDiffRange(base: string): string {
  return `${base}...HEAD`;
}

export function formatGitFailure(context: string, result: GitResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return `${context} failed with exit code ${result.code}${output ? `: ${truncate(output, 1000)}` : ""}`;
}

export function parseNameStatus(
  stdout: string,
  source: TargetSource,
  options: { preserveOldPath?: boolean } = {},
): Target[] {
  const targets: Target[] = [];
  const fields = stdout.split("\0").filter(Boolean);

  for (let index = 0; index < fields.length; ) {
    const status = fields[index++] ?? "modified";
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index++];
      const path = fields[index++];
      if (path) {
        targets.push({
          path,
          ...(options.preserveOldPath && oldPath ? { oldPath } : {}),
          status,
          source,
        });
      }
      continue;
    }

    const path = fields[index++];
    if (path) targets.push({ path, status, source });
  }

  return targets;
}

export function uniqueTargets(targets: Target[]): Target[] {
  const seen = new Set<string>();
  const result: Target[] = [];

  for (const target of targets) {
    if (seen.has(target.path)) continue;
    seen.add(target.path);
    result.push(target);
  }

  return result;
}

export function isExplicitFileMode(targets: Target[]): boolean {
  return targets.length > 0 && targets.every((target) => target.source === "explicit");
}

function formatDetails(target: Target): string {
  return target.status === target.source ? target.status : `${target.status}; ${target.source}`;
}

export function formatPathForPrompt(path: string): string {
  return JSON.stringify(path);
}

export function formatJsonTarget(target: Target): string {
  const path = target.oldPath
    ? `${formatPathForPrompt(target.oldPath)} -> ${formatPathForPrompt(target.path)}`
    : formatPathForPrompt(target.path);
  return `- ${path} (${formatDetails(target)})`;
}

export function formatPlainTarget(target: Target): string {
  return `- ${target.path} (${formatDetails(target)})`;
}

export function targetPathsForDiff(targets: Target[]): string[] {
  return [
    ...new Set(
      targets
        .filter((target) => target.status !== "untracked")
        .flatMap((target) => (target.oldPath ? [target.oldPath, target.path] : [target.path])),
    ),
  ];
}

export async function collectChangedTargets(
  execGit: ExecGit,
  options: CollectChangedTargetsOptions,
): Promise<Target[]> {
  if (options.files.length > 0) {
    return options.files.map((path) => ({
      path: normalizeFileArg(path),
      status: "explicit",
      source: "explicit" as const,
    }));
  }

  const targets: Target[] = [];
  const parseOptions = { preserveOldPath: options.preserveOldPath ?? false };

  if (options.base) {
    const branch = await execGit(["diff", "--name-status", "-z", branchDiffRange(options.base)]);
    if (branch.code !== 0) {
      throw new Error(
        formatGitFailure(
          `Collecting branch diff targets for ${branchDiffRange(options.base)}`,
          branch,
        ),
      );
    }
    targets.push(...parseNameStatus(branch.stdout, "diff", parseOptions));
  } else if (options.staged) {
    const staged = await execGit(["diff", "--cached", "--name-status", "-z"]);
    if (staged.code === 0) targets.push(...parseNameStatus(staged.stdout, "diff", parseOptions));
  } else {
    const [unstaged, staged, untracked] = await Promise.all([
      execGit(["diff", "--name-status", "-z"]),
      execGit(["diff", "--cached", "--name-status", "-z"]),
      execGit(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);

    if (unstaged.code === 0)
      targets.push(...parseNameStatus(unstaged.stdout, "diff", parseOptions));
    if (staged.code === 0) targets.push(...parseNameStatus(staged.stdout, "diff", parseOptions));

    if (untracked.code === 0) {
      for (const path of untracked.stdout.split("\0").filter(Boolean)) {
        targets.push({ path, status: "untracked", source: "diff" });
      }
    }
  }

  return uniqueTargets(targets);
}
