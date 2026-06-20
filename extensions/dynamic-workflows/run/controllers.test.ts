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

  test("refuses duplicate run registrations", () => {
    const registry = new WorkflowRunControllerRegistry();
    registry.register("wf_controller_12345678");

    expect(() => registry.register("wf_controller_12345678")).toThrow(
      "workflow run controller already registered",
    );
  });
});
