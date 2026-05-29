import { truncate } from "./text";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type ExecCommand = (args: string[]) => Promise<CommandResult>;
export type ExecGit = ExecCommand;
export type ExecGh = ExecCommand;

export function formatCommandFailure(context: string, result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
  return `${context} failed with exit code ${result.code}${output ? `: ${truncate(output, 1000)}` : ""}`;
}
