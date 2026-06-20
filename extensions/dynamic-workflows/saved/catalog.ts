import { basename, join } from "node:path";
import { resolveWorkflowRoot } from "../run/root";
import {
  listSavedWorkflows,
  mergeSavedWorkflowRoots,
  resolveSavedWorkflow,
  type SavedWorkflow,
} from "./resolver";

export type WorkflowCatalogRoots = {
  projectRoot: string;
  roots: string[];
};

export type WorkflowCatalogOptions = {
  additionalWorkflowRoots?: readonly string[];
};

export type WorkflowCatalogDirectCommandPolicy = {
  isNameSafe(name: string): boolean;
  takenCommandNames: ReadonlySet<string>;
  registeredCommandNames?: ReadonlySet<string>;
};

export type WorkflowCatalogDirectCommandCandidate = {
  workflow: SavedWorkflow;
  commandName: string;
  fallbackCommand: string;
  canRegister: boolean;
  reason?: "command_collision" | "duplicate_saved_name" | "unsafe_name" | "already_registered";
};

export class WorkflowCatalog {
  readonly roots: WorkflowCatalogRoots;

  constructor(cwd: string, options: WorkflowCatalogOptions = {}) {
    const projectRoot = resolveWorkflowRoot(cwd);
    this.roots = {
      projectRoot,
      roots: mergeSavedWorkflowRoots(projectRoot, options.additionalWorkflowRoots ?? []),
    };
  }

  async list(): Promise<SavedWorkflow[]> {
    return await listSavedWorkflows(this.roots.roots);
  }

  async listProjectSaved(): Promise<SavedWorkflow[]> {
    return await listSavedWorkflows(this.roots.projectRoot);
  }

  async resolve(name: string): Promise<SavedWorkflow> {
    return await resolveSavedWorkflow(this.roots.roots, name);
  }

  completionCandidates(prefix: string, workflows: readonly SavedWorkflow[]) {
    return workflows
      .filter((workflow) => workflow.name.startsWith(prefix))
      .map((workflow) => ({
        value: workflow.name,
        label: workflow.name,
        ...(workflow.description === undefined ? {} : { description: workflow.description }),
      }));
  }

  savedScriptPath(name: string): string {
    assertSafeSavedWorkflowFileName(name);
    return join(this.roots.projectRoot, `${name}.js`);
  }

  directCommandCandidates(
    workflows: readonly SavedWorkflow[],
    policy: WorkflowCatalogDirectCommandPolicy,
  ): WorkflowCatalogDirectCommandCandidate[] {
    const duplicateNames = findDuplicateWorkflowNames(workflows);
    const registered = policy.registeredCommandNames ?? new Set<string>();
    return workflows.map((workflow) => {
      const commandName = workflow.name;
      const fallbackCommand = formatWorkflowFallbackCommand(workflow.name, policy.isNameSafe);
      if (!policy.isNameSafe(commandName)) {
        return {
          workflow,
          commandName,
          fallbackCommand,
          canRegister: false,
          reason: "unsafe_name" as const,
        };
      }
      if (duplicateNames.has(workflow.name)) {
        return {
          workflow,
          commandName,
          fallbackCommand,
          canRegister: false,
          reason: "duplicate_saved_name" as const,
        };
      }
      if (registered.has(commandName)) {
        return {
          workflow,
          commandName,
          fallbackCommand,
          canRegister: false,
          reason: "already_registered" as const,
        };
      }
      if (policy.takenCommandNames.has(commandName)) {
        return {
          workflow,
          commandName,
          fallbackCommand,
          canRegister: false,
          reason: "command_collision" as const,
        };
      }
      return { workflow, commandName, fallbackCommand, canRegister: true };
    });
  }
}

export function workflowCatalogForCwd(
  cwd: string,
  additionalWorkflowRoots: readonly string[] = [],
): WorkflowCatalog {
  return new WorkflowCatalog(cwd, { additionalWorkflowRoots });
}

export function workflowCatalogForRoot(
  projectRoot: string,
  additionalWorkflowRoots: readonly string[] = [],
): WorkflowCatalog {
  const catalog = Object.create(WorkflowCatalog.prototype) as WorkflowCatalog;
  Object.defineProperty(catalog, "roots", {
    value: {
      projectRoot,
      roots: mergeSavedWorkflowRoots(projectRoot, additionalWorkflowRoots),
    },
    enumerable: true,
  });
  return catalog;
}

function assertSafeSavedWorkflowFileName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\") ||
    basename(name) !== name
  ) {
    throw new Error(`unsafe saved workflow name: ${name}`);
  }
}

function findDuplicateWorkflowNames(workflows: readonly SavedWorkflow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const workflow of workflows) {
    counts.set(workflow.name, (counts.get(workflow.name) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

function formatWorkflowFallbackCommand(
  name: string,
  isNameSafe: (name: string) => boolean,
): string {
  return `/workflow ${isNameSafe(name) ? name : JSON.stringify(name)}`;
}
