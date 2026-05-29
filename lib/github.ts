import { hasWhitespaceOrControl } from "./text";

export function normalizePullRequestSelector(selector: string | undefined): string | undefined {
  const trimmed = selector?.trim();
  if (!trimmed) return undefined;

  const isNumber = /^\d+$/.test(trimmed);
  const crossRepoNumberMatch = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(trimmed);
  const isGithubPullUrl =
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+\/?$/.test(trimmed);

  if (
    trimmed.startsWith("-") ||
    trimmed.startsWith("@") ||
    hasWhitespaceOrControl(trimmed) ||
    trimmed.includes("@{") ||
    !(isNumber || crossRepoNumberMatch || isGithubPullUrl)
  ) {
    throw new Error(
      "Invalid pull request selector. Use a PR number, owner/repo#number, or https://github.com/owner/repo/pull/number URL.",
    );
  }

  if (crossRepoNumberMatch) {
    const [, repository, number] = crossRepoNumberMatch;
    return `https://github.com/${repository}/pull/${number}`;
  }

  return trimmed;
}
