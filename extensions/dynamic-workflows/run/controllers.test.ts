import { describe, expect, test } from "bun:test";
import { WorkflowRunControllerRegistry } from "./controllers";

describe("workflow run controller registry", () => {
  test("registers, stops, and unregisters background workflow controllers", () => {
    const registry = new WorkflowRunControllerRegistry();
    const registration = registry.register("wf_controller_12345678");

    expect(registry.activeRunIds()).toEqual(["wf_controller_12345678"]);
    expect(registry.get("wf_controller_12345678")?.signal.aborted).toBe(false);

    expect(registry.stop("wf_controller_12345678", "user requested stop")).toBe(true);
    expect(registration.signal.aborted).toBe(true);
    expect(registration.stopReason).toBe("user requested stop");
    expect(registry.stop("missing", "noop")).toBe(false);

    registration.unregister();
    expect(registry.activeRunIds()).toEqual([]);
  });

  test("registers and stops agent controllers without stopping the whole run", () => {
    const registry = new WorkflowRunControllerRegistry();
    const registration = registry.register("wf_controller_12345678");
    const agent = registration.registerAgent("agent_1");

    expect(registry.activeAgentIds("wf_controller_12345678")).toEqual(["agent_1"]);
    expect(registry.getAgent("wf_controller_12345678", "agent_1")?.signal.aborted).toBe(false);

    expect(registry.stopAgent("wf_controller_12345678", "agent_1", "stop only this agent")).toBe(
      true,
    );
    expect(agent.signal.aborted).toBe(true);
    expect(agent.stopReason).toBe("stop only this agent");
    expect(registration.signal.aborted).toBe(false);
    expect(registry.stopAgent("wf_controller_12345678", "missing", "noop")).toBe(false);

    agent.unregister();
    expect(registry.activeAgentIds("wf_controller_12345678")).toEqual([]);
  });

  test("preserves the first stop reason and immediately stops agents registered later", () => {
    const registry = new WorkflowRunControllerRegistry();
    const run = registry.register("wf_first_stop_12345678");
    const alreadyStoppedAgent = run.registerAgent("agent_1");

    alreadyStoppedAgent.stop("agent stopped first");
    run.stop("run stopped first");
    run.stop("later run stop");
    alreadyStoppedAgent.stop("later agent stop");
    const lateAgent = run.registerAgent("agent_2");

    expect(run.stopReason).toBe("run stopped first");
    expect(run.signal.reason).toBe("run stopped first");
    expect(alreadyStoppedAgent.stopReason).toBe("agent stopped first");
    expect(alreadyStoppedAgent.signal.reason).toBe("agent stopped first");
    expect(lateAgent.signal.aborted).toBe(true);
    expect(lateAgent.stopReason).toBe("run stopped first");
    expect(lateAgent.signal.reason).toBe("run stopped first");
  });

  test("waits for tracked completion even when the controller unregisters first", async () => {
    const registry = new WorkflowRunControllerRegistry();
    const run = registry.register("wf_unregister_race_12345678");
    let settle!: () => void;
    run.trackCompletion(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );

    run.unregister();
    expect(registry.activeRunIds()).toEqual([]);
    let waitSettled = false;
    const wait = registry.waitForRunCompletions(["wf_unregister_race_12345678"]).then(() => {
      waitSettled = true;
    });
    await Promise.resolve();
    expect(waitSettled).toBe(false);

    settle();
    await wait;
    expect(waitSettled).toBe(true);
  });

  test("shutdown also waits for tracked work whose controller already unregistered", async () => {
    const registry = new WorkflowRunControllerRegistry();
    const run = registry.register("wf_shutdown_unregister_12345678");
    let settle!: () => void;
    run.trackCompletion(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    run.unregister();

    let shutdownSettled = false;
    const shutdown = registry
      .shutdown((runId) => `shutdown: ${runId}`)
      .then(() => {
        shutdownSettled = true;
      });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    settle();
    await shutdown;
    expect(shutdownSettled).toBe(true);
  });

  test("shutdown stops its active snapshot, waits for it, and rejects new registrations", async () => {
    const registry = new WorkflowRunControllerRegistry();
    const run = registry.register("wf_shutdown_12345678");
    let settle!: () => void;
    run.trackCompletion(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );

    const shutdown = registry.shutdown((runId) => `shutdown: ${runId}`);
    expect(run.signal.aborted).toBe(true);
    expect(run.stopReason).toBe("shutdown: wf_shutdown_12345678");
    expect(() => registry.register("wf_late_12345678")).toThrow("shutting down");

    run.unregister();
    settle();
    await shutdown;
  });

  test("refuses duplicate run registrations", () => {
    const registry = new WorkflowRunControllerRegistry();
    registry.register("wf_controller_12345678");

    expect(() => registry.register("wf_controller_12345678")).toThrow(
      "workflow run controller already registered",
    );
  });
});
