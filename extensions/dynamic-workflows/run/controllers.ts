export type WorkflowAgentControllerRegistration = {
  runId: string;
  agentId: string;
  signal: AbortSignal;
  get stopReason(): string | undefined;
  stop(reason?: string): void;
  unregister(): void;
};

export type WorkflowRunControllerRegistration = {
  runId: string;
  signal: AbortSignal;
  get stopReason(): string | undefined;
  stop(reason?: string): void;
  registerAgent(agentId: string): WorkflowAgentControllerRegistration;
  trackCompletion(completion: Promise<void>): void;
  unregister(): void;
};

type AgentControllerRecord = {
  controller: AbortController;
  stopReason?: string;
};

type ControllerRecord = {
  controller: AbortController;
  stopReason?: string;
  agents: Map<string, AgentControllerRecord>;
  completions: Set<Promise<void>>;
  unregisterRequested: boolean;
};

export class WorkflowRunControllerRegistry {
  readonly #controllers = new Map<string, ControllerRecord>();
  readonly #completionRecords = new Map<string, ControllerRecord>();
  #shuttingDown = false;

  register(runId: string): WorkflowRunControllerRegistration {
    if (this.#shuttingDown) {
      throw new Error("workflow run controller registry is shutting down.");
    }
    if (this.#completionRecords.has(runId)) {
      throw new Error(`workflow run controller already registered: ${runId}`);
    }

    const record: ControllerRecord = {
      controller: new AbortController(),
      agents: new Map(),
      completions: new Set(),
      unregisterRequested: false,
    };
    this.#controllers.set(runId, record);
    this.#completionRecords.set(runId, record);

    return this.registration(runId, record);
  }

  get(runId: string): WorkflowRunControllerRegistration | undefined {
    const record = this.#controllers.get(runId);
    return record === undefined ? undefined : this.registration(runId, record);
  }

  registerAgent(runId: string, agentId: string): WorkflowAgentControllerRegistration {
    const run = this.#controllers.get(runId);
    if (run === undefined) throw new Error(`workflow run controller is not registered: ${runId}`);
    if (run.agents.has(agentId)) {
      throw new Error(`workflow agent controller already registered: ${runId}/${agentId}`);
    }

    const record: AgentControllerRecord = { controller: new AbortController() };
    run.agents.set(agentId, record);
    if (run.controller.signal.aborted) {
      const reason = run.stopReason ?? "workflow run stopped";
      record.stopReason = reason;
      record.controller.abort(reason);
    }
    return this.agentRegistration(runId, agentId, record);
  }

  getAgent(runId: string, agentId: string): WorkflowAgentControllerRegistration | undefined {
    const record = this.#controllers.get(runId)?.agents.get(agentId);
    return record === undefined ? undefined : this.agentRegistration(runId, agentId, record);
  }

  stop(runId: string, reason = "workflow run stopped"): boolean {
    const record = this.#controllers.get(runId);
    if (!record) return false;
    if (!record.controller.signal.aborted) {
      record.stopReason = reason;
      record.controller.abort(reason);
    }
    const effectiveReason = record.stopReason ?? reason;
    for (const agent of record.agents.values()) {
      if (agent.controller.signal.aborted) continue;
      agent.stopReason = effectiveReason;
      agent.controller.abort(effectiveReason);
    }
    return true;
  }

  stopAgent(runId: string, agentId: string, reason = "workflow agent stopped"): boolean {
    const record = this.#controllers.get(runId)?.agents.get(agentId);
    if (!record) return false;
    if (!record.controller.signal.aborted) {
      record.stopReason = reason;
      record.controller.abort(reason);
    }
    return true;
  }

  trackCompletion(runId: string, completion: Promise<void>): boolean {
    const record = this.#completionRecords.get(runId);
    if (!record) return false;

    let tracked!: Promise<void>;
    tracked = completion
      .catch(() => undefined)
      .finally(() => {
        record.completions.delete(tracked);
        this.deleteIfSettled(runId, record);
      });
    record.completions.add(tracked);
    return true;
  }

  async waitForRunCompletions(runIds: string[]): Promise<void> {
    const records = runIds
      .map((runId) => this.#completionRecords.get(runId))
      .filter((record): record is ControllerRecord => record !== undefined);
    await Promise.all(records.map((record) => this.waitForRecordCompletions(record)));
  }

  async shutdown(reasonForRun: (runId: string) => string): Promise<void> {
    this.#shuttingDown = true;
    const activeRunIds = this.activeRunIds();
    const trackedRunIds = [...this.#completionRecords.keys()];
    for (const runId of activeRunIds) this.stop(runId, reasonForRun(runId));
    await this.waitForRunCompletions(trackedRunIds);
  }

  unregister(runId: string): boolean {
    const record = this.#controllers.get(runId);
    if (record === undefined) return false;
    record.unregisterRequested = true;
    this.#controllers.delete(runId);
    this.deleteIfSettled(runId, record);
    return true;
  }

  unregisterAgent(runId: string, agentId: string): boolean {
    return this.#controllers.get(runId)?.agents.delete(agentId) ?? false;
  }

  activeRunIds(): string[] {
    return [...this.#controllers.keys()];
  }

  activeAgentIds(runId: string): string[] {
    return [...(this.#controllers.get(runId)?.agents.keys() ?? [])];
  }

  private async waitForRecordCompletions(record: ControllerRecord): Promise<void> {
    while (record.completions.size > 0) {
      await Promise.allSettled([...record.completions]);
    }
  }

  private deleteIfSettled(runId: string, record: ControllerRecord): void {
    if (record.unregisterRequested && record.completions.size === 0) {
      this.#completionRecords.delete(runId);
    }
  }

  private registration(runId: string, record: ControllerRecord): WorkflowRunControllerRegistration {
    return {
      runId,
      signal: record.controller.signal,
      get stopReason() {
        return record.stopReason;
      },
      stop: (reason?: string) => this.stop(runId, reason),
      registerAgent: (agentId: string) => this.registerAgent(runId, agentId),
      trackCompletion: (completion: Promise<void>) => {
        this.trackCompletion(runId, completion);
      },
      unregister: () => {
        this.unregister(runId);
      },
    };
  }

  private agentRegistration(
    runId: string,
    agentId: string,
    record: AgentControllerRecord,
  ): WorkflowAgentControllerRegistration {
    return {
      runId,
      agentId,
      signal: record.controller.signal,
      get stopReason() {
        return record.stopReason;
      },
      stop: (reason?: string) => this.stopAgent(runId, agentId, reason),
      unregister: () => {
        this.unregisterAgent(runId, agentId);
      },
    };
  }
}
