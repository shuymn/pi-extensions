import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

const QUICK_TIMEOUT_MS = 3_000;
const LIST_TIMEOUT_MS = 5_000;

export async function getDefaultBranch(pi: ExtensionAPI): Promise<string | undefined> {
  const symbolic = await pi
    .exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      timeout: QUICK_TIMEOUT_MS,
    })
    .catch(() => undefined);
  if (symbolic?.code === 0) return symbolic.stdout.trim().replace(/^origin\//, "") || undefined;

  for (const candidate of ["main", "master"]) {
    const exists = await pi
      .exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], {
        timeout: QUICK_TIMEOUT_MS,
      })
      .catch(() => undefined);
    if (exists?.code === 0) return candidate;
  }

  return undefined;
}

export async function getCurrentBranch(pi: ExtensionAPI): Promise<string | undefined> {
  const result = await pi
    .exec("git", ["branch", "--show-current"], { timeout: QUICK_TIMEOUT_MS })
    .catch(() => undefined);
  if (result?.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

export type ListBranchesOptions = {
  currentBranch?: string;
  defaultBranch?: string;
};

export async function listBranches(
  pi: ExtensionAPI,
  options: ListBranchesOptions = {},
): Promise<SelectItem[]> {
  const { currentBranch, defaultBranch } = options;
  const result = await pi
    .exec(
      "git",
      ["for-each-ref", "--format=%(refname)%09%(refname:short)", "refs/heads", "refs/remotes"],
      { timeout: LIST_TIMEOUT_MS },
    )
    .catch(() => undefined);

  const seen = new Set<string>();
  const branches = (result?.stdout ?? "")
    .split("\n")
    .map((line) => {
      const [refname, shortName] = line.trim().split("\t");
      return { refname, shortName };
    })
    .filter(({ refname, shortName }) => refname && shortName)
    .filter(({ refname }) => !refname.endsWith("/HEAD"))
    .map(({ shortName }) => shortName.replace(/^origin\//, ""))
    .filter((branch) => branch !== "origin")
    .filter((branch) => {
      if (seen.has(branch)) return false;
      seen.add(branch);
      return true;
    });

  const sorted = branches.sort((a, b) => {
    if (a === currentBranch) return -1;
    if (b === currentBranch) return 1;
    if (a === defaultBranch) return -1;
    if (b === defaultBranch) return 1;
    return a.localeCompare(b);
  });

  return sorted.map((branch) => ({
    value: branch,
    label: branch,
    description:
      branch === currentBranch
        ? "現在のブランチ"
        : branch === defaultBranch
          ? "デフォルトブランチ"
          : undefined,
  }));
}
