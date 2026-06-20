import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { WorkflowRunControllerRegistry } from "../run/controllers";
import type { WorkflowAgentStatus, WorkflowRunStatus } from "../run/model";

export type WorkflowMonitorControlActionType = "stopRun" | "stopAgent";

export type WorkflowMonitorControlScope = "run" | "agent";

export type WorkflowMonitorControlItemViewModel = {
  type: WorkflowMonitorControlActionType;
  label: string;
  shortcut: KeyId;
  scope: WorkflowMonitorControlScope;
  enabled: boolean;
  disabledReason?: string;
};

export type WorkflowMonitorControlsViewModel = {
  runId: string;
  agentId?: string;
  items: WorkflowMonitorControlItemViewModel[];
};

export type WorkflowMonitorControlAction = {
  type: WorkflowMonitorControlActionType;
  runId: string;
  agentId?: string;
};

export type WorkflowMonitorControlContext = {
  workflowRoot: string;
  runId?: string;
  agentId?: string;
  runStatus?: WorkflowRunStatus;
  agentStatus?: WorkflowAgentStatus;
};

export type WorkflowMonitorControlResult = {
  action: WorkflowMonitorControlAction;
  status: "completed" | "disabled" | "failed";
  message: string;
  details?: Record<string, unknown>;
};

export type WorkflowMonitorControlSeams = {
  describe(context: WorkflowMonitorControlContext): WorkflowMonitorControlsViewModel | undefined;
  execute(
    action: WorkflowMonitorControlAction,
    context: WorkflowMonitorControlContext,
  ): Promise<WorkflowMonitorControlResult> | WorkflowMonitorControlResult;
};

type WorkflowMonitorControlDefinition = {
  type: WorkflowMonitorControlActionType;
  label: string;
  shortcut: KeyId;
  scope: WorkflowMonitorControlScope;
};

const DISABLED_REASON = "未接続";

export const WORKFLOW_MONITOR_CONTROL_DEFINITIONS: WorkflowMonitorControlDefinition[] = [
  { type: "stopRun", label: "run停止", shortcut: "x", scope: "run" },
  { type: "stopAgent", label: "agent停止", shortcut: "k", scope: "agent" },
];

export function createDisabledWorkflowMonitorControlSeams(): WorkflowMonitorControlSeams {
  return {
    describe: createDisabledWorkflowMonitorControls,
    execute(action) {
      return {
        action,
        status: "disabled",
        message: `/workflows: 操作「${workflowMonitorControlLabel(action.type)}」はまだ接続されていません。`,
      };
    },
  };
}

export function createWorkflowControllerMonitorControlSeams(
  registry: WorkflowRunControllerRegistry,
): WorkflowMonitorControlSeams {
  return {
    describe(context) {
      return createWorkflowControllerMonitorControls(context, registry);
    },
    execute(action) {
      if (action.type === "stopRun") return stopRun(action, registry);
      if (action.type === "stopAgent") return stopAgent(action, registry);
      return disabledControlResult(action);
    },
  };
}

export function createDisabledWorkflowMonitorControls(
  context: WorkflowMonitorControlContext,
): WorkflowMonitorControlsViewModel | undefined {
  if (context.runId === undefined) return undefined;
  return {
    runId: context.runId,
    ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
    items: WORKFLOW_MONITOR_CONTROL_DEFINITIONS.map((definition) => ({
      ...definition,
      enabled: false,
      disabledReason:
        definition.scope === "agent" && context.agentId === undefined
          ? "エージェント未選択"
          : DISABLED_REASON,
    })),
  };
}

export function createWorkflowControllerMonitorControls(
  context: WorkflowMonitorControlContext,
  registry: WorkflowRunControllerRegistry,
): WorkflowMonitorControlsViewModel | undefined {
  if (context.runId === undefined) return undefined;
  const runActive = registry.get(context.runId) !== undefined;
  const agentActive =
    context.agentId !== undefined &&
    registry.getAgent(context.runId, context.agentId) !== undefined;

  return {
    runId: context.runId,
    ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
    items: WORKFLOW_MONITOR_CONTROL_DEFINITIONS.map((definition) => {
      if (definition.type === "stopRun") {
        return {
          ...definition,
          enabled: runActive,
          ...(runActive ? {} : { disabledReason: "実行中ではありません" }),
        };
      }
      if (definition.type === "stopAgent") {
        return {
          ...definition,
          enabled: agentActive,
          ...(agentActive
            ? {}
            : {
                disabledReason:
                  context.agentId === undefined ? "エージェント未選択" : "実行中ではありません",
              }),
        };
      }
      return { ...definition, enabled: false, disabledReason: DISABLED_REASON };
    }),
  };
}

export function workflowMonitorControlLabel(type: WorkflowMonitorControlActionType): string {
  return controlDefinition(type)?.label ?? type;
}

export function workflowMonitorControlActionFromItem(
  controls: WorkflowMonitorControlsViewModel,
  item: WorkflowMonitorControlItemViewModel,
): WorkflowMonitorControlAction {
  return {
    type: item.type,
    runId: controls.runId,
    ...(item.scope === "agent" && controls.agentId !== undefined
      ? { agentId: controls.agentId }
      : {}),
  };
}

export function workflowMonitorControlActionForInput(
  controls: WorkflowMonitorControlsViewModel | undefined,
  data: string,
): WorkflowMonitorControlAction | undefined {
  const item = controls?.items.find((candidate) => matchesKey(data, candidate.shortcut));
  return item === undefined || controls === undefined
    ? undefined
    : workflowMonitorControlActionFromItem(controls, item);
}

export function formatWorkflowMonitorControls(
  controls: WorkflowMonitorControlsViewModel | undefined,
): string[] {
  if (controls === undefined) return [];
  return controls.items.map((item) => {
    const state = item.enabled ? "有効" : (item.disabledReason ?? "無効");
    return `[${item.shortcut}] ${item.label} (${state})`;
  });
}

export function controlDefinition(
  type: WorkflowMonitorControlActionType,
): WorkflowMonitorControlDefinition | undefined {
  return WORKFLOW_MONITOR_CONTROL_DEFINITIONS.find((definition) => definition.type === type);
}

function stopRun(
  action: WorkflowMonitorControlAction,
  registry: WorkflowRunControllerRegistry,
): WorkflowMonitorControlResult {
  const stopped = registry.stop(
    action.runId,
    `ユーザーが/workflowsからrun停止を要求しました: ${action.runId}`,
  );
  if (!stopped) {
    return {
      action,
      status: "disabled",
      message: `/workflows: run ${action.runId} は実行中ではありません。`,
    };
  }
  return {
    action,
    status: "completed",
    message: `/workflows: run ${action.runId} を停止しました。`,
  };
}

function stopAgent(
  action: WorkflowMonitorControlAction,
  registry: WorkflowRunControllerRegistry,
): WorkflowMonitorControlResult {
  if (action.agentId === undefined) {
    return {
      action,
      status: "disabled",
      message: "/workflows: 停止するagentが選択されていません。",
    };
  }
  const stopped = registry.stopAgent(
    action.runId,
    action.agentId,
    `ユーザーが/workflowsからagent停止を要求しました: ${action.agentId}`,
  );
  if (!stopped) {
    return {
      action,
      status: "disabled",
      message: `/workflows: agent ${action.agentId} は実行中ではありません。`,
    };
  }
  return {
    action,
    status: "completed",
    message: `/workflows: agent ${action.agentId} を停止しました。`,
  };
}

function disabledControlResult(action: WorkflowMonitorControlAction): WorkflowMonitorControlResult {
  return {
    action,
    status: "disabled",
    message: `/workflows: 操作「${workflowMonitorControlLabel(action.type)}」はまだ接続されていません。`,
  };
}
