import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeUi } from "../../../tests/support/fake-ui";
import { WorkflowRunControllerRegistry } from "../run/controllers";
import { createInitialWorkflowRunState, type WorkflowRunState } from "../run/model";
import { WorkflowRunStore } from "../run/store";
import { registerWorkflowsCommand } from "./workflows-command";
import { createWorkflowControllerMonitorControlSeams } from "./workflows-controls";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

const tempDirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-command-"));
  tempDirs.push(dir);
  return dir;
}

function createPi(options: Parameters<typeof registerWorkflowsCommand>[1] = {}) {
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    commands,
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
  };
  registerWorkflowsCommand(pi as never, options);
  return pi;
}

async function writeRun(
  cwd: string,
  input: {
    runId: string;
    workflowName: string;
    status: WorkflowRunState["status"];
    sessionId?: string;
    updatedAt: string;
    agents?: WorkflowRunState["agents"];
  },
): Promise<WorkflowRunState> {
  const root = join(cwd, ".pi", "workflows");
  const store = new WorkflowRunStore(root);
  const state = createInitialWorkflowRunState({
    runId: input.runId,
    taskId: `task_${input.runId}`,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    cwd,
    workflowName: input.workflowName,
    phases: [{ title: "Run" }],
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = input.status;
  state.updatedAt = input.updatedAt;
  state.workflowProgress.currentPhase = input.status === "running" ? "Run" : undefined;
  state.agentCount = input.agents?.length ?? 2;
  state.workflowProgress.runningAgents = input.status === "running" ? 1 : 0;
  state.workflowProgress.completedAgents = input.status === "completed" ? 2 : 1;
  state.workflowProgress.failedAgents = input.status === "failed" ? 1 : 0;
  if (input.agents !== undefined) state.agents = input.agents;
  state.totalTokens = 123;
  state.totalToolCalls = 4;
  if (input.status === "completed") {
    state.outputPath = join(root, input.runId, "output.json");
    state.resultPreview = '{"ok":true}';
  }

  await store.createRun({ state, script: "export const meta = {};" });
  await store.writeManifest(state);
  return state;
}

function writeTranscript(
  cwd: string,
  runId: string,
  fileName: string,
  metadata: Record<string, unknown>,
): void {
  const transcriptsDir = join(cwd, ".pi", "workflows", runId, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  writeFileSync(
    join(transcriptsDir, fileName),
    `${JSON.stringify({ schemaVersion: 1, metadata, messages: [] }, null, 2)}\n`,
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("/workflows command", () => {
  test("opens the overview directly when one workflow manifest is visible in TUI mode", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_ui_12345678",
      workflowName: "ui_smoke",
      status: "running",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });
    const pi = createPi();
    const ui = createFakeUi({ customs: [null] });

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(ui.notifications).toEqual([]);
    expect(ui.customCalls).toHaveLength(1);
    expect(ui.customCalls[0]!.args[1]).toEqual({
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
    });
  });

  test("opens agent detail and full prompt reader when requested", async () => {
    const cwd = tempCwd();
    const runId = "wf_detail_12345678";
    await writeRun(cwd, {
      runId,
      workflowName: "detail_smoke",
      status: "running",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
      agents: [
        {
          id: "agent_1",
          label: "inventory",
          phase: "Run",
          status: "completed",
          promptPreview: "manifest preview",
          queuedAt: "2026-06-19T00:00:01.000Z",
          startedAt: "2026-06-19T00:00:02.000Z",
          completedAt: "2026-06-19T00:00:03.000Z",
        },
      ],
    });
    writeTranscript(cwd, runId, "0001-inventory.json", {
      transcriptId: "0001-inventory",
      runId,
      prompt: "Full original prompt from transcript",
    });
    const pi = createPi();
    const ui = createFakeUi({
      customs: [
        { type: "openAgentDetail", agentId: "agent_1" },
        { type: "openPromptReader", agentId: "agent_1" },
        null,
      ],
    });

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(ui.notifications).toEqual([]);
    expect(ui.customCalls).toHaveLength(3);
    expect(ui.customCalls[0]!.args[1]).toEqual({
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
    });
    expect(ui.customCalls[1]!.args[1]).toEqual({
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
    });
    expect(ui.customCalls[2]!.args[1]).toEqual({
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
    });

    const promptReaderFactory = ui.customCalls[2]!.args[0] as (
      tui: { requestRender(): void },
      theme: { fg(name: string, text: string): string; bold(text: string): string },
      keybindings: { matches(data: string, id: string): boolean },
      done: (value: null) => void,
    ) => { render(width: number): string[] };
    const component = promptReaderFactory(
      { requestRender() {} },
      { fg: (_name, text) => text, bold: (text) => text },
      { matches: () => false },
      () => {},
    );
    expect(component.render(80).join("\n")).toContain("Full original prompt from transcript");
  });

  test("opens a custom TUI chooser then overview when multiple workflow manifests are visible", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_first_12345678",
      workflowName: "first_smoke",
      status: "running",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });
    await writeRun(cwd, {
      runId: "wf_second_12345678",
      workflowName: "second_smoke",
      status: "completed",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:03.000Z",
    });
    const pi = createPi();
    const ui = createFakeUi({ customs: ["wf_second_12345678", null] });

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(ui.notifications).toEqual([]);
    expect(ui.customCalls).toHaveLength(2);
    expect(ui.customCalls[0]!.args[1]).toEqual({
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
    });
    expect(ui.customCalls[1]!.args[1]).toEqual({
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
    });
  });

  test("notifies when the default monitor control seam is disabled", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_control_12345678",
      workflowName: "control_smoke",
      status: "running",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });
    const pi = createPi();
    const ui = createFakeUi({
      customs: [
        { type: "controlAction", action: { type: "stopRun", runId: "wf_control_12345678" } },
      ],
    });

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(ui.notifications).toEqual([
      {
        level: "warning",
        message: "/workflows: 操作「run停止」はまだ接続されていません。",
      },
    ]);
    expect(ui.customCalls).toHaveLength(1);
  });

  test("stops an active run through controller-backed monitor controls", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_stop_run_12345678",
      workflowName: "stop_run_smoke",
      status: "running",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });
    const registry = new WorkflowRunControllerRegistry();
    const registration = registry.register("wf_stop_run_12345678");
    const pi = createPi({ controls: createWorkflowControllerMonitorControlSeams(registry) });
    const ui = createFakeUi({
      customs: [
        { type: "controlAction", action: { type: "stopRun", runId: "wf_stop_run_12345678" } },
      ],
    });

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(registration.signal.aborted).toBe(true);
    expect(registration.stopReason).toContain("run停止");
    expect(ui.notifications).toEqual([
      { level: "info", message: "/workflows: run wf_stop_run_12345678 を停止しました。" },
    ]);
  });

  test("stops an active agent through controller-backed monitor controls", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_stop_agent_12345678",
      workflowName: "stop_agent_smoke",
      status: "running",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
      agents: [
        {
          id: "agent_1",
          label: "inventory",
          phase: "Run",
          status: "running",
          promptPreview: "manifest preview",
          queuedAt: "2026-06-19T00:00:01.000Z",
          startedAt: "2026-06-19T00:00:02.000Z",
        },
      ],
    });
    const registry = new WorkflowRunControllerRegistry();
    const registration = registry.register("wf_stop_agent_12345678");
    const agent = registration.registerAgent("agent_1");
    const pi = createPi({ controls: createWorkflowControllerMonitorControlSeams(registry) });
    const ui = createFakeUi({
      customs: [
        { type: "openAgentDetail", agentId: "agent_1" },
        {
          type: "controlAction",
          action: {
            type: "stopAgent",
            runId: "wf_stop_agent_12345678",
            agentId: "agent_1",
          },
        },
      ],
    });

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(agent.signal.aborted).toBe(true);
    expect(agent.stopReason).toContain("agent停止");
    expect(registration.signal.aborted).toBe(false);
    expect(ui.notifications).toEqual([
      { level: "info", message: "/workflows: agent agent_1 を停止しました。" },
    ]);
  });

  test("executes a custom monitor control seam with run and agent context", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_custom_control_12345678",
      workflowName: "custom_control_smoke",
      status: "running",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
      agents: [
        {
          id: "agent_1",
          label: "inventory",
          phase: "Run",
          status: "completed",
          promptPreview: "manifest preview",
          queuedAt: "2026-06-19T00:00:01.000Z",
          startedAt: "2026-06-19T00:00:02.000Z",
          completedAt: "2026-06-19T00:00:03.000Z",
        },
      ],
    });
    const executed: unknown[] = [];
    const pi = createPi({
      controls: {
        describe(context) {
          return {
            runId: context.runId ?? "missing-run",
            ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
            items: [],
          };
        },
        execute(action, context) {
          executed.push({ action, context });
          return { action, status: "completed", message: "custom control done" };
        },
      },
    });
    const ui = createFakeUi({
      customs: [
        { type: "openAgentDetail", agentId: "agent_1" },
        {
          type: "controlAction",
          action: {
            type: "stopAgent",
            runId: "wf_custom_control_12345678",
            agentId: "agent_1",
          },
        },
      ],
    });

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(executed).toEqual([
      {
        action: {
          type: "stopAgent",
          runId: "wf_custom_control_12345678",
          agentId: "agent_1",
        },
        context: {
          workflowRoot: join(cwd, ".pi", "workflows"),
          runId: "wf_custom_control_12345678",
          agentId: "agent_1",
          runStatus: "running",
          agentStatus: "completed",
        },
      },
    ]);
    expect(ui.notifications).toEqual([{ level: "info", message: "custom control done" }]);
    expect(ui.customCalls).toHaveLength(2);
  });

  test("writes explicit JSON in non-interactive json mode", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_json_12345678",
      workflowName: "json_smoke",
      status: "completed",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });
    const output: string[] = [];
    const pi = createPi({ output: (text) => output.push(text) });
    const ui = createFakeUi();

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "json",
      hasUI: false,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(ui.notifications).toEqual([]);
    expect(output).toHaveLength(1);
    const payload = JSON.parse(output[0]!);
    expect(payload).toMatchObject({
      count: 1,
      workflows: [
        {
          runId: "wf_json_12345678",
          workflowName: "json_smoke",
          status: "completed",
          statusLabel: "完了",
          totalTokens: 123,
          totalToolCalls: 4,
          resultPreview: '{"ok":true}',
        },
      ],
    });
  });

  test("writes explicit text in non-interactive print mode", async () => {
    const cwd = tempCwd();
    await writeRun(cwd, {
      runId: "wf_print_12345678",
      workflowName: "print_smoke",
      status: "failed",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });
    const output: string[] = [];
    const pi = createPi({ output: (text) => output.push(text) });
    const ui = createFakeUi();

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "print",
      hasUI: false,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(ui.notifications).toEqual([]);
    expect(output).toEqual([expect.stringContaining("print_smoke [失敗]") as unknown as string]);
    expect(output[0]).toContain("/workflows: 1 件のワークフロー");
  });

  test("reports an empty visible workflow list", async () => {
    const cwd = tempCwd();
    const pi = createPi();
    const ui = createFakeUi();

    await pi.commands.get("workflows")!.handler("", {
      cwd,
      mode: "rpc",
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1" },
      ui,
    });

    expect(ui.notifications).toEqual([
      {
        level: "info",
        message: expect.stringContaining("表示できるワークフローはありません") as unknown as string,
      },
    ]);
  });
});
