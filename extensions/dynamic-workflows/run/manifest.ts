import type { WorkflowRunAgentState, WorkflowRunState } from "./model";

export type WorkflowManifestAgentEvent = {
  runAgentId: string;
  label: string;
  phase?: string;
  prompt: string;
};

export type WorkflowManifestAgentEndEvent = WorkflowManifestAgentEvent & {
  result?: unknown;
  error?: string;
};

export type WorkflowManifestWriter = (state: WorkflowRunState) => void | Promise<void>;

export type WorkflowManifestUpdaterOptions = {
  now?: () => string;
};

const PREVIEW_LIMIT = 800;

export class WorkflowManifestUpdater {
  readonly state: WorkflowRunState;

  #pendingWrite = Promise.resolve();
  #writeError: unknown;
  readonly #writer: WorkflowManifestWriter;
  readonly #now: () => string;

  constructor(
    state: WorkflowRunState,
    writer: WorkflowManifestWriter,
    options: WorkflowManifestUpdaterOptions = {},
  ) {
    this.state = state;
    this.#writer = writer;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  markRunning(): void {
    this.state.status = "running";
    this.touch();
  }

  phase(title: string): void {
    const timestamp = this.#now();
    const previous = this.state.workflowProgress.currentPhase;
    if (previous && previous !== title) {
      const previousPhase = this.findPhase(previous);
      if (previousPhase?.status === "running") {
        previousPhase.status = "completed";
        previousPhase.completedAt = timestamp;
      }
    }

    this.state.workflowProgress.currentPhase = title;
    const phase = this.findPhase(title) ?? this.addPhase(title);
    if (phase.status === "pending" || phase.status === "skipped") {
      phase.startedAt = timestamp;
    }
    phase.status = "running";
    this.touch(timestamp);
  }

  log(message: string): void {
    this.state.logs.push(message);
    this.touch();
  }

  agentQueued(event: WorkflowManifestAgentEvent): void {
    const timestamp = this.#now();
    this.state.agents.push({
      id: event.runAgentId,
      label: event.label,
      ...(event.phase === undefined ? {} : { phase: event.phase }),
      status: "queued",
      promptPreview: previewText(event.prompt),
      queuedAt: timestamp,
    });
    this.recountAgents();
    this.touch(timestamp);
  }

  agentStarted(event: WorkflowManifestAgentEvent): void {
    const timestamp = this.#now();
    const agent = this.findAgent(event, "queued") ?? this.createImplicitAgent(event, timestamp);
    agent.status = "running";
    agent.startedAt = timestamp;
    this.recountAgents();
    this.touch(timestamp);
  }

  agentCompleted(event: WorkflowManifestAgentEndEvent): void {
    const timestamp = this.#now();
    const agent =
      this.findAgent(event, "running") ??
      this.findAgent(event, "queued") ??
      this.createImplicitAgent(event, timestamp);
    agent.status = "completed";
    agent.resultPreview = previewValue(event.result);
    agent.completedAt = timestamp;
    this.recountAgents();
    this.touch(timestamp);
  }

  agentFailed(event: WorkflowManifestAgentEndEvent): void {
    const timestamp = this.#now();
    const agent =
      this.findAgent(event, "running") ??
      this.findAgent(event, "queued") ??
      this.createImplicitAgent(event, timestamp);
    agent.status = "failed";
    agent.error = event.error ?? "Agent failed.";
    agent.completedAt = timestamp;
    this.recountAgents();
    this.touch(timestamp);
  }

  agentStopped(event: WorkflowManifestAgentEvent, reason: string): void {
    const timestamp = this.#now();
    const agent =
      this.findAgent(event, "running") ??
      this.findAgent(event, "queued") ??
      this.createImplicitAgent(event, timestamp);
    agent.status = "cancelled";
    agent.error = reason;
    agent.completedAt = timestamp;
    this.recountAgents();
    this.touch(timestamp);
  }

  updateEstimatedResultTokens(estimatedResultTokens: number): void {
    this.state.estimatedResultTokens = estimatedResultTokens;
    this.touch();
  }

  complete(input: {
    outputPath: string;
    result: unknown;
    durationMs?: number;
    estimatedResultTokens?: number;
  }): void {
    const timestamp = this.#now();
    this.state.status = "completed";
    this.state.outputPath = input.outputPath;
    this.state.resultPreview = previewValue(input.result);
    this.state.durationMs = input.durationMs ?? durationMs(this.state.startTime, timestamp);
    if (input.estimatedResultTokens !== undefined) {
      this.state.estimatedResultTokens = input.estimatedResultTokens;
    }
    for (const phase of this.state.phases) {
      if (phase.status === "running") {
        phase.status = "completed";
        phase.completedAt = timestamp;
      } else if (phase.status === "pending") {
        phase.status = "skipped";
      }
    }
    this.recountAgents();
    this.touch(timestamp);
  }

  fail(error: unknown, input: { outputPath?: string } = {}): void {
    const timestamp = this.#now();
    this.state.status = "failed";
    if (input.outputPath !== undefined) this.state.outputPath = input.outputPath;
    this.state.durationMs = durationMs(this.state.startTime, timestamp);
    this.state.failures.push({
      message: errorMessage(error),
      timestamp,
    });
    const message = errorMessage(error);
    for (const agent of this.state.agents) {
      if (agent.status === "queued" || agent.status === "running") {
        agent.status = "failed";
        agent.error = message;
        agent.completedAt = timestamp;
      }
    }
    for (const phase of this.state.phases) {
      if (phase.status === "running") {
        phase.status = "failed";
        phase.completedAt = timestamp;
      } else if (phase.status === "pending") {
        phase.status = "skipped";
      }
    }
    this.recountAgents();
    this.touch(timestamp);
  }

  cancel(reason: string, input: { outputPath?: string } = {}): void {
    const timestamp = this.#now();
    this.state.status = "cancelled";
    if (input.outputPath !== undefined) this.state.outputPath = input.outputPath;
    this.state.durationMs = durationMs(this.state.startTime, timestamp);
    for (const agent of this.state.agents) {
      if (agent.status === "queued" || agent.status === "running") {
        agent.status = "cancelled";
        agent.error = reason;
        agent.completedAt = timestamp;
      }
    }
    for (const phase of this.state.phases) {
      if (phase.status === "running" || phase.status === "pending") {
        phase.status = "cancelled";
        phase.completedAt = timestamp;
      }
    }
    this.recountAgents();
    this.touch(timestamp);
  }

  async flush(): Promise<void> {
    await this.#pendingWrite;
    if (this.#writeError) throw this.#writeError;
  }

  private findPhase(title: string) {
    return this.state.phases.find((phase) => phase.title === title);
  }

  private addPhase(title: string) {
    const phase = { title, status: "running" as const, startedAt: this.#now() };
    this.state.phases.push(phase);
    return phase;
  }

  private findAgent(
    event: WorkflowManifestAgentEvent,
    status: WorkflowRunAgentState["status"],
  ): WorkflowRunAgentState | undefined {
    const canonical = this.state.agents.find(
      (candidate) => candidate.id === event.runAgentId && candidate.status === status,
    );
    if (canonical !== undefined) return canonical;

    return this.findLegacyAgent(event, status);
  }

  private findLegacyAgent(
    event: WorkflowManifestAgentEvent,
    status: WorkflowRunAgentState["status"],
  ): WorkflowRunAgentState | undefined {
    return this.state.agents.find(
      (agent) =>
        agent.status === status &&
        agent.id === "" &&
        agent.label === event.label &&
        agent.promptPreview === previewText(event.prompt) &&
        agent.phase === event.phase,
    );
  }

  private createImplicitAgent(
    event: WorkflowManifestAgentEvent,
    timestamp: string,
  ): WorkflowRunAgentState {
    const agent: WorkflowRunAgentState = {
      id: event.runAgentId,
      label: event.label,
      ...(event.phase === undefined ? {} : { phase: event.phase }),
      status: "queued",
      promptPreview: previewText(event.prompt),
      queuedAt: timestamp,
    };
    this.state.agents.push(agent);
    return agent;
  }

  private recountAgents(): void {
    this.state.agentCount = this.state.agents.length;
    this.state.workflowProgress.queuedAgents = countAgents(this.state, "queued");
    this.state.workflowProgress.runningAgents = countAgents(this.state, "running");
    this.state.workflowProgress.completedAgents = countAgents(this.state, "completed");
    this.state.workflowProgress.failedAgents = countAgents(this.state, "failed");
  }

  private touch(timestamp = this.#now()): void {
    this.state.updatedAt = timestamp;
    this.enqueueWrite();
  }

  private enqueueWrite(): void {
    const snapshot = structuredClone(this.state);
    this.#pendingWrite = this.#pendingWrite.then(async () => {
      try {
        await this.#writer(snapshot);
      } catch (error) {
        this.#writeError ??= error;
      }
    });
  }
}

function countAgents(state: WorkflowRunState, status: WorkflowRunAgentState["status"]): number {
  return state.agents.filter((agent) => agent.status === status).length;
}

function previewText(text: string): string {
  return text.length <= PREVIEW_LIMIT ? text : `${text.slice(0, PREVIEW_LIMIT)}…`;
}

function previewValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  return previewText(text);
}

function durationMs(startTime: string, endTime: string): number | undefined {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
