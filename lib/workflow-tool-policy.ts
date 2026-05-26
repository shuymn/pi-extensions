import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { checkForbiddenFlags, type Workflow } from "./forbidden-flags";

export type ToolPolicyWorkflowName = Workflow;

export type ToolCallGateResult = { block: true; reason: string } | undefined;

export const WORKFLOW_TEMP_FILE_TOOL_NAME = "workflow_write_temp_file";

const BASE_ACTIVE_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "spawn_subagent",
  WORKFLOW_TEMP_FILE_TOOL_NAME,
] as const;

const WORKFLOW_ACTIVE_TOOLS: Record<Workflow, readonly string[]> = {
  commit: BASE_ACTIVE_TOOLS,
  "create-pr": [...BASE_ACTIVE_TOOLS, "ask_user_question"],
};

type TempFileToolDetails = { ok: boolean; path?: string };

export function getWorkflowActiveTools(workflow: Workflow): string[] {
  return [...WORKFLOW_ACTIVE_TOOLS[workflow]];
}

export function applyWorkflowActiveTools(pi: ExtensionAPI, workflow: Workflow): void {
  pi.setActiveTools(getWorkflowActiveTools(workflow));
}

export function registerWorkflowTempFileTool(pi: ExtensionAPI, workflow: Workflow): void {
  pi.registerTool({
    name: WORKFLOW_TEMP_FILE_TOOL_NAME,
    label: "Write temp file",
    description:
      "Write generated workflow helper content to a new file under the OS temp directory. This never writes inside the workspace.",
    promptSnippet: buildTempFilePromptSnippet(workflow),
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

export function evaluateWorkflowToolCall(
  workflow: Workflow,
  event: { toolName?: string; input?: unknown },
): ToolCallGateResult {
  const toolName = event.toolName;
  if (!toolName) return block(workflow, "tool name is missing.");

  if (!WORKFLOW_ACTIVE_TOOLS[workflow].includes(toolName)) {
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
  if (command === undefined) return block(workflow, "shell command input is missing.");

  const result = checkForbiddenFlags(workflow, command);
  return result.ok ? undefined : block(workflow, result.reason);
}

function buildTempFilePromptSnippet(workflow: Workflow): string {
  if (workflow === "commit") {
    return `Use ${WORKFLOW_TEMP_FILE_TOOL_NAME} only during the commit workflow, and only as a last resort for a git-apply-compatible partial-staging patch when a mixed file cannot be staged as a whole. Do not use it for workspace edits, whole-file staging, tests, lint, or repeated patch retries.`;
  }
  return `Use ${WORKFLOW_TEMP_FILE_TOOL_NAME} only during the create-pr workflow, and only for the final PR body file passed to gh pr create/edit --body-file. Do not use it for patches, workspace edits, tests, lint, or intermediate drafts.`;
}

function extractShellCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  return typeof record.command === "string" ? record.command : undefined;
}

function block(workflow: Workflow, reason: string): ToolCallGateResult {
  return {
    block: true as const,
    reason: `/${workflow} extension によりブロックしました: ${reason}`,
  };
}
