import { join, resolve } from "node:path";
import type { CliExec } from "../../lib/cli";
import { branchDiffRange, normalizeBaseBranch } from "../../lib/git";
import { normalizePullRequestSelector } from "../../lib/github";
import { hasControlCharacter } from "../../lib/text";
import { REVIEW_FLOW_WORKFLOW_NAME } from "./review-events";
import { extensionPackagedWorkflowRoot } from "./saved/packaged";
import type { SavedWorkflow } from "./saved/resolver";

const REVIEW_FLOW_FILE_NAME = "review-flow.js";
const PREFLIGHT_TIMEOUT_MS = 10_000;

type ReviewFlowContext = {
  canonicalTargetFiles: string[];
  prMutationAuthorized?: true;
  prSelector?: string;
  authorizedHeadOid?: string;
};

export type ReviewFlowTrustedRuntimeContext = {
  reviewFlow: ReviewFlowContext;
};

export type PreparedReviewFlowLaunch = {
  args: unknown;
  trustedRuntimeContext?: ReviewFlowTrustedRuntimeContext;
};

export async function prepareReviewFlowLaunch(options: {
  workflow: SavedWorkflow | undefined;
  args: unknown;
  exec: CliExec | undefined;
  cwd: string;
  signal?: AbortSignal;
}): Promise<PreparedReviewFlowLaunch> {
  if (!isCanonicalPackagedReviewFlow(options.workflow)) return { args: options.args };

  const args = normalizeReviewFlowArgs(options.args);
  if (!isRecord(args)) return { args };
  const scope = reviewScope(args);
  if (scope.mode !== "files" && options.exec === undefined) return { args };

  const prepared = await collectCanonicalTargetFiles(scope, options);
  const reviewFlow: ReviewFlowContext = {
    canonicalTargetFiles: prepared.targetFiles,
  };
  if (scope.mode === "pr" && prepared.prHeadOid !== undefined) {
    reviewFlow.prSelector = scope.selector;
    reviewFlow.authorizedHeadOid = prepared.prHeadOid;
    if (prepared.prMutationAuthorized) reviewFlow.prMutationAuthorized = true;
  }
  return { args, trustedRuntimeContext: { reviewFlow } };
}

export async function reauthorizeReviewFlowMutation(options: {
  trustedRuntimeContext: unknown;
  exec: CliExec | undefined;
  cwd: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  try {
    const reviewFlow = reviewFlowContext(options.trustedRuntimeContext);
    if (
      reviewFlow?.prMutationAuthorized !== true ||
      typeof reviewFlow.prSelector !== "string" ||
      typeof reviewFlow.authorizedHeadOid !== "string" ||
      options.exec === undefined
    ) {
      return false;
    }
    const preflight = await pullRequestPreflight(options.exec, reviewFlow.prSelector, options);
    return (
      preflight.matches &&
      preflight.prHeadOid === reviewFlow.authorizedHeadOid &&
      preflight.localHeadOid === reviewFlow.authorizedHeadOid
    );
  } catch {
    return false;
  }
}

export function isCanonicalPackagedReviewFlow(
  workflow: SavedWorkflow | undefined,
): workflow is SavedWorkflow {
  return (
    workflow?.name === REVIEW_FLOW_WORKFLOW_NAME &&
    workflow.source === "extension" &&
    resolve(workflow.path) === resolve(join(extensionPackagedWorkflowRoot(), REVIEW_FLOW_FILE_NAME))
  );
}

function normalizeReviewFlowArgs(args: unknown): unknown {
  if (args === undefined || args === null) return {};
  if (!isRecord(args)) return args;
  const normalized = { ...args };
  if (typeof normalized.pr === "string")
    normalized.pr = normalizePullRequestSelector(normalized.pr);
  if (typeof normalized.base === "string") normalized.base = normalizeBaseBranch(normalized.base);
  return normalized;
}

type ReviewScope =
  | { mode: "files"; files: string[] }
  | { mode: "pr"; selector: string }
  | { mode: "base"; base: string }
  | { mode: "staged" }
  | { mode: "changes" };

function reviewScope(args: Record<string, unknown>): ReviewScope {
  if (Object.hasOwn(args, "files") && Array.isArray(args.files)) {
    return {
      mode: "files",
      files: args.files
        .filter((file): file is string => typeof file === "string")
        .map((file) => file.trim())
        .filter(Boolean),
    };
  }
  if (typeof args.pr === "string" && args.pr) return { mode: "pr", selector: args.pr };
  if (typeof args.base === "string" && args.base) return { mode: "base", base: args.base };
  if (args.staged === true) return { mode: "staged" };
  return { mode: "changes" };
}

async function collectCanonicalTargetFiles(
  scope: ReviewScope,
  options: { exec: CliExec | undefined; cwd: string; signal?: AbortSignal },
): Promise<{ targetFiles: string[]; prHeadOid?: string; prMutationAuthorized?: boolean }> {
  if (scope.mode === "files") return { targetFiles: unique(scope.files) };
  const exec = options.exec;
  if (exec === undefined) throw new Error("Preparing review scope requires a command executor.");

  if (scope.mode === "pr") {
    const view = await runRequired(
      exec,
      "gh",
      ["pr", "view", scope.selector, "--json", "files,headRefOid"],
      options,
      "Collecting pull request scope",
    );
    const metadata = parsePullRequestMetadata(view);
    const preflight = await pullRequestPreflight(
      exec,
      scope.selector,
      options,
      metadata.headRefOid,
    );
    return {
      targetFiles: metadata.targetFiles,
      prHeadOid: metadata.headRefOid,
      ...(preflight.matches ? { prMutationAuthorized: true } : {}),
    };
  }

  if (scope.mode === "base") {
    const output = await runRequired(
      exec,
      "git",
      ["diff", "--name-only", "-z", branchDiffRange(scope.base)],
      options,
      "Collecting branch diff targets",
    );
    return { targetFiles: parseNulPaths(output) };
  }
  if (scope.mode === "staged") {
    const output = await runRequired(
      exec,
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      options,
      "Collecting staged targets",
    );
    return { targetFiles: parseNulPaths(output) };
  }

  const [unstaged, staged, untracked] = await Promise.all([
    runRequired(exec, "git", ["diff", "--name-only", "-z"], options, "Collecting changed targets"),
    runRequired(
      exec,
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      options,
      "Collecting staged targets",
    ),
    runRequired(
      exec,
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      options,
      "Collecting untracked targets",
    ),
  ]);
  return {
    targetFiles: unique([
      ...parseNulPaths(unstaged),
      ...parseNulPaths(staged),
      ...parseNulPaths(untracked),
    ]),
  };
}

async function pullRequestPreflight(
  exec: CliExec,
  selector: string,
  options: { cwd: string; signal?: AbortSignal },
  knownPrHeadOid?: string,
): Promise<{ matches: boolean; prHeadOid: string; localHeadOid: string }> {
  const prHeadPromise =
    knownPrHeadOid === undefined
      ? runRequired(
          exec,
          "gh",
          ["pr", "view", selector, "--json", "headRefOid"],
          options,
          "Collecting pull request head",
        ).then(parseHeadRefOid)
      : Promise.resolve(knownPrHeadOid);
  const [prHeadOid, localHeadOutput, status] = await Promise.all([
    prHeadPromise,
    runRequired(exec, "git", ["rev-parse", "HEAD"], options, "Collecting local HEAD"),
    runRequired(exec, "git", ["status", "--porcelain"], options, "Collecting working tree status"),
  ]);
  const localHeadOid = localHeadOutput.trim();
  return {
    matches: localHeadOid === prHeadOid && status.trim() === "",
    prHeadOid,
    localHeadOid,
  };
}

async function runRequired(
  exec: CliExec,
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
  label: string,
): Promise<string> {
  const result = await exec(command, args, {
    cwd: options.cwd,
    signal: options.signal,
    timeout: PREFLIGHT_TIMEOUT_MS,
  });
  if (result.code !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function parsePullRequestMetadata(stdout: string): { targetFiles: string[]; headRefOid: string } {
  const value = JSON.parse(stdout) as unknown;
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error("Pull request metadata did not include files.");
  }
  const targetFiles = value.files.map((file, index) => {
    if (!isRecord(file) || typeof file.path !== "string" || !isSafeRepositoryPath(file.path)) {
      throw new Error(`Pull request file ${index} did not include a safe repository path.`);
    }
    return file.path;
  });
  if (typeof value.headRefOid !== "string" || !value.headRefOid.trim()) {
    throw new Error("Pull request metadata did not include headRefOid.");
  }
  return { targetFiles: unique(targetFiles), headRefOid: value.headRefOid.trim() };
}

function isSafeRepositoryPath(path: string): boolean {
  return (
    path.trim() === path &&
    path !== "" &&
    !path.startsWith("/") &&
    !path.startsWith("~") &&
    !hasControlCharacter(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function parseHeadRefOid(stdout: string): string {
  const value = JSON.parse(stdout) as unknown;
  if (!isRecord(value) || typeof value.headRefOid !== "string" || !value.headRefOid.trim()) {
    throw new Error("Pull request metadata did not include headRefOid.");
  }
  return value.headRefOid.trim();
}

function parseNulPaths(stdout: string): string[] {
  return unique(stdout.split("\0").filter(Boolean));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function reviewFlowContext(value: unknown): ReviewFlowContext | undefined {
  if (!isRecord(value) || !isRecord(value.reviewFlow)) return undefined;
  return value.reviewFlow as ReviewFlowContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
