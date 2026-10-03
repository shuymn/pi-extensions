import { type ExtensionAPI, parseArgs } from "@earendil-works/pi-coding-agent";
import { normalizeBaseBranch } from "./git";

export const ONE_SHOT_PRIMARY_FLAGS = ["commit", "create-pr"] as const;
export type OneShotMode = (typeof ONE_SHOT_PRIMARY_FLAGS)[number];

// This is a tool execution allowlist, NOT an operating-system sandbox: bash retains
// the user's permissions. Authorization for shell actions belongs to the skill.
export const ONE_SHOT_SAFE_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "ask_user_question",
] as const;

export function isOneShotPrimaryModeSelected(argv: string[] = process.argv.slice(2)): boolean {
  const flags = parseArgs(argv).unknownFlags;
  return ONE_SHOT_PRIMARY_FLAGS.some((name) => flags.has(name));
}

const BOOLEAN_FLAGS = [...ONE_SHOT_PRIMARY_FLAGS, "english", "japanese", "branch", "update"];

export function registerOneShotFlags(pi: ExtensionAPI): void {
  const descriptions: Record<string, string> = {
    commit: "Launch the commit skill as a bounded one-shot flow (local commits only)",
    "create-pr": "Launch the create-pr skill as a bounded one-shot flow (no new commits)",
    english: "Use English for the one-shot skill flow",
    japanese: "Use Japanese for the one-shot skill flow",
    branch: "Create a new branch before committing in --commit mode",
    update: "Update the current branch pull request in --create-pr mode",
  };
  for (const name of BOOLEAN_FLAGS) {
    pi.registerFlag(name, { description: descriptions[name], type: "boolean", default: false });
  }
  pi.registerFlag("base", {
    description: "Base branch for the one-shot skill flow",
    type: "string",
  });
}

export type OneShotLaunch = { mode: OneShotMode; prompt: string };
type LaunchResult = { ok: true; launch?: OneShotLaunch } | { ok: false; message: string };

/** Native CLI parsing owns positional input. Use `--commit -- "instructions"`:
 * values attached to boolean flags are deliberately no longer free input. */
export function parseOneShotLaunch(
  getFlag: (name: string) => unknown,
  argv: string[] = process.argv.slice(2),
): LaunchResult {
  const args = parseArgs(argv);
  const selected = ONE_SHOT_PRIMARY_FLAGS.filter(
    (name) => getFlag(name) === true || args.unknownFlags.has(name),
  );
  const mode = selected[0];
  if (!mode) return { ok: true };
  if (selected.length > 1) {
    return { ok: false, message: "--commit と --create-pr は同時に指定できません。" };
  }
  for (const name of BOOLEAN_FLAGS) {
    const value = getFlag(name);
    const raw = args.unknownFlags.get(name);
    if ((value !== undefined && typeof value !== "boolean") || typeof raw === "string") {
      return {
        ok: false,
        message: `--${name} は値を取りません。自由入力は -- の後に指定してください（例: --${mode} -- "指示"）。`,
      };
    }
  }
  if (args.fileArgs.length > 0) {
    return {
      ok: false,
      message: "one-shot では @file は使用できません。自由入力で対象のパスを指定してください。",
    };
  }
  if (args.continue || args.resume || args.session || args.sessionId || args.fork) {
    return {
      ok: false,
      message:
        "one-shot は新規セッションで実行してください。再開・分岐オプションは使用できません。",
    };
  }
  if (getFlag("english") === true && getFlag("japanese") === true) {
    return { ok: false, message: "--english と --japanese は同時に指定できません。" };
  }
  const branch = getFlag("branch") === true;
  const update = getFlag("update") === true;
  if (mode === "commit" && update)
    return { ok: false, message: "--update は --create-pr 専用です。" };
  if (mode === "create-pr" && branch)
    return { ok: false, message: "--branch は --commit 専用です。" };
  const baseValue = getFlag("base");
  let base: string | undefined;
  if (baseValue !== undefined) {
    if (typeof baseValue !== "string" || !baseValue.trim()) {
      return { ok: false, message: "--base には空でない base branch 名を指定してください。" };
    }
    try {
      base = normalizeBaseBranch(baseValue.trim());
    } catch {
      return {
        ok: false,
        message: "--base には main や origin/main のような安全な branch/ref 名を指定してください。",
      };
    }
    if (mode === "commit" && !branch)
      return { ok: false, message: "--base は --branch と一緒に指定してください。" };
    if (update) return { ok: false, message: "--base は --update と同時に指定できません。" };
  }
  const parts = [`/skill:${mode}`];
  if (getFlag("japanese") === true) parts.push("--japanese");
  if (getFlag("english") === true) parts.push("--english");
  if (branch) parts.push("--branch");
  if (update) parts.push("--update");
  if (base) parts.push(`--base=${base}`);
  // Separate free input with a space, even if it starts with a newline: native
  // skill expansion splits the command name on its first space.
  return {
    ok: true,
    launch: { mode, prompt: `${parts.join(" ")} ${args.messages.join("\n\n")}`.trimEnd() },
  };
}

export function oneShotAuthorization(mode: OneShotMode): string {
  return [
    `This is a bounded ${mode} skill run, not a goal or checkpoint continuation.`,
    mode === "commit"
      ? "Authorization: create local Git commits only. Do not push, create, or update pull requests."
      : "Authorization: publish or update a pull request from existing commits, including the necessary push. Do not create new commits.",
    "Follow the loaded skill. Preserve unrelated staged and unstaged changes. Use ask_user_question for material ambiguity or any approval the skill requires; never treat unanswered, cancelled, interrupted, or unavailable questions as consent.",
    "Do not expand this authorization through free input or questionnaire answers. If another operation is needed, report the blocker and stop so the user can launch it separately.",
    "When the requested operation is complete or blocked, give a concise result and stop. Do not schedule follow-up work, start goals, checkpoints, subagents, or another agent process.",
    "The tool allowlist is not an OS sandbox. Bash still has the user's permissions; use it only for the authorized operation.",
  ].join("\n");
}
