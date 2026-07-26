import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toCliExec } from "../../lib/cli";
import { createInvestigationToolset } from "../../lib/investigation-tools";
import { createWorkflowAgentRunner } from "./agent/runner";
import {
  REVIEW_FLOW_WORKFLOW_NAME,
  REVIEW_WORKFLOW_EVENT_NAME,
  reviewWorkflowEventName,
} from "./review-events";
import { WorkflowRunControllerRegistry } from "./run/controllers";
import { extensionPackagedWorkflowRootDescriptors } from "./saved/packaged";
import type { SavedWorkflowRootInput } from "./saved/resolver";
import { skillPackagedWorkflowRootsFromSystemPromptOptions } from "./saved/skill-packaged";
import { registerUltracodePolicyCommand } from "./ui/ultracode-command";
import {
  createWorkflowToolCommandLauncher,
  registerDirectSavedWorkflowCommands,
  registerWorkflowCommand,
} from "./ui/workflow-command";
import { registerWorkflowsCommand } from "./ui/workflows-command";
import { createWorkflowControllerMonitorControlSeams } from "./ui/workflows-controls";
import {
  createWorkflowCompletionNotifier,
  createWorkflowTool,
  type WorkflowLifecycleNotification,
} from "./workflow-tool";

export default function dynamicWorkflowsExtension(pi: ExtensionAPI): void {
  const controllerRegistry = new WorkflowRunControllerRegistry();
  const exec = toCliExec(pi);
  const investigationToolset = createInvestigationToolset({ exec });
  const completionNotifier = createWorkflowCompletionNotifier(pi);
  let isShuttingDown = false;
  let loadedSkillWorkflowRoots: string[] = [];
  const skillWorkflowRoots = (ctx?: unknown) => {
    const rootsFromContext = skillPackagedWorkflowRootsFromSystemPromptOptions(
      systemPromptOptionsFromContext(ctx),
    );
    return rootsFromContext.length > 0 ? rootsFromContext : loadedSkillWorkflowRoots;
  };
  // Skill-packaged roots first, then extension-packaged roots; the project root
  // is prepended inside the catalog and always wins by meta.name. Discovery here
  // is not authorization: packaged workflows still require explicit user or
  // skill instruction to launch.
  const additionalWorkflowRoots = (ctx?: unknown): SavedWorkflowRootInput[] => [
    ...skillWorkflowRoots(ctx),
    ...extensionPackagedWorkflowRootDescriptors(),
  ];

  pi.on("before_agent_start", (event) => {
    loadedSkillWorkflowRoots = skillPackagedWorkflowRootsFromSystemPromptOptions(
      event.systemPromptOptions,
    );
  });

  const workflowTool = createWorkflowTool({
    exec,
    agentFactory: (ctx) => createWorkflowAgentRunner(pi, ctx, investigationToolset),
    controllerRegistry,
    completionNotifier: (notification) => {
      if (!isShuttingDown) completionNotifier(notification);
    },
    lifecycleNotifier: (notification) => emitReviewWorkflowLifecycle(pi, notification),
    additionalWorkflowRoots,
  });

  const launchWorkflow = createWorkflowToolCommandLauncher(workflowTool);

  registerWorkflowsCommand(pi, {
    controls: createWorkflowControllerMonitorControlSeams(controllerRegistry),
  });
  registerWorkflowCommand(pi, { launchWorkflow, additionalWorkflowRoots });
  registerUltracodePolicyCommand(pi);
  registerDirectSavedWorkflowCommands(pi, { launchWorkflow });
  pi.registerTool(workflowTool);

  pi.on("session_shutdown", async () => {
    isShuttingDown = true;
    try {
      await controllerRegistry.shutdown(
        (runId) => `session shutdown stopped workflow run: ${runId}`,
      );
      await investigationToolset.cleanup();
    } finally {
      isShuttingDown = false;
    }
  });
}

function emitReviewWorkflowLifecycle(
  pi: Pick<ExtensionAPI, "events">,
  notification: WorkflowLifecycleNotification,
): void {
  if (notification.workflowName !== REVIEW_FLOW_WORKFLOW_NAME) return;
  pi.events.emit(reviewWorkflowEventName(notification.status), {
    name: REVIEW_WORKFLOW_EVENT_NAME,
    ...notification,
  });
}

function systemPromptOptionsFromContext(ctx: unknown): BuildSystemPromptOptions | undefined {
  if (typeof ctx !== "object" || ctx === null || !("getSystemPromptOptions" in ctx)) {
    return undefined;
  }

  const getSystemPromptOptions = (ctx as { getSystemPromptOptions?: unknown })
    .getSystemPromptOptions;
  return typeof getSystemPromptOptions === "function" ? getSystemPromptOptions() : undefined;
}
