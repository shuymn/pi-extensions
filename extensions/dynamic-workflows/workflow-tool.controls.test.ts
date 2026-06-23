import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeUi } from "../../tests/support/fake-ui";
import { WorkflowRunControllerRegistry } from "./run/controllers";
import { DYNAMIC_WORKFLOW_WIDGET_KEY } from "./ui/workflow-widget";
import {
  loadWorkflowToolModule,
  readJournalLines,
  tempWorkflowRoot,
  waitUntil,
} from "./workflow-tool.test-support";

describe("dynamic workflow tool controls", () => {
  test("updates an aboveEditor active workflow widget during background execution", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const ui = createFakeUi();
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_widget_12345678",
      taskIdFactory: () => "task_widget_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agent: () => "ok",
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "widget_smoke",
            phases: [{ title: "Run" }],
          };
          phase("Run");
          log("started");
          return await agent("work", { label: "worker" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo", ui } as never,
    );

    expect(ui.widgets.at(-1)).toMatchObject({
      key: DYNAMIC_WORKFLOW_WIDGET_KEY,
      lines: expect.arrayContaining([expect.stringContaining("待機中")]),
      options: { placement: "aboveEditor" },
    });

    await backgroundTasks[0]!();

    expect(
      ui.widgets.some(
        (widget) =>
          Array.isArray(widget.lines) && widget.lines.some((line) => line.includes("実行中")),
      ),
    ).toBe(true);
    expect(ui.widgets.at(-1)).toMatchObject({
      key: DYNAMIC_WORKFLOW_WIDGET_KEY,
      lines: undefined,
    });
  });

  test("aborts launch before scheduling background work when the parent signal is already aborted", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const controller = new AbortController();
    controller.abort();
    const tool = createWorkflowTool({
      workflowRoot,
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agent: () => "unused",
    });

    await expect(
      tool.execute(
        "call",
        {
          script: `
            export const meta = {
              name: "abort_before_launch",
              phases: [{ title: "Run" }],
            };
            return await agent("work");
          `,
        },
        controller.signal,
        undefined,
        { cwd: "/repo" } as never,
      ),
    ).rejects.toThrow("aborted");

    expect(backgroundTasks).toEqual([]);
    expect(existsSync(workflowRoot)).toBe(false);
  });

  test("does not rethrow internally reported background task errors", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const controller = new AbortController();
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_internal_error_12345678",
      taskIdFactory: () => "task_internal_error_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      controllerRegistry: {
        register: (runId: string) => ({
          runId,
          signal: controller.signal,
          get stopReason() {
            return undefined;
          },
          stop: (reason?: string) => controller.abort(reason),
          registerAgent: (agentId: string) => ({
            runId,
            agentId,
            signal: new AbortController().signal,
            get stopReason() {
              return undefined;
            },
            stop: () => undefined,
            unregister: () => undefined,
          }),
          trackCompletion: (completion: Promise<void>) => {
            void completion.catch(() => undefined);
          },
          unregister: () => {
            throw new Error("unregister failed");
          },
        }),
      } as never,
      agent: () => "ok",
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "internal_error_smoke",
            phases: [{ title: "Run" }],
          };
          return await agent("work", { label: "worker" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    await expect(backgroundTasks[0]!()).resolves.toBeUndefined();
  });

  test("exposes a background stop seam that cancels a running workflow", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const registry = new WorkflowRunControllerRegistry();
    const backgroundTasks: Array<() => Promise<void>> = [];
    let agentSignal: AbortSignal | undefined;
    let nextJournalAgentId = 0;
    const tool = createWorkflowTool({
      workflowRoot,
      controllerRegistry: registry,
      runIdFactory: () => "wf_cancel_12345678",
      taskIdFactory: () => "task_cancel_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      journalAgentIdFactory: () => {
        nextJournalAgentId += 1;
        return `journal-agent-${nextJournalAgentId}`;
      },
      agent: (_prompt, options) => {
        agentSignal = options.signal;
        return new Promise((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new Error("agent saw abort"));
            return;
          }
          options.signal?.addEventListener("abort", () => reject(new Error("agent saw abort")), {
            once: true,
          });
        });
      },
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "cancel_smoke",
            phases: [{ title: "Run" }],
          };
          phase("Run");
          return await agent("slow work", { label: "slow" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    expect(registry.activeRunIds()).toEqual(["wf_cancel_12345678"]);
    const running = backgroundTasks[0]!();
    await waitUntil(() => agentSignal !== undefined);

    expect(registry.stop("wf_cancel_12345678", "user requested stop")).toBe(true);
    await running;

    expect(agentSignal?.aborted).toBe(true);
    expect(registry.activeRunIds()).toEqual([]);
    const runDir = join(workflowRoot, "wf_cancel_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "cancelled",
      runId: "wf_cancel_12345678",
      reason: "user requested stop",
    });
    expect(JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "cancelled",
      phases: [{ title: "Run", status: "cancelled" }],
      agents: [{ label: "slow", status: "cancelled", error: "user requested stop" }],
    });
    const journalEvents = readJournalLines(join(runDir, "journal.jsonl"));
    expect(journalEvents[0]?.key).toBe(journalEvents[1]?.key);
    expect(journalEvents).toEqual([
      { type: "started", key: expect.stringMatching(/^v1:/), agentId: "journal-agent-1" },
      {
        type: "stopped",
        key: expect.stringMatching(/^v1:/),
        agentId: "journal-agent-1",
        reason: "user requested stop",
      },
    ]);
  });
});
