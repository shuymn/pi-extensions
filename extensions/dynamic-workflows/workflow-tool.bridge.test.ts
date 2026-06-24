import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowRunControllerRegistry } from "./run/controllers";
import {
  loadWorkflowToolModule,
  tempCwd,
  tempDir,
  waitUntil,
  writeWorkflowFile,
} from "./workflow-tool.test-support";

describe("dynamic workflow launch bridge", () => {
  test("launches a packaged workflow by name from an extension root and notifies on completion", async () => {
    const { createWorkflowLaunchBridge } = await loadWorkflowToolModule();
    const cwd = tempCwd();
    const workflowRoot = join(cwd, ".pi", "workflows");
    const extensionRoot = tempDir("pi-workflow-tool-ext-");
    const packagedScript = `
      export const meta = {
        name: "research_flow",
        description: "Packaged research preset",
        phases: [{ title: "Frame" }],
      };
      return await agent("frame " + args.topic, { label: "frame" });
    `;
    writeWorkflowFile(extensionRoot, "research-flow.js", packagedScript);

    const calls: string[] = [];
    const backgroundTasks: Array<() => Promise<void>> = [];
    const notifications: unknown[] = [];
    const bridge = createWorkflowLaunchBridge({
      workflowRoot,
      cwd,
      runIdFactory: () => "wf_bridge_packaged_12345678",
      taskIdFactory: () => "task_bridge_packaged_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      completionNotifier: (notification) => notifications.push(notification),
      additionalWorkflowRoots: [{ path: extensionRoot, source: "extension" }],
      agent: (prompt) => {
        calls.push(prompt);
        return prompt;
      },
    });

    const result = await bridge({ name: "research_flow", args: { topic: "pi" } }, { cwd } as never);

    const runDir = join(workflowRoot, "wf_bridge_packaged_12345678");
    expect(result).toMatchObject({
      runId: "wf_bridge_packaged_12345678",
      taskId: "task_bridge_packaged_12345678",
      workflowName: "research_flow",
      artifactDir: runDir,
      outputPath: join(runDir, "output.json"),
    });
    // The bridge result mirrors the LLM Tool details for the same launch.
    expect(result.details).toMatchObject({
      status: "launched",
      runId: result.runId,
      taskId: result.taskId,
      workflowName: "research_flow",
      description: "Packaged research preset",
      artifactDir: result.artifactDir,
      phases: ["Frame"],
      agentCount: 0,
    });
    // Provenance preservation: a by-name launch resolves the packaged script.
    expect(readFileSync(join(runDir, "script.js"), "utf8")).toBe(packagedScript);

    await backgroundTasks[0]!();

    expect(calls).toEqual(["frame pi"]);
    expect(notifications).toEqual([
      expect.objectContaining({
        runId: "wf_bridge_packaged_12345678",
        taskId: "task_bridge_packaged_12345678",
        workflowName: "research_flow",
        status: "completed",
        artifactDir: runDir,
        outputPath: join(runDir, "output.json"),
      }),
    ]);
  });

  test("rejects when the workflow name cannot be resolved", async () => {
    const { createWorkflowLaunchBridge } = await loadWorkflowToolModule();
    const cwd = tempCwd();
    const workflowRoot = join(cwd, ".pi", "workflows");
    const backgroundTasks: Array<() => Promise<void>> = [];
    const bridge = createWorkflowLaunchBridge({
      workflowRoot,
      cwd,
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agent: () => "unused",
    });

    await expect(bridge({ name: "missing_flow" }, { cwd } as never)).rejects.toThrow();
    expect(backgroundTasks).toEqual([]);
    expect(existsSync(workflowRoot)).toBe(false);
  });

  test("rejects an already-aborted launch without creating a run", async () => {
    const { launchWorkflowRun } = await loadWorkflowToolModule();
    const cwd = tempCwd();
    const workflowRoot = join(cwd, ".pi", "workflows");
    const controller = new AbortController();
    controller.abort();
    const backgroundTasks: Array<() => Promise<void>> = [];

    await expect(
      launchWorkflowRun(
        {
          workflowRoot,
          cwd,
          backgroundScheduler: (task) => backgroundTasks.push(task),
          agent: () => "unused",
        },
        { cwd } as never,
        {
          script: `
            export const meta = { name: "aborts", phases: [{ title: "Run" }] };
            return await agent("work");
          `,
        },
        controller.signal,
      ),
    ).rejects.toThrow("workflow launch was aborted.");
    expect(backgroundTasks).toEqual([]);
    expect(existsSync(workflowRoot)).toBe(false);
  });

  test("shares the controller registry so a launched run can be cancelled mid-flight", async () => {
    const { createWorkflowLaunchBridge } = await loadWorkflowToolModule();
    const cwd = tempCwd();
    const workflowRoot = join(cwd, ".pi", "workflows");
    const registry = new WorkflowRunControllerRegistry();
    const backgroundTasks: Array<() => Promise<void>> = [];
    let agentSignal: AbortSignal | undefined;
    const bridge = createWorkflowLaunchBridge({
      workflowRoot,
      cwd,
      controllerRegistry: registry,
      runIdFactory: () => "wf_bridge_cancel_12345678",
      taskIdFactory: () => "task_bridge_cancel_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agent: (_prompt, options) => {
        agentSignal = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("agent saw abort")), {
            once: true,
          });
        });
      },
    });

    await bridge(
      {
        script: `
          export const meta = { name: "bridge_cancel", phases: [{ title: "Run" }] };
          phase("Run");
          return await agent("slow work", { label: "slow" });
        `,
      },
      { cwd } as never,
    );

    expect(registry.activeRunIds()).toEqual(["wf_bridge_cancel_12345678"]);
    const running = backgroundTasks[0]!();
    await waitUntil(() => agentSignal !== undefined);

    expect(registry.stop("wf_bridge_cancel_12345678", "user requested stop")).toBe(true);
    await running;

    expect(agentSignal?.aborted).toBe(true);
    expect(registry.activeRunIds()).toEqual([]);
    const runDir = join(workflowRoot, "wf_bridge_cancel_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "cancelled",
      runId: "wf_bridge_cancel_12345678",
      reason: "user requested stop",
    });
  });
});
