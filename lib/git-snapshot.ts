import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_MS = 5_000;

export type GitSnapshotEntry = {
  label: string;
  args: string[];
  transform?: (output: string) => string;
};

export type BuildGitSnapshotOptions = {
  timeoutMs?: number;
};

export async function buildGitSnapshot(
  pi: ExtensionAPI,
  entries: GitSnapshotEntry[],
  options: BuildGitSnapshotOptions = {},
): Promise<string[]> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Promise.all(
    entries.map(async ({ label, args, transform }) => {
      const result = await pi.exec("git", args, { timeout }).catch((error: unknown) => ({
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
      const raw = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      const processed = transform ? transform(raw) : raw;
      return `### ${label}\n${processed || "(empty)"}`;
    }),
  );
}
