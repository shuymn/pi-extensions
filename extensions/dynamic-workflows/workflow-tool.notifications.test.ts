import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadWorkflowToolModule,
  readJournalLines,
  tempWorkflowRoot,
} from "./workflow-tool.test-support";

describe("dynamic workflow tool notifications", () => {
  test("notifies branch-failure completion as completed with null result", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const notifications: unknown[] = [];
    const lifecycleNotifications: unknown[] = [];
    const terminalCallbackOrder: string[] = [];
    let nextJournalAgentId = 0;
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_fail_12345678",
      taskIdFactory: () => "task_fail_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      completionNotifier: (notification) => {
        terminalCallbackOrder.push("completion");
        notifications.push(notification);
      },
      lifecycleNotifier: (notification) => {
        if (notification.status !== "started") terminalCallbackOrder.push("lifecycle");
        lifecycleNotifications.push(notification);
      },
      journalAgentIdFactory: () => {
        nextJournalAgentId += 1;
        return `journal-agent-${nextJournalAgentId}`;
      },
      agent: () => {
        throw new Error("agent failed loudly");
      },
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "fail_smoke",
            phases: [{ title: "Run" }],
          };
          return await agent("fail", { label: "bad" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    expect(lifecycleNotifications).toEqual([
      expect.objectContaining({
        runId: "wf_fail_12345678",
        workflowName: "fail_smoke",
        status: "started",
      }),
    ]);

    await backgroundTasks[0]!();

    const runDir = join(workflowRoot, "wf_fail_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "completed",
      result: null,
      logs: ["agent bad failed: agent failed loudly"],
    });
    const journalEvents = readJournalLines(join(runDir, "journal.jsonl"));
    expect(journalEvents[0]?.key).toBe(journalEvents[1]?.key);
    expect(journalEvents).toEqual([
      { type: "started", key: expect.stringMatching(/^v1:/), agentId: "journal-agent-1" },
      {
        type: "failed",
        key: expect.stringMatching(/^v1:/),
        agentId: "journal-agent-1",
        error: { message: "agent failed loudly" },
      },
    ]);
    expect(notifications).toEqual([
      expect.objectContaining({
        runId: "wf_fail_12345678",
        taskId: "task_fail_12345678",
        workflowName: "fail_smoke",
        status: "completed",
        outputPath: join(runDir, "output.json"),
        resultPreview: "null",
        usage: expect.objectContaining({
          agentCount: 1,
          estimatedResultTokens: expect.any(Number),
        }),
      }),
    ]);
    expect(lifecycleNotifications).toEqual([
      expect.objectContaining({ status: "started", workflowName: "fail_smoke" }),
      expect.objectContaining({ status: "completed", workflowName: "fail_smoke" }),
    ]);
    expect(terminalCallbackOrder).toEqual(["lifecycle", "completion"]);
  });

  test("keeps completed terminal status visible when journal flush fails", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const notifications: unknown[] = [];
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_journal_flush_12345678",
      taskIdFactory: () => "task_journal_flush_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      completionNotifier: (notification) => notifications.push(notification),
      agent: () => undefined,
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "journal_flush_smoke",
            phases: [{ title: "Run" }],
          };
          return await agent("undefined result", { label: "undefined" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    await expect(backgroundTasks[0]!()).resolves.toBeUndefined();

    const runDir = join(workflowRoot, "wf_journal_flush_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "completed",
      runId: "wf_journal_flush_12345678",
    });
    expect(JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "completed",
      logs: ["journal persistence failed: workflow journal event must be JSON-serializable."],
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        runId: "wf_journal_flush_12345678",
        taskId: "task_journal_flush_12345678",
        workflowName: "journal_flush_smoke",
        status: "completed",
        outputPath: join(runDir, "output.json"),
        usage: expect.objectContaining({
          agentCount: 1,
          estimatedResultTokens: expect.any(Number),
        }),
      }),
    ]);
  });

  test("notifies terminal failed background workflow completion with output path and error", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const notifications: unknown[] = [];
    const tool = createWorkflowTool({
      workflowRoot,
      maxTotalAgents: 1,
      runIdFactory: () => "wf_hard_fail_12345678",
      taskIdFactory: () => "task_hard_fail_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      completionNotifier: (notification) => notifications.push(notification),
      agent: () => "ok",
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "hard_fail_smoke",
            phases: [{ title: "Run" }],
          };
          phase("Run");
          await agent("one", { label: "one" });
          return await agent("two", { label: "two" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    await backgroundTasks[0]!();

    const runDir = join(workflowRoot, "wf_hard_fail_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "failed",
      runId: "wf_hard_fail_12345678",
      error: expect.stringContaining("max total agents"),
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        runId: "wf_hard_fail_12345678",
        taskId: "task_hard_fail_12345678",
        workflowName: "hard_fail_smoke",
        status: "failed",
        outputPath: join(runDir, "output.json"),
        error: expect.stringContaining("max total agents"),
        usage: expect.objectContaining({
          agentCount: 1,
          estimatedResultTokens: expect.any(Number),
        }),
      }),
    ]);
  });

  test("keeps budget-exceeded failure usage aligned with estimated result tokens", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const notifications: unknown[] = [];
    const tool = createWorkflowTool({
      workflowRoot,
      tokenBudget: 1,
      runIdFactory: () => "wf_budget_fail_12345678",
      taskIdFactory: () => "task_budget_fail_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      completionNotifier: (notification) => notifications.push(notification),
      agent: () => "abcd",
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "budget_fail_smoke",
            phases: [{ title: "Run" }],
          };
          return await agent("too large", { label: "large" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    await backgroundTasks[0]!();

    const runDir = join(workflowRoot, "wf_budget_fail_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "failed",
      estimatedResultTokens: 2,
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        runId: "wf_budget_fail_12345678",
        taskId: "task_budget_fail_12345678",
        workflowName: "budget_fail_smoke",
        status: "failed",
        error: expect.stringContaining("estimated result-token budget"),
        usage: expect.objectContaining({
          agentCount: 1,
          estimatedResultTokens: 2,
        }),
      }),
    ]);
  });

  test("creates a Japanese completion message via pi.sendMessage", async () => {
    const { createWorkflowCompletionNotifier } = await loadWorkflowToolModule();
    const sentMessages: unknown[] = [];
    const notifier = createWorkflowCompletionNotifier({
      sendMessage(message: unknown, options: unknown) {
        sentMessages.push({ message, options });
      },
    } as never);

    notifier({
      runId: "wf_notify_12345678",
      taskId: "task_notify_12345678",
      workflowName: "notify_smoke",
      status: "completed",
      artifactDir: "/repo/.pi/workflows/wf_notify_12345678",
      outputPath: "/repo/.pi/workflows/wf_notify_12345678/output.json",
      resultPreview: '{"ok":true}',
      usage: { agentCount: 2, estimatedResultTokens: 42, durationMs: 1000 },
    });

    expect(sentMessages).toEqual([
      {
        message: {
          customType: "dynamic-workflow-completion",
          display: true,
          content: expect.stringContaining("ワークフロー「notify_smoke」が完了しました"),
          details: expect.objectContaining({
            runId: "wf_notify_12345678",
            outputPath: "/repo/.pi/workflows/wf_notify_12345678/output.json",
            usage: { agentCount: 2, estimatedResultTokens: 42, durationMs: 1000 },
          }),
        },
        options: { triggerTurn: true, deliverAs: "followUp" },
      },
    ]);
  });

  test("rejects workflow scripts that never call agent", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const tool = createWorkflowTool({ agent: () => "unused" });

    await expect(
      tool.execute(
        "call",
        {
          script: `
            export const meta = {
              name: "no_agent",
              description: "Invalid workflow",
              phases: [{ title: "Run" }],
            };
            phase("Run");
            return { ok: true };
          `,
        },
        undefined,
        undefined,
        { cwd: "/repo" } as never,
      ),
    ).rejects.toThrow("must call agent");
  });
});
