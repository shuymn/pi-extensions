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
  completion?: Promise<void>;
};

export class WorkflowRunControllerRegistry {
  readonly #controllers = new Map<string, ControllerRecord>();

  register(runId: string): WorkflowRunControllerRegistration {
    if (this.#controllers.has(runId)) {
      throw new Error(`workflow run controller already registered: ${runId}`);
    }

    const record: ControllerRecord = {
      controller: new AbortController(),
      agents: new Map(),
    };
    this.#controllers.set(runId, record);

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
    return this.agentRegistration(runId, agentId, record);
  }

  getAgent(runId: string, agentId: string): WorkflowAgentControllerRegistration | undefined {
    const record = this.#controllers.get(runId)?.agents.get(agentId);
    return record === undefined ? undefined : this.agentRegistration(runId, agentId, record);
  }

  stop(runId: string, reason = "workflow run stopped"): boolean {
    const record = this.#controllers.get(runId);
    if (!record) return false;
    record.stopReason = reason;
    record.controller.abort(reason);
    for (const agent of record.agents.values()) {
      agent.stopReason ??= reason;
      agent.controller.abort(reason);
    }
    return true;
  }

  stopAgent(runId: string, agentId: string, reason = "workflow agent stopped"): boolean {
    const record = this.#controllers.get(runId)?.agents.get(agentId);
    if (!record) return false;
    record.stopReason = reason;
    record.controller.abort(reason);
    return true;
  }

  trackCompletion(runId: string, completion: Promise<void>): boolean {
    const record = this.#controllers.get(runId);
    if (!record) return false;

    const tracked = completion
      .catch(() => undefined)
      .finally(() => {
        if (record.completion === tracked) record.completion = undefined;
      });
    record.completion = tracked;
    return true;
  }

  async waitForRunCompletions(runIds: string[]): Promise<void> {
    const completions = runIds
      .map((runId) => this.#controllers.get(runId)?.completion)
      .filter((completion): completion is Promise<void> => completion !== undefined);
    await Promise.allSettled(completions);
  }

  unregister(runId: string): boolean {
    return this.#controllers.delete(runId);
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
        this.#controllers.delete(runId);
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
