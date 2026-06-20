import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkflowAgentRunner } from "./agent/runner";
import { WorkflowRunControllerRegistry } from "./run/controllers";
import { skillPackagedWorkflowRootsFromSystemPromptOptions } from "./saved/skill-packaged";
import { registerUltracodePolicyCommand } from "./ui/ultracode-command";
import {
  createWorkflowToolCommandLauncher,
  registerDirectSavedWorkflowCommands,
  registerWorkflowCommand,
} from "./ui/workflow-command";
import { registerWorkflowsCommand } from "./ui/workflows-command";
import { createWorkflowControllerMonitorControlSeams } from "./ui/workflows-controls";
import { createWorkflowCompletionNotifier, createWorkflowTool } from "./workflow-tool";

export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
  const controllerRegistry = new WorkflowRunControllerRegistry();
  let loadedSkillWorkflowRoots: string[] = [];
  const skillWorkflowRoots = (ctx?: unknown) => {
    const rootsFromContext = skillPackagedWorkflowRootsFromSystemPromptOptions(
      systemPromptOptionsFromContext(ctx),
    );
    return rootsFromContext.length > 0 ? rootsFromContext : loadedSkillWorkflowRoots;
  };

  pi.on("before_agent_start", (event) => {
    loadedSkillWorkflowRoots = skillPackagedWorkflowRootsFromSystemPromptOptions(
      event.systemPromptOptions,
    );
  });

  const workflowTool = createWorkflowTool({
    agentFactory: (ctx) => createWorkflowAgentRunner(pi, ctx),
    controllerRegistry,
    completionNotifier: createWorkflowCompletionNotifier(pi),
    selectedThinkingLevelFactory: () => pi.getThinkingLevel(),
    additionalWorkflowRoots: skillWorkflowRoots,
  });

  const launchWorkflow = createWorkflowToolCommandLauncher(workflowTool);

  registerWorkflowsCommand(pi, {
    controls: createWorkflowControllerMonitorControlSeams(controllerRegistry),
  });
  registerWorkflowCommand(pi, { launchWorkflow, additionalWorkflowRoots: skillWorkflowRoots });
  registerUltracodePolicyCommand(pi);
  registerDirectSavedWorkflowCommands(pi, { launchWorkflow });
  pi.registerTool(workflowTool);
}

function systemPromptOptionsFromContext(ctx: unknown): BuildSystemPromptOptions | undefined {
  if (typeof ctx !== "object" || ctx === null || !("getSystemPromptOptions" in ctx)) {
    return undefined;
  }

  const getSystemPromptOptions = (ctx as { getSystemPromptOptions?: unknown })
    .getSystemPromptOptions;
  return typeof getSystemPromptOptions === "function" ? getSystemPromptOptions() : undefined;
}
