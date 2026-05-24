import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classifyShellCommand } from "./shell-safety";
import { reviewWorkflowShellCommand, type WorkflowShellReviewer } from "./workflow-shell-reviewer";

export type { WorkflowShellReviewer } from "./workflow-shell-reviewer";

export const WORKFLOW_TEMP_FILE_TOOL_NAME = "workflow_write_temp_file";

const BASE_WORKFLOW_ACTIVE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "spawn_subagent",
] as const;

const WORKFLOW_ACTIVE_TOOLS = [...BASE_WORKFLOW_ACTIVE_TOOLS, WORKFLOW_TEMP_FILE_TOOL_NAME];

const CREATE_PR_EXTRA_ACTIVE_TOOLS = ["ask_user_question"] as const;
const COMMIT_WORKFLOW_ACTIVE_TOOL_SET = new Set<string>(WORKFLOW_ACTIVE_TOOLS);
const CREATE_PR_WORKFLOW_ACTIVE_TOOL_SET = new Set<string>([
  ...WORKFLOW_ACTIVE_TOOLS,
  ...CREATE_PR_EXTRA_ACTIVE_TOOLS,
]);

export type ToolPolicyWorkflowName = "commit" | "create-pr";

export type ToolCallGateResult = { block: true; reason: string } | undefined;

export type WorkflowToolPolicyState = {
  reviewerDenials: Partial<Record<ToolPolicyWorkflowName, number>>;
};

export type WorkflowToolPolicyOptions = {
  ctx?: Pick<ExtensionContext, "cwd" | "modelRegistry" | "signal">;
  reviewer?: WorkflowShellReviewer;
  state?: WorkflowToolPolicyState;
};

type TempFileToolDetails = { ok: boolean; path?: string };

const DESTRUCTIVE_GIT_PATTERNS = [
  /(^|[;&|]\s*)git\s+restore\b/,
  /(^|[;&|]\s*)git\s+reset\b/,
  /(^|[;&|]\s*)git\s+checkout\s+(?:--|-f\b)/,
  /(^|[;&|]\s*)git\s+switch\b[^\n;|&]*\s--discard-changes\b/,
  /(^|[;&|]\s*)git\s+clean\b/,
];

const CREATE_PR_ALLOWED_READ_PATTERNS = [
  /(^|&&|\|\|)\s*gh\s+pr\s+view\b[^;&|<>]*/g,
  /(^|&&|\|\|)\s*git\s+(?:branch|symbolic-ref|rev-list)\b[^;&|<>]*/g,
];

const COMMIT_DENIED_OPTIONS = new Set(["--amend", "--no-verify", "--all", "--allow-empty", "-a"]);

const GIT_ADD_DENIED_ARGS = new Set([".", "-A", "--all", "-u", "--update"]);

const GIT_PUSH_DENIED_OPTIONS = new Set([
  "--all",
  "--delete",
  "--force",
  "--force-with-lease",
  "--mirror",
  "--tags",
]);

const GH_PR_CREATE_ALLOWED_OPTIONS = new Set(["--base", "--body-file", "--head", "--title"]);

const GH_PR_EDIT_ALLOWED_OPTIONS = new Set(["--body-file", "--title"]);

const GH_PR_REQUIRED_BODY_OPTIONS = new Set(["--body-file", "--title"]);

const REVIEWER_DENIAL_LIMIT = 3;
const REVIEWER_DENIAL_GUIDANCE =
  "Do not try to work around this denial, indirectly execute the same action, or bypass the workflow policy. Use a safer alternative or ask the user how to proceed.";

export function createWorkflowToolPolicyState(): WorkflowToolPolicyState {
  return { reviewerDenials: {} };
}

export function resetWorkflowToolPolicyState(state: WorkflowToolPolicyState): void {
  state.reviewerDenials = {};
}

export function getWorkflowActiveTools(workflow: ToolPolicyWorkflowName): string[] {
  if (workflow === "create-pr") return [...WORKFLOW_ACTIVE_TOOLS, ...CREATE_PR_EXTRA_ACTIVE_TOOLS];
  return [...WORKFLOW_ACTIVE_TOOLS];
}

export function applyWorkflowActiveTools(pi: ExtensionAPI, workflow: ToolPolicyWorkflowName): void {
  pi.setActiveTools(getWorkflowActiveTools(workflow));
}

export function registerWorkflowTempFileTool(
  pi: ExtensionAPI,
  workflow: ToolPolicyWorkflowName,
): void {
  pi.registerTool({
    name: WORKFLOW_TEMP_FILE_TOOL_NAME,
    label: "Write temp file",
    description:
      "Write generated workflow helper content to a new file under the OS temp directory. This never writes inside the workspace.",
    promptSnippet: buildWorkflowTempFilePromptSnippet(workflow),
    parameters: Type.Object({
      filename: Type.String({
        description: "Basename for the temp file. Directory separators are rejected.",
      }),
      content: Type.String({ description: "Full file content to write." }),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<TempFileToolDetails>> {
      const filename = params.filename.trim();
      if (!filename || filename.includes("/") || filename.includes("\\")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid filename: provide a basename without directory separators.",
            },
          ],
          details: { ok: false },
        };
      }

      const directory = await mkdtemp(join(tmpdir(), "pi-workflow-"));
      const path = join(directory, filename);
      await writeFile(path, params.content, "utf8");
      return {
        content: [{ type: "text" as const, text: `Wrote temp file: ${path}` }],
        details: { ok: true, path },
      };
    },
  });
}

function buildWorkflowTempFilePromptSnippet(workflow: ToolPolicyWorkflowName): string {
  if (workflow === "commit") {
    return `Use ${WORKFLOW_TEMP_FILE_TOOL_NAME} only during the commit workflow, and only as a last resort for a git-apply-compatible partial-staging patch when a mixed file cannot be staged as a whole. Do not use it for workspace edits, whole-file staging, tests, lint, or repeated patch retries.`;
  }

  return `Use ${WORKFLOW_TEMP_FILE_TOOL_NAME} only during the create-pr workflow, and only for the final PR body file passed to gh pr create/edit --body-file. Do not use it for patches, workspace edits, tests, lint, or intermediate drafts.`;
}

export async function evaluateWorkflowToolCall(
  workflow: ToolPolicyWorkflowName,
  event: { toolName?: string; input?: unknown },
  options: WorkflowToolPolicyOptions = {},
): Promise<ToolCallGateResult> {
  const toolName = event.toolName;
  if (!toolName) return block(workflow, "tool name is missing.");

  if (!isWorkflowActiveTool(workflow, toolName)) {
    return block(workflow, `${toolName} is not allowed in this workflow.`);
  }

  if (toolName === "spawn_subagent") {
    if (event.input && typeof event.input === "object") {
      (event.input as { readOnly?: boolean }).readOnly = true;
    }
    return undefined;
  }

  if (toolName !== "bash") return undefined;

  const command = extractShellCommand(event.input);
  if (!command) return block(workflow, "shell command input is missing.");
  if (/[\r\n]/.test(command)) {
    return block(workflow, "shell command newlines are not allowed.");
  }

  for (const pattern of DESTRUCTIVE_GIT_PATTERNS) {
    if (pattern.test(command)) {
      return block(
        workflow,
        "destructive git cleanup/reset commands are not allowed. Ask the user for explicit instructions instead.",
      );
    }
  }

  const workflowCommand = classifyWorkflowCommandChain(workflow, command);
  if (workflowCommand === "deny") {
    return block(workflow, "shell command is not allowed by this workflow's side-effect policy.");
  }
  if (workflowCommand === "allow") return undefined;

  const readonly = classifyShellCommand(command, { restrictionContext: `/${workflow} workflow` });
  if (readonly.decision === "allow") return undefined;

  if (isAllowedWorkflowReadCommand(workflow, command)) return undefined;

  if (readonly.decision === "deny") {
    return block(workflow, `shell command is not allowed: ${readonly.rationale}`);
  }

  return evaluateUnknownShellCommand(workflow, command, readonly.rationale, options);
}

async function evaluateUnknownShellCommand(
  workflow: ToolPolicyWorkflowName,
  command: string,
  staticRationale: string,
  options: WorkflowToolPolicyOptions,
): Promise<ToolCallGateResult> {
  const denialCount = options.state?.reviewerDenials[workflow] ?? 0;
  if (denialCount >= REVIEWER_DENIAL_LIMIT) {
    return block(
      workflow,
      `shell command is not allowed: repeated automatic shell command review denials. Ask the user for explicit instructions before trying another ambiguous shell command. ${REVIEWER_DENIAL_GUIDANCE}`,
    );
  }

  const reviewer = options.reviewer ?? (options.ctx ? reviewWorkflowShellCommand : undefined);
  if (!reviewer) {
    return block(
      workflow,
      `shell command is not allowed: automatic shell command review is unavailable. Static classifier rationale: ${staticRationale}`,
    );
  }

  let review: Awaited<ReturnType<WorkflowShellReviewer>>;
  try {
    review = await reviewer({
      workflow,
      command,
      cwd: options.ctx?.cwd,
      staticDecision: "unknown",
      staticRationale,
      ctx: options.ctx,
    });
  } catch (error) {
    return block(
      workflow,
      `shell command is not allowed: automatic shell command review failed: ${errorMessage(error)}`,
    );
  }

  if (review.status === "allow") {
    if (options.state) options.state.reviewerDenials[workflow] = 0;
    return undefined;
  }

  if (review.status === "deny") {
    if (options.state) options.state.reviewerDenials[workflow] = denialCount + 1;
    return block(
      workflow,
      `shell command is not allowed: automatic shell command review denied this command: ${review.rationale}. ${REVIEWER_DENIAL_GUIDANCE}`,
    );
  }

  return block(workflow, `shell command is not allowed: ${review.rationale}`);
}

function isAllowedWorkflowReadCommand(workflow: ToolPolicyWorkflowName, command: string): boolean {
  if (workflow !== "create-pr") return false;
  return matchesAllowedSegments(command.trim(), CREATE_PR_ALLOWED_READ_PATTERNS);
}

function extractShellCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  return typeof record.command === "string" ? record.command : undefined;
}

function isWorkflowActiveTool(workflow: ToolPolicyWorkflowName, toolName: string): boolean {
  return workflow === "create-pr"
    ? CREATE_PR_WORKFLOW_ACTIVE_TOOL_SET.has(toolName)
    : COMMIT_WORKFLOW_ACTIVE_TOOL_SET.has(toolName);
}

function classifyWorkflowCommandChain(
  workflow: ToolPolicyWorkflowName,
  command: string,
): "allow" | "deny" | "unknown" {
  const normalized = command.trim();
  if (!hasOnlySupportedSideEffectShellSyntax(normalized)) return "unknown";

  const chain = splitCommandChain(normalized);
  if (chain.segments.length === 0) return "unknown";

  const segmentTypes = chain.segments.map((segment) =>
    classifyWorkflowCommandSegment(workflow, segment),
  );
  if (segmentTypes.some((type) => type === "deny")) return "deny";
  if (segmentTypes.some((type) => type === "unknown")) return "unknown";

  const hasSideEffect = segmentTypes.includes("sideEffect");
  const hasRead = segmentTypes.includes("read");
  return hasSideEffect && hasRead && chain.operators.includes("||") ? "deny" : "allow";
}

type WorkflowCommandSegmentType = "sideEffect" | "read" | "deny" | "unknown";

function classifyWorkflowCommandSegment(
  workflow: ToolPolicyWorkflowName,
  segment: string,
): WorkflowCommandSegmentType {
  const sideEffect = classifyWorkflowSideEffectSegment(workflow, segment);
  if (sideEffect) return sideEffect;

  const readonly = classifyShellCommand(segment, { restrictionContext: `/${workflow} workflow` });
  if (readonly.decision === "allow") return "read";

  return isAllowedWorkflowReadCommand(workflow, segment) ? "read" : "unknown";
}

function classifyWorkflowSideEffectSegment(
  workflow: ToolPolicyWorkflowName,
  segment: string,
): "sideEffect" | "deny" | undefined {
  if (workflow === "commit") return classifyCommitSideEffectSegment(segment);
  return classifyCreatePrSideEffectSegment(segment);
}

function splitCommandChain(command: string): { segments: string[]; operators: Array<"&&" | "||"> } {
  const segments = command
    .split(/&&|\|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const operators = Array.from(command.matchAll(/&&|\|\|/g), (match) => match[0] as "&&" | "||");
  return { segments, operators };
}

function hasOnlySupportedSideEffectShellSyntax(command: string): boolean {
  return !/[`$<>;|&]/.test(command.replace(/&&|\|\|/g, ""));
}

function classifyCommitSideEffectSegment(segment: string): "sideEffect" | "deny" | undefined {
  const argv = splitCommandWords(segment);
  if (argv.length < 2 || argv[0] !== "git") return undefined;
  const [, subcommand, ...args] = argv;

  if (subcommand === "add") {
    if (hasDeniedGitAddArg(args)) return "deny";
    return args.length > 0 ? "sideEffect" : undefined;
  }

  if (subcommand === "commit") {
    if (args.some((arg) => isDeniedGitCommitArg(arg))) return "deny";
    return args.length > 0 ? "sideEffect" : undefined;
  }

  if (subcommand === "switch") {
    return args[0] === "-c" && args.length >= 2 ? "sideEffect" : undefined;
  }

  if (subcommand === "apply") {
    return (args.length >= 2 && args[0] === "--cached") ||
      (args.length >= 3 && args[0] === "--check" && args[1] === "--cached")
      ? "sideEffect"
      : undefined;
  }

  return undefined;
}

function classifyCreatePrSideEffectSegment(segment: string): "sideEffect" | "deny" | undefined {
  const argv = splitCommandWords(segment);
  if (argv.length < 2) return undefined;

  if (argv[0] === "git" && argv[1] === "push") {
    const args = argv.slice(2);
    if (args.some(isDeniedGitPushArg)) return "deny";
    return args.length > 0 ? "sideEffect" : undefined;
  }

  if (argv[0] !== "gh" || argv[1] !== "pr") return undefined;
  if (argv[2] === "create") {
    return hasOnlyAllowedOptions(argv.slice(3), GH_PR_CREATE_ALLOWED_OPTIONS, {
      requiredOptions: GH_PR_REQUIRED_BODY_OPTIONS,
      bodyFileOption: "--body-file",
    })
      ? "sideEffect"
      : "deny";
  }
  if (argv[2] === "edit") {
    return hasOnlyAllowedOptions(argv.slice(3), GH_PR_EDIT_ALLOWED_OPTIONS, {
      allowLeadingNumericPositional: true,
      requiredOptions: GH_PR_REQUIRED_BODY_OPTIONS,
      bodyFileOption: "--body-file",
    })
      ? "sideEffect"
      : "deny";
  }

  return undefined;
}

function isDeniedGitAddArg(arg: string): boolean {
  return (
    GIT_ADD_DENIED_ARGS.has(arg) ||
    arg === "--pathspec-from-file" ||
    arg.startsWith("--all=") ||
    arg.startsWith("--pathspec-from-file=") ||
    (arg.startsWith("-") && !arg.startsWith("--") && /[Au]/.test(arg.slice(1)))
  );
}

function isDeniedGitAddPathspec(arg: string): boolean {
  return arg === "." || arg === ":/" || arg === ":(top)";
}

function hasDeniedGitAddArg(args: string[]): boolean {
  let parsingOptions = true;
  for (const arg of args) {
    if (parsingOptions && arg === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions ? isDeniedGitAddArg(arg) : isDeniedGitAddPathspec(arg)) return true;
  }
  return false;
}

function isDeniedGitCommitArg(arg: string): boolean {
  return (
    COMMIT_DENIED_OPTIONS.has(arg) ||
    arg === "-i" ||
    arg === "--include" ||
    arg === "-o" ||
    arg === "--only" ||
    arg === "--pathspec-from-file" ||
    arg.startsWith("--include=") ||
    arg.startsWith("--only=") ||
    arg.startsWith("--pathspec-from-file=") ||
    arg.startsWith("--all=") ||
    arg.startsWith("--amend=") ||
    arg.startsWith("--allow-empty=") ||
    (arg.startsWith("-a") && arg !== "--") ||
    (arg.startsWith("-i") && arg !== "--") ||
    (arg.startsWith("-o") && arg !== "--")
  );
}

function isDeniedGitPushArg(arg: string): boolean {
  const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
  return (
    GIT_PUSH_DENIED_OPTIONS.has(optionName) ||
    (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("f")) ||
    arg.includes(":") ||
    arg.startsWith("+")
  );
}

function hasOnlyAllowedOptions(
  args: string[],
  allowedOptions: Set<string>,
  options: {
    allowLeadingNumericPositional?: boolean;
    bodyFileOption?: string;
    requiredOptions?: Set<string>;
  } = {},
): boolean {
  let index = 0;
  const seenOptions = new Set<string>();

  if (options.allowLeadingNumericPositional && args[index] && !args[index].startsWith("-")) {
    if (!/^\d+$/.test(args[index])) return false;
    index += 1;
  }

  while (index < args.length) {
    const arg = args[index];
    if (!arg.startsWith("--")) return false;
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!allowedOptions.has(optionName)) return false;

    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
    if (!value || value.startsWith("--")) return false;
    if (options.bodyFileOption === optionName && !isWorkflowTempFilePath(value)) return false;

    seenOptions.add(optionName);
    index += arg.includes("=") ? 1 : 2;
  }

  if (options.requiredOptions) {
    for (const optionName of options.requiredOptions) {
      if (!seenOptions.has(optionName)) return false;
    }
  }

  return args.length > 0;
}

function isWorkflowTempFilePath(path: string): boolean {
  if (path === "-" || !isAbsolute(path)) return false;
  const normalizedPath = normalize(path);
  if (normalizedPath.startsWith("/dev/")) return false;
  return normalizedPath.startsWith(join(tmpdir(), "pi-workflow-"));
}

function splitCommandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  const pushWord = () => {
    if (!current) return;
    words.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    current += char;
  }

  if (quote) return [];
  pushWord();
  return words;
}

function matchesAllowedSegments(command: string, patterns: RegExp[]): boolean {
  if (/[`$<>;|&]/.test(command.replace(/&&|\|\|/g, ""))) return false;
  let remaining = command;
  for (const pattern of patterns) {
    remaining = remaining.replace(pattern, " ");
  }
  return remaining.split(/&&|\|\|/).every((segment) => segment.trim().length === 0);
}

function block(workflow: ToolPolicyWorkflowName, reason: string) {
  return {
    block: true as const,
    reason: `/${workflow} extension によりブロックしました: ${reason}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
