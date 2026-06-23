import { join } from "node:path";
import type {
  WorkflowAgentStatus,
  WorkflowPhaseStatus,
  WorkflowRunAgentState,
  WorkflowRunFailure,
  WorkflowRunPhaseState,
  WorkflowRunState,
  WorkflowRunStatus,
} from "../run/model";
import {
  agentStatusView,
  phaseStatusView,
  runStatusView,
  type WorkflowStatusViewModel,
} from "./status-view";
import type {
  WorkflowMonitorControlSeams,
  WorkflowMonitorControlsViewModel,
} from "./workflows-controls";

export type WorkflowsProjectionSelection = {
  runId?: string;
  phaseTitle?: string;
  agentId?: string;
};

export type WorkflowsProjectionOptions = {
  controls?: Pick<WorkflowMonitorControlSeams, "describe">;
};

export type WorkflowMetricsViewModel = {
  agentCount: number;
  queuedAgents: number;
  runningAgents: number;
  completedAgents: number;
  failedAgents: number;
  estimatedResultTokens: number;
  durationMs?: number;
};

export type WorkflowChooserItemViewModel = WorkflowStatusViewModel<WorkflowRunStatus> & {
  runId: string;
  taskId: string;
  workflowName: string;
  description?: string;
  currentPhase?: string;
  updatedAt: string;
  artifactDir: string;
  agentSummary: string;
};

export type WorkflowPhaseItemViewModel = WorkflowStatusViewModel<WorkflowPhaseStatus> & {
  title: string;
  description?: string;
  startedAt?: string;
  completedAt?: string;
  agentCount: number;
};

export type WorkflowAgentItemViewModel = WorkflowStatusViewModel<WorkflowAgentStatus> & {
  id: string;
  label: string;
  phase?: string;
  promptPreview: string;
  resultPreview?: string;
  error?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type WorkflowPhaseProjectionViewModel = {
  selectedPhaseTitle?: string;
  phases: WorkflowPhaseItemViewModel[];
  selectedPhase?: WorkflowPhaseItemViewModel;
  agents: WorkflowAgentItemViewModel[];
};

export type WorkflowAgentDetailViewModel = WorkflowAgentItemViewModel & {
  timing: {
    queuedAt: string;
    startedAt?: string;
    completedAt?: string;
  };
};

export type WorkflowPromptReaderSource =
  | "transcriptPrompt"
  | "transcriptSessionPrompt"
  | "manifestPromptPreview";

export type WorkflowPromptReaderViewModel = {
  title: string;
  prompt: string;
  source: WorkflowPromptReaderSource;
  isFullPrompt: boolean;
  transcriptPath?: string;
};

export type WorkflowRunOverviewViewModel = WorkflowStatusViewModel<WorkflowRunStatus> & {
  runId: string;
  taskId: string;
  workflowName: string;
  description?: string;
  sessionId?: string;
  cwd: string;
  artifactDir: string;
  scriptPath?: string;
  outputPath?: string;
  resultPreview?: string;
  startTime: string;
  updatedAt: string;
  metrics: WorkflowMetricsViewModel;
  recentLogs: string[];
  failures: WorkflowRunFailure[];
};

export type WorkflowsProjectionViewModel = {
  workflowRoot: string;
  chooser: WorkflowChooserItemViewModel[];
  selectedRunId?: string;
  overview?: WorkflowRunOverviewViewModel;
  phase?: WorkflowPhaseProjectionViewModel;
  agentDetail?: WorkflowAgentDetailViewModel;
  promptReader?: WorkflowPromptReaderViewModel;
  controls?: WorkflowMonitorControlsViewModel;
};

export function createWorkflowsProjection(
  workflowRoot: string,
  runs: WorkflowRunState[],
  selection: WorkflowsProjectionSelection = {},
  options: WorkflowsProjectionOptions = {},
): WorkflowsProjectionViewModel {
  const chooser = runs.map((run) => workflowChooserItem(workflowRoot, run));
  const selectedRun = selectRun(runs, selection.runId);
  if (selectedRun === undefined) return { workflowRoot, chooser };

  const selectedPhaseTitle = selectPhaseTitle(selectedRun, selection.phaseTitle);
  const phase = workflowPhaseProjection(selectedRun, selectedPhaseTitle);
  const selectedAgent = selectAgent(selectedRun, selectedPhaseTitle, selection.agentId);
  const controls = options.controls?.describe({
    workflowRoot,
    runId: selectedRun.runId,
    runStatus: selectedRun.status,
    ...(selectedAgent === undefined
      ? {}
      : { agentId: selectedAgent.id, agentStatus: selectedAgent.status }),
  });

  return {
    workflowRoot,
    chooser,
    selectedRunId: selectedRun.runId,
    overview: workflowOverview(workflowRoot, selectedRun),
    phase,
    ...(selectedAgent === undefined ? {} : { agentDetail: workflowAgentDetail(selectedAgent) }),
    ...(selectedAgent === undefined ? {} : { promptReader: workflowPromptReader(selectedAgent) }),
    ...(controls === undefined ? {} : { controls }),
  };
}

function workflowChooserItem(
  workflowRoot: string,
  state: WorkflowRunState,
): WorkflowChooserItemViewModel {
  return {
    runId: state.runId,
    taskId: state.taskId,
    workflowName: state.workflowName,
    ...(state.description === undefined ? {} : { description: state.description }),
    ...runStatusView(state.status),
    ...(state.workflowProgress.currentPhase === undefined
      ? {}
      : { currentPhase: state.workflowProgress.currentPhase }),
    updatedAt: state.updatedAt,
    artifactDir: artifactDir(workflowRoot, state),
    agentSummary: formatAgentSummary(metricsFromState(state)),
  };
}

function workflowOverview(
  workflowRoot: string,
  state: WorkflowRunState,
): WorkflowRunOverviewViewModel {
  return {
    runId: state.runId,
    taskId: state.taskId,
    workflowName: state.workflowName,
    ...(state.description === undefined ? {} : { description: state.description }),
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...runStatusView(state.status),
    cwd: state.cwd,
    artifactDir: artifactDir(workflowRoot, state),
    ...(state.scriptPath === undefined ? {} : { scriptPath: state.scriptPath }),
    ...(state.outputPath === undefined ? {} : { outputPath: state.outputPath }),
    ...(state.resultPreview === undefined ? {} : { resultPreview: state.resultPreview }),
    startTime: state.startTime,
    updatedAt: state.updatedAt,
    metrics: metricsFromState(state),
    recentLogs: state.logs.slice(-5),
    failures: state.failures.map((failure) => ({ ...failure })),
  };
}

function workflowPhaseProjection(
  state: WorkflowRunState,
  selectedPhaseTitle: string | undefined,
): WorkflowPhaseProjectionViewModel {
  const phases = state.phases.map((phase) => workflowPhaseItem(state, phase));
  const selectedPhase = phases.find((phase) => phase.title === selectedPhaseTitle);
  return {
    ...(selectedPhaseTitle === undefined ? {} : { selectedPhaseTitle }),
    phases,
    ...(selectedPhase === undefined ? {} : { selectedPhase }),
    agents: agentsForPhase(state, selectedPhaseTitle).map(workflowAgentItem),
  };
}

function workflowPhaseItem(
  state: WorkflowRunState,
  phase: WorkflowRunPhaseState,
): WorkflowPhaseItemViewModel {
  return {
    title: phase.title,
    ...(phase.description === undefined ? {} : { description: phase.description }),
    ...phaseStatusView(phase.status),
    ...(phase.startedAt === undefined ? {} : { startedAt: phase.startedAt }),
    ...(phase.completedAt === undefined ? {} : { completedAt: phase.completedAt }),
    agentCount: state.agents.filter((agent) => agent.phase === phase.title).length,
  };
}

function workflowAgentDetail(agent: WorkflowRunAgentState): WorkflowAgentDetailViewModel {
  const item = workflowAgentItem(agent);
  return {
    ...item,
    timing: {
      queuedAt: agent.queuedAt,
      ...(agent.startedAt === undefined ? {} : { startedAt: agent.startedAt }),
      ...(agent.completedAt === undefined ? {} : { completedAt: agent.completedAt }),
    },
  };
}

function workflowAgentItem(agent: WorkflowRunAgentState): WorkflowAgentItemViewModel {
  return {
    id: agent.id,
    label: agent.label,
    ...(agent.phase === undefined ? {} : { phase: agent.phase }),
    ...agentStatusView(agent.status),
    promptPreview: agent.promptPreview,
    ...(agent.resultPreview === undefined ? {} : { resultPreview: agent.resultPreview }),
    ...(agent.error === undefined ? {} : { error: agent.error }),
    queuedAt: agent.queuedAt,
    ...(agent.startedAt === undefined ? {} : { startedAt: agent.startedAt }),
    ...(agent.completedAt === undefined ? {} : { completedAt: agent.completedAt }),
  };
}

function workflowPromptReader(agent: WorkflowRunAgentState): WorkflowPromptReaderViewModel {
  return {
    title: agent.label,
    prompt: agent.promptPreview,
    source: "manifestPromptPreview",
    isFullPrompt: false,
  };
}

function metricsFromState(state: WorkflowRunState): WorkflowMetricsViewModel {
  return {
    agentCount: state.agentCount,
    queuedAgents: state.workflowProgress.queuedAgents,
    runningAgents: state.workflowProgress.runningAgents,
    completedAgents: state.workflowProgress.completedAgents,
    failedAgents: state.workflowProgress.failedAgents,
    estimatedResultTokens: state.estimatedResultTokens,
    ...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
  };
}

function selectRun(
  runs: WorkflowRunState[],
  requestedRunId: string | undefined,
): WorkflowRunState | undefined {
  if (requestedRunId !== undefined) {
    const selected = runs.find((run) => run.runId === requestedRunId);
    if (selected !== undefined) return selected;
  }
  return runs[0];
}

function selectPhaseTitle(
  state: WorkflowRunState,
  requestedPhaseTitle: string | undefined,
): string | undefined {
  if (
    requestedPhaseTitle !== undefined &&
    state.phases.some((phase) => phase.title === requestedPhaseTitle)
  ) {
    return requestedPhaseTitle;
  }
  if (
    state.workflowProgress.currentPhase !== undefined &&
    state.phases.some((phase) => phase.title === state.workflowProgress.currentPhase)
  ) {
    return state.workflowProgress.currentPhase;
  }
  return (
    state.phases.find((phase) => phase.status === "running") ??
    state.phases.find((phase) => phase.status !== "skipped") ??
    state.phases[0]
  )?.title;
}

function selectAgent(
  state: WorkflowRunState,
  selectedPhaseTitle: string | undefined,
  requestedAgentId: string | undefined,
): WorkflowRunAgentState | undefined {
  if (requestedAgentId !== undefined) {
    const selected = state.agents.find((agent) => agent.id === requestedAgentId);
    if (selected !== undefined) return selected;
  }

  const phaseAgents = agentsForPhase(state, selectedPhaseTitle);
  return (
    phaseAgents.find(isActiveAgent) ??
    phaseAgents.at(-1) ??
    state.agents.find(isActiveAgent) ??
    state.agents.at(-1)
  );
}

function agentsForPhase(
  state: WorkflowRunState,
  selectedPhaseTitle: string | undefined,
): WorkflowRunAgentState[] {
  return selectedPhaseTitle === undefined
    ? state.agents
    : state.agents.filter((agent) => agent.phase === selectedPhaseTitle);
}

function isActiveAgent(agent: WorkflowRunAgentState): boolean {
  return agent.status === "running" || agent.status === "queued" || agent.status === "failed";
}

function artifactDir(workflowRoot: string, state: WorkflowRunState): string {
  return join(workflowRoot, state.runId);
}

function formatAgentSummary(metrics: WorkflowMetricsViewModel): string {
  return `待機${metrics.queuedAgents}/実行${metrics.runningAgents}/完了${metrics.completedAgents}/失敗${metrics.failedAgents}`;
}
