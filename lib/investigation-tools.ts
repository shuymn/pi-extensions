import { rm } from "node:fs/promises";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CliExec } from "./cli";
import {
  createDetachedGithubCloneWorkspaceRegister,
  createGithubCloneWorkspaceTool,
  GITHUB_CLONE_WORKSPACE_TOOL_NAME,
} from "./github-clone-workspace";
import { createTavilyToolDefinitions, TAVILY_TOOL_NAMES } from "./tavily-tools";

/** Investigation tools with detached workspace ownership in delegated sessions. */
export const INVESTIGATION_TOOL_NAMES = [
  ...TAVILY_TOOL_NAMES,
  GITHUB_CLONE_WORKSPACE_TOOL_NAME,
] as const;

export type InvestigationToolName = (typeof INVESTIGATION_TOOL_NAMES)[number];

export type InvestigationToolset = {
  tools: ToolDefinition[];
  toolNames: string[];
  cleanup: () => Promise<void>;
};

/**
 * Build the shared investigation toolset. The Tavily tools run through the
 * provided CliExec; the GitHub clone tool runs git directly and registers its
 * cloned workspaces in a detached (non-persisted) way. Cloned temp roots are
 * tracked here and removed via cleanup() after the owning session's children settle.
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

  const tools: ToolDefinition[] = [...createTavilyToolDefinitions(exec), cloneTool].map((tool) => ({
    ...tool,
    // Network reads and detached scratch clones do not mutate the caller's repository.
    annotations: { ...tool.annotations, readOnlyHint: true },
  }));

  return {
    tools,
    toolNames: tools.map((tool) => tool.name),
    cleanup,
  };
}
