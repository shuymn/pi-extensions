import { rm } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CliExec } from "./cli";
import {
  createDetachedGithubCloneWorkspaceRegister,
  createGithubCloneWorkspaceTool,
  GITHUB_CLONE_WORKSPACE_TOOL_NAME,
} from "./github-clone-workspace";
import { createTavilyToolDefinitions, TAVILY_TOOL_NAMES } from "./tavily-tools";

/**
 * Low-level investigation LLM tools mounted into isolated agent sessions
 * (spawn_subagent and workflow agent()). Order is stable so callers can assert
 * it directly.
 */
export const INVESTIGATION_TOOL_NAMES = [
  ...TAVILY_TOOL_NAMES,
  GITHUB_CLONE_WORKSPACE_TOOL_NAME,
] as const;

export type InvestigationToolName = (typeof INVESTIGATION_TOOL_NAMES)[number];

export const DEFAULT_ISOLATED_AGENT_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
] as const;
export const READ_ONLY_ISOLATED_AGENT_TOOL_NAMES = ["read", "grep", "find", "ls", "bash"] as const;

export type InvestigationToolset = {
  tools: ToolDefinition[];
  toolNames: string[];
  cleanup: () => Promise<void>;
};

export function isolatedAgentToolNames(
  toolset: Pick<InvestigationToolset, "toolNames">,
  options: { readOnly?: boolean; extraTools?: readonly string[] } = {},
): string[] {
  return [
    ...(options.readOnly ? READ_ONLY_ISOLATED_AGENT_TOOL_NAMES : DEFAULT_ISOLATED_AGENT_TOOL_NAMES),
    ...toolset.toolNames,
    ...(options.extraTools ?? []),
  ];
}

/**
 * Build the shared investigation toolset. The Tavily tools run through the
 * provided CliExec; the GitHub clone tool runs git directly and registers its
 * cloned workspaces in a detached (non-persisted) way. Cloned temp roots are
 * tracked here and removed only on the parent session shutdown via cleanup().
 */
export function createInvestigationToolset({ exec }: { exec: CliExec }): InvestigationToolset {
  const tempRoots = new Set<string>();
  let closed = false;
  let cleanupPromise: Promise<void> | undefined;

  const trackTempRoot = (tempRoot: string) => {
    if (closed) {
      // The session is shutting down; do not retain new clones. Remove the
      // freshly created root immediately and surface the shutdown to the caller.
      void rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("Investigation toolset is shut down; the temporary clone root was removed.");
    }
    tempRoots.add(tempRoot);
  };

  const untrackTempRoot = (tempRoot: string) => {
    tempRoots.delete(tempRoot);
  };

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    closed = true;
    const roots = [...tempRoots];
    tempRoots.clear();
    cleanupPromise = Promise.allSettled(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    ).then(() => undefined);
    return cleanupPromise;
  };

  const cloneTool = createGithubCloneWorkspaceTool({
    register: createDetachedGithubCloneWorkspaceRegister(),
    trackTempRoot,
    untrackTempRoot,
  });

  const tools: ToolDefinition[] = [...createTavilyToolDefinitions(exec), cloneTool];

  return {
    tools,
    toolNames: tools.map((tool) => tool.name),
    cleanup,
  };
}
