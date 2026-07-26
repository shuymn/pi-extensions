import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliExec } from "../../lib/cli";
import { createWorkflowAgentJournalKey } from "./journal/key";
import { WorkflowRunControllerRegistry } from "./run/controllers";
import { extensionPackagedWorkflowRootDescriptors } from "./saved/packaged";
import type { SavedWorkflow } from "./saved/resolver";
import { createWorkflowToolCommandLauncher } from "./ui/workflow-command";
import {
  createAgentSessionCalls,
  loaderInstances,
  loadWorkflowToolModule,
  readJournalLines,
  setNextWorkflowAgentResultText,
  tempCwd,
  tempDir,
  tempWorkflowRoot,
  writeWorkflowFile,
} from "./workflow-tool.test-support";

describe("dynamic workflow tool launch", () => {
  test("launches workflow scripts by scriptPath and saved name with source precedence", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const cwd = tempCwd();
    const workflowRoot = join(cwd, ".pi", "workflows");
    mkdirSync(workflowRoot, { recursive: true });
    const pathScript = `
      export const meta = { name: "from_path", phases: [{ title: "Run" }] };
      return await agent("from path", { label: "path" });
    `;
    const rawScript = `
      export const meta = { name: "from_raw_script", phases: [{ title: "Run" }] };
      return await agent("from raw script", { label: "raw" });
    `;
    const savedScript = `
      export const meta = { name: "saved_by_name", phases: [{ title: "Run" }] };
      return await agent("from saved name", { label: "saved" });
    `;
    writeFileSync(join(cwd, "from-path.js"), pathScript);
    writeFileSync(join(workflowRoot, "saved-by-name.js"), savedScript);

    const calls: string[] = [];
    const backgroundTasks: Array<() => Promise<void>> = [];
    const runIds = ["wf_path_source_12345678", "wf_name_source_12345678"];
    const taskIds = ["task_path_12345678", "task_name_12345678"];
    const tool = createWorkflowTool({
      workflowRoot,
      cwd,
      runIdFactory: () => runIds.shift()!,
      taskIdFactory: () => taskIds.shift()!,
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agent: (prompt) => {
        calls.push(prompt);
        return prompt;
      },
    });

    const pathLaunch = await tool.execute(
      "call",
      { scriptPath: "from-path.js", script: rawScript, name: "saved_by_name" },
      undefined,
      undefined,
      { cwd } as never,
    );
    const nameLaunch = await tool.execute("call", { name: "saved_by_name" }, undefined, undefined, {
      cwd,
    } as never);

    expect(pathLaunch.details).toMatchObject({
      runId: "wf_path_source_12345678",
      workflowName: "from_path",
    });
    expect(nameLaunch.details).toMatchObject({
      runId: "wf_name_source_12345678",
      workflowName: "saved_by_name",
    });
    expect(readFileSync(join(workflowRoot, "wf_path_source_12345678", "script.js"), "utf8")).toBe(
      pathScript,
    );
    expect(readFileSync(join(workflowRoot, "wf_name_source_12345678", "script.js"), "utf8")).toBe(
      savedScript,
    );

    await backgroundTasks[0]!();
    await backgroundTasks[1]!();

    expect(calls).toEqual(["from path", "from saved name"]);
  });

  test("launches a skill-packaged workflow by name from additional roots", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const cwd = tempCwd();
    const workflowRoot = join(cwd, ".pi", "workflows");
    const packageRoot = tempDir("pi-workflow-tool-package-");
    const skillWorkflowRoot = join(packageRoot, "skills", "deep-research", "workflows");
    const skillScript = `
      export const meta = {
        name: "skill_packaged",
        description: "Packaged workflow",
        phases: [{ title: "Research" }],
      };
      return await agent("skill " + args.topic, { label: "skill" });
    `;
    writeWorkflowFile(skillWorkflowRoot, "skill-packaged.js", skillScript);

    const calls: string[] = [];
    const backgroundTasks: Array<() => Promise<void>> = [];
    let providerCtx: unknown;
    const ctx = { cwd };
    const tool = createWorkflowTool({
      workflowRoot,
      cwd,
      runIdFactory: () => "wf_skill_package_12345678",
      taskIdFactory: () => "task_skill_package_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      additionalWorkflowRoots: (context) => {
        providerCtx = context;
        return [skillWorkflowRoot];
      },
      agent: (prompt) => {
        calls.push(prompt);
        return prompt;
      },
    });

    const launch = await tool.execute(
      "call",
      { name: "skill_packaged", args: { topic: "pi" } },
      undefined,
      undefined,
      ctx as never,
    );

    expect(providerCtx).toBe(ctx);
    expect(launch.details).toMatchObject({
      runId: "wf_skill_package_12345678",
      workflowName: "skill_packaged",
      description: "Packaged workflow",
      phases: ["Research"],
    });
    expect(readFileSync(join(workflowRoot, "wf_skill_package_12345678", "script.js"), "utf8")).toBe(
      skillScript,
    );

    await backgroundTasks[0]!();

    expect(calls).toEqual(["skill pi"]);
  });

  test("uses WorkflowToolOptions.cwd for workflow state and the default subagent runner", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const { createWorkflowAgentRunner } = await import("./agent/runner");
    const ctxCwd = tempCwd();
    const effectiveCwdRoot = tempCwd();
    const effectiveCwd = join(effectiveCwdRoot, "workspace", "app");
    mkdirSync(effectiveCwd, { recursive: true });
    const backgroundTasks: Array<() => Promise<void>> = [];
    let agentFactoryCwd: string | undefined;
    setNextWorkflowAgentResultText("subagent used effective cwd");
    const tool = createWorkflowTool({
      cwd: effectiveCwd,
      runIdFactory: () => "wf_cwd_override_12345678",
      taskIdFactory: () => "task_cwd_override_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agentFactory: (agentCtx) => {
        agentFactoryCwd = agentCtx.cwd;
        return createWorkflowAgentRunner({ getThinkingLevel: () => "high" } as never, agentCtx, {
          tools: [],
          toolNames: [],
        });
      },
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = {
            name: "cwd_override",
            phases: [{ title: "Run" }],
          };

          phase("Run");
          log("cwd=" + cwd);
          const answer = await agent("cwd:" + process.cwd(), { label: "cwd check" });
          return { workflowCwd: cwd, processCwd: process.cwd(), answer };
        `,
      },
      undefined,
      undefined,
      {
        cwd: ctxCwd,
        modelRegistry: { id: "registry" },
        model: { id: "model" },
        getSystemPrompt: () => "parent system prompt",
        sessionManager: { getSessionId: () => "session-cwd" },
      } as never,
    );

    expect(agentFactoryCwd).toBe(effectiveCwd);
    const runDir = join(effectiveCwd, ".pi", "workflows", "wf_cwd_override_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      runId: "wf_cwd_override_12345678",
      taskId: "task_cwd_override_12345678",
      sessionId: "session-cwd",
      cwd: effectiveCwd,
      status: "queued",
      scriptPath: join(runDir, "script.js"),
    });

    await backgroundTasks[0]!();

    expect(loaderInstances[0].options.cwd).toBe(effectiveCwd);
    expect(loaderInstances[0].options.systemPromptOverride()).toContain(
      `Working directory: ${effectiveCwd}`,
    );
    expect(createAgentSessionCalls[0]).toMatchObject({
      cwd: effectiveCwd,
      sessionManager: { kind: "in-memory", cwd: effectiveCwd },
      settingsManager: { cwd: effectiveCwd, agentDir: "/agent-dir" },
    });
    const expectedKey = createWorkflowAgentJournalKey({
      prompt: `cwd:${effectiveCwd}`,
      label: "cwd check",
      phase: "Run",
      cwd: effectiveCwd,
    });
    expect(readJournalLines(join(runDir, "journal.jsonl"))).toEqual([
      { type: "started", key: expectedKey, agentId: expect.any(String) },
      {
        type: "result",
        key: expectedKey,
        agentId: expect.any(String),
        result: "subagent used effective cwd",
      },
    ]);
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "completed",
      result: {
        workflowCwd: effectiveCwd,
        processCwd: effectiveCwd,
        answer: "subagent used effective cwd",
      },
      logs: [`cwd=${effectiveCwd}`],
    });
    expect(JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "completed",
      cwd: effectiveCwd,
      logs: [`cwd=${effectiveCwd}`],
    });
    expect(
      JSON.parse(readFileSync(join(runDir, "transcripts", "0001-cwd-check.json"), "utf8")),
    ).toMatchObject({
      metadata: {
        cwd: effectiveCwd,
        prompt: `cwd:${effectiveCwd}`,
        sessionPrompt: expect.stringContaining(`cwd:${effectiveCwd}`),
      },
    });
  });

  test("launches a workflow in the background after writing initial run artifacts", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const calls: Array<{ prompt: string; options: unknown }> = [];
    const backgroundTasks: Array<() => Promise<void>> = [];
    const notifications: unknown[] = [];
    let nextJournalAgentId = 0;
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_tool_smoke_12345678",
      taskIdFactory: () => "task_tool_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      completionNotifier: (notification) => notifications.push(notification),
      journalAgentIdFactory: () => {
        nextJournalAgentId += 1;
        return `journal-agent-${nextJournalAgentId}`;
      },
      agent: (prompt, options) => {
        calls.push({ prompt, options });
        return { prompt, label: options.label, phase: options.phase };
      },
    });

    const result = await tool.execute(
      "call",
      {
        args: { target: "src" },
        script: `
          export const meta = {
            name: "tool_smoke",
            description: "Run a fake-agent workflow",
            phases: [{ title: "Run" }],
          };

          phase("Run");
          log("started");
          const response = await agent("inspect " + args.target, { label: "inspect target" });
          return { ok: true, response };
        `,
      },
      undefined,
      undefined,
      {
        cwd: "/repo",
        sessionManager: { getSessionId: () => "session-1" },
      } as never,
    );

    expect(backgroundTasks).toHaveLength(1);
    expect(calls).toEqual([]);
    const runDir = join(workflowRoot, "wf_tool_smoke_12345678");
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      runId: "wf_tool_smoke_12345678",
      taskId: "task_tool_12345678",
      sessionId: "session-1",
      cwd: "/repo",
      workflowName: "tool_smoke",
      description: "Run a fake-agent workflow",
      status: "queued",
      phases: [{ title: "Run", status: "pending" }],
    });
    expect(readFileSync(join(runDir, "script.js"), "utf8")).toContain("tool_smoke");
    expect(existsSync(join(runDir, "output.json"))).toBe(false);

    const content = result.content[0];
    expect(content.type).toBe("text");
    if (content.type !== "text") throw new Error("expected text content");
    expect(content.text).toContain("Workflow tool_smoke launched");

    expect((result as any).terminate).toBe(true);

    const details = result.details as any;
    expect(details).toMatchObject({
      status: "launched",
      runId: "wf_tool_smoke_12345678",
      taskId: "task_tool_12345678",
      workflowName: "tool_smoke",
      artifactDir: runDir,
      phases: ["Run"],
      agentCount: 0,
    });
    expect(() => JSON.stringify(details)).not.toThrow();

    await backgroundTasks[0]!();

    expect(calls).toEqual([
      {
        prompt: "inspect src",
        options: expect.objectContaining({
          label: "inspect target",
          phase: "Run",
          transcript: expect.objectContaining({
            transcriptId: "0001-inspect-target",
            runId: "wf_tool_smoke_12345678",
            taskId: "task_tool_12345678",
            workflowName: "tool_smoke",
            transcriptsDir: join(runDir, "transcripts"),
          }),
        }),
      },
    ]);
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "completed",
      runId: "wf_tool_smoke_12345678",
      taskId: "task_tool_12345678",
      result: { ok: true },
      agentCount: 1,
      estimatedResultTokens: expect.any(Number),
      usage: {
        agentCount: 1,
        estimatedResultTokens: expect.any(Number),
      },
      logs: ["started"],
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        runId: "wf_tool_smoke_12345678",
        taskId: "task_tool_12345678",
        workflowName: "tool_smoke",
        status: "completed",
        artifactDir: runDir,
        outputPath: join(runDir, "output.json"),
        resultPreview: expect.stringContaining('"ok":true'),
        usage: expect.objectContaining({
          agentCount: 1,
          estimatedResultTokens: expect.any(Number),
        }),
      }),
    ]);

    const journalEvents = readJournalLines(join(runDir, "journal.jsonl"));
    expect(journalEvents[0]?.key).toBe(journalEvents[1]?.key);
    expect(journalEvents).toEqual([
      { type: "started", key: expect.stringMatching(/^v1:/), agentId: "journal-agent-1" },
      {
        type: "result",
        key: expect.stringMatching(/^v1:/),
        agentId: "journal-agent-1",
        result: { prompt: "inspect src", label: "inspect target", phase: "Run" },
      },
    ]);

    const completedManifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    expect(completedManifest).toMatchObject({
      status: "completed",
      logs: ["started"],
      outputPath: join(runDir, "output.json"),
      agentCount: 1,
      estimatedResultTokens: expect.any(Number),
      workflowProgress: {
        queuedAgents: 0,
        runningAgents: 0,
        completedAgents: 1,
        failedAgents: 0,
        currentPhase: "Run",
      },
      phases: [{ title: "Run", status: "completed" }],
      agents: [
        {
          label: "inspect target",
          phase: "Run",
          status: "completed",
          promptPreview: "inspect src",
        },
      ],
    });
  });

  test("aborts launch preparation when the parent signal stops mid-launch", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const registry = new WorkflowRunControllerRegistry();
    const parent = new AbortController();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const tool = createWorkflowTool({
      workflowRoot,
      controllerRegistry: registry,
      runIdFactory: () => "wf_parent_abort_12345678",
      taskIdFactory: () => "task_parent_abort_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      additionalWorkflowRoots: () => {
        parent.abort("parent stopped");
        return [];
      },
      agent: () => "unused",
    });

    await expect(
      tool.execute(
        "call",
        {
          script: `
            export const meta = { name: "parent_abort", phases: [{ title: "Run" }] };
            return await agent("work", { label: "work" });
          `,
        },
        parent.signal,
        undefined,
        { cwd: "/repo" } as never,
      ),
    ).rejects.toThrow("workflow launch was aborted.");

    expect(backgroundTasks).toEqual([]);
    expect(registry.activeRunIds()).toEqual([]);
    expect(existsSync(workflowRoot)).toBe(false);
  });

  test("tracks launch preparation so shutdown cannot miss or outlive the launch", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const registry = new WorkflowRunControllerRegistry();
    const backgroundTasks: Array<() => Promise<void>> = [];
    let shutdown: Promise<void> | undefined;
    const tool = createWorkflowTool({
      workflowRoot,
      controllerRegistry: registry,
      runIdFactory: () => "wf_shutdown_launch_12345678",
      taskIdFactory: () => "task_shutdown_launch_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      additionalWorkflowRoots: () => {
        shutdown = registry.shutdown((runId) => `shutdown during launch: ${runId}`);
        return [];
      },
      agent: () => "unused",
    });

    await expect(
      tool.execute(
        "call",
        {
          script: `
            export const meta = { name: "shutdown_launch", phases: [{ title: "Run" }] };
            return await agent("work", { label: "work" });
          `,
        },
        undefined,
        undefined,
        { cwd: "/repo" } as never,
      ),
    ).rejects.toThrow("shutdown during launch: wf_shutdown_launch_12345678");

    await shutdown;
    expect(backgroundTasks).toEqual([]);
    expect(registry.activeRunIds()).toEqual([]);
    expect(existsSync(workflowRoot)).toBe(false);
    expect(() => registry.register("wf_after_shutdown_12345678")).toThrow("shutting down");
  });

  test("turns a synchronous background scheduler failure into terminal failed artifacts", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const registry = new WorkflowRunControllerRegistry();
    const lifecycleStatuses: string[] = [];
    const completionStatuses: string[] = [];
    let rejectedTask: (() => Promise<void>) | undefined;
    const tool = createWorkflowTool({
      workflowRoot,
      controllerRegistry: registry,
      runIdFactory: () => "wf_scheduler_throw_12345678",
      taskIdFactory: () => "task_scheduler_throw_12345678",
      backgroundScheduler: (task) => {
        rejectedTask = task;
        throw new Error("scheduler failed synchronously");
      },
      lifecycleNotifier: (notification) => lifecycleStatuses.push(notification.status),
      completionNotifier: (notification) => completionStatuses.push(notification.status),
      agent: () => "must not run",
    });

    await expect(
      tool.execute(
        "call",
        {
          script: `
            export const meta = { name: "scheduler_throw", phases: [{ title: "Run" }] };
            return await agent("work", { label: "work" });
          `,
        },
        undefined,
        undefined,
        { cwd: "/repo" } as never,
      ),
    ).rejects.toThrow("scheduler failed synchronously");

    const runDir = join(workflowRoot, "wf_scheduler_throw_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "failed",
      failures: [{ message: "scheduler failed synchronously" }],
      outputPath: join(runDir, "output.json"),
    });
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "failed",
      error: "scheduler failed synchronously",
    });
    expect(lifecycleStatuses).toEqual(["started", "failed"]);
    expect(completionStatuses).toEqual(["failed"]);
    expect(registry.activeRunIds()).toEqual([]);

    await rejectedTask?.();
    expect(lifecycleStatuses).toEqual(["started", "failed"]);
    expect(completionStatuses).toEqual(["failed"]);
  });

  test("keeps an earlier stop reason when the scheduler stops the run before throwing", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const registry = new WorkflowRunControllerRegistry();
    const lifecycleStatuses: string[] = [];
    const tool = createWorkflowTool({
      workflowRoot,
      controllerRegistry: registry,
      runIdFactory: () => "wf_scheduler_stop_12345678",
      taskIdFactory: () => "task_scheduler_stop_12345678",
      backgroundScheduler: () => {
        registry.stop("wf_scheduler_stop_12345678", "scheduler stopped first");
        throw new Error("scheduler threw later");
      },
      lifecycleNotifier: (notification) => lifecycleStatuses.push(notification.status),
      agent: () => "must not run",
    });

    await expect(
      tool.execute(
        "call",
        {
          script: `
            export const meta = { name: "scheduler_stop", phases: [{ title: "Run" }] };
            return await agent("work", { label: "work" });
          `,
        },
        undefined,
        undefined,
        { cwd: "/repo" } as never,
      ),
    ).rejects.toThrow("scheduler threw later");

    const runDir = join(workflowRoot, "wf_scheduler_stop_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "cancelled",
      reason: "scheduler stopped first",
    });
    expect(lifecycleStatuses).toEqual(["started", "cancelled"]);
  });

  test("host-authorizes canonical packaged review_flow PR fixes after a clean matching preflight", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const agentLabels: string[] = [];
    const execCalls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const head = "0123456789abcdef0123456789abcdef01234567";
    const exec: CliExec = async (command, args, options) => {
      execCalls.push({ command, args, options });
      if (command === "gh") {
        return {
          code: 0,
          stdout: JSON.stringify(
            args.includes("files,headRefOid")
              ? { headRefOid: head, files: [{ path: "src/auth.ts" }] }
              : { headRefOid: head },
          ),
          stderr: "",
        };
      }
      if (args[0] === "rev-parse") return { code: 0, stdout: `${head}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const tool = createWorkflowTool({
      workflowRoot,
      cwd: "/repo",
      exec,
      additionalWorkflowRoots: extensionPackagedWorkflowRootDescriptors(),
      runIdFactory: () => "wf_review_authorized_12345678",
      taskIdFactory: () => "task_review_authorized_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agent: (_prompt, options) => {
        const label = options.label ?? "";
        agentLabels.push(label);
        if (label === "recon") {
          return {
            targetFiles: ["src/auth.ts"],
            scopeSummary: "PR auth change",
            riskAreas: ["auth"],
          };
        }
        if (label.startsWith("gapfill")) {
          return {
            continueHunt: false,
            followUpHuntFocus: [],
            findings: [],
            coverageGaps: [],
            rationale: "complete",
          };
        }
        if (label.startsWith("hunt") || label.startsWith("validate") || label === "dedupe") {
          return { findings: [], coverageGaps: [], notes: "none" };
        }
        if (label === "trace") {
          return {
            findings: [
              {
                path: "src/auth.ts",
                issue: "issue",
                evidence: "evidence",
                impact: "impact",
                suggestedFix: "fix",
                confidence: "high",
              },
            ],
            coverageGaps: [],
            notes: "traced",
          };
        }
        if (label === "fix") return { changes: [], notes: "none" };
        if (label === "verify") return { checks: [], notes: "none" };
        if (label === "summary") return { report: "done", findings: [], skipped: [] };
        return {};
      },
    });

    await tool.execute(
      "call",
      { name: "review_flow", args: { pr: "42", maxGapfillLoops: 0 } },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    expect(execCalls.map(({ command, args }) => [command, ...args])).toEqual([
      ["gh", "pr", "view", "42", "--json", "files,headRefOid"],
      ["git", "rev-parse", "HEAD"],
      ["git", "status", "--porcelain"],
    ]);
    await backgroundTasks[0]!();
    expect(execCalls.slice(3).map(({ command, args }) => [command, ...args])).toEqual([
      ["gh", "pr", "view", "42", "--json", "headRefOid"],
      ["git", "rev-parse", "HEAD"],
      ["git", "status", "--porcelain"],
    ]);
    expect(agentLabels).toContain("fix");
    expect(agentLabels).toContain("verify");
    expect(
      JSON.parse(
        readFileSync(join(workflowRoot, "wf_review_authorized_12345678", "output.json"), "utf8"),
      ),
    ).toMatchObject({ status: "completed", result: { noFix: false } });
  });

  test("preserves noncanonical saved-workflow provenance through the slash-command launcher", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const execCalls: string[] = [];
    const projectOverride: SavedWorkflow = {
      name: "review_flow",
      phases: [{ title: "Run" }],
      path: join(workflowRoot, "review-flow.js"),
      fileName: "review-flow.js",
      source: "project",
      script: `
        export const meta = { name: "review_flow", phases: [{ title: "Run" }] };
        await agent("work", { label: "work" });
        return {
          authorized: !!(
            trustedRuntimeContext &&
            trustedRuntimeContext.reviewFlow &&
            trustedRuntimeContext.reviewFlow.prMutationAuthorized === true
          ),
        };
      `,
    };
    const tool = createWorkflowTool({
      workflowRoot,
      cwd: "/repo",
      exec: async (command) => {
        execCalls.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
      additionalWorkflowRoots: extensionPackagedWorkflowRootDescriptors(),
      runIdFactory: () => "wf_project_review_12345678",
      taskIdFactory: () => "task_project_review_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      agent: () => "ok",
    });
    const launcher = createWorkflowToolCommandLauncher(tool);

    await launcher({ workflow: projectOverride, args: { pr: "42" } }, { cwd: "/repo" } as never);

    expect(execCalls).toEqual([]);
    await backgroundTasks[0]!();
    expect(
      JSON.parse(
        readFileSync(join(workflowRoot, "wf_project_review_12345678", "output.json"), "utf8"),
      ),
    ).toMatchObject({ status: "completed", result: { authorized: false } });
  });

  test("continues scheduling when the initial workflow widget throws", async () => {
    const { launchWorkflowRun } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const registry = new WorkflowRunControllerRegistry();
    const backgroundTasks: Array<() => Promise<void>> = [];

    await expect(
      launchWorkflowRun(
        {
          workflowRoot,
          controllerRegistry: registry,
          runIdFactory: () => "wf_widget_throw_12345678",
          taskIdFactory: () => "task_widget_throw_12345678",
          backgroundScheduler: (task) => backgroundTasks.push(task),
          agent: () => "unused",
        },
        {
          cwd: "/repo",
          ui: {
            setWidget() {
              throw new Error("widget failed");
            },
          },
        } as never,
        {
          script: `
            export const meta = { name: "widget_throw", phases: [{ title: "Run" }] };
            return await agent("work", { label: "work" });
          `,
        },
      ),
    ).resolves.toMatchObject({ workflowName: "widget_throw" });

    expect(backgroundTasks).toHaveLength(1);
    await backgroundTasks[0]!();
    const output = JSON.parse(
      readFileSync(join(workflowRoot, "wf_widget_throw_12345678", "output.json"), "utf8"),
    );
    expect(output.status).toBe("completed");
    expect(registry.activeRunIds()).toEqual([]);
    await expect(registry.shutdown((runId) => `shutdown: ${runId}`)).resolves.toBeUndefined();
  });

  test("keeps a completed workflow completed when terminal artifact writes fail", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const backgroundTasks: Array<() => Promise<void>> = [];
    const notifications: unknown[] = [];
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_completed_artifact_failure_12345678",
      taskIdFactory: () => "task_completed_artifact_failure_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      completionNotifier: (notification) => notifications.push(notification),
      agent: () => "ok",
    });

    await tool.execute(
      "call",
      {
        script: `
          export const meta = { name: "artifact_failure", phases: [{ title: "Run" }] };
          return await agent("done", { label: "done" });
        `,
      },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    const runDir = join(workflowRoot, "wf_completed_artifact_failure_12345678");
    rmSync(runDir, { recursive: true, force: true });
    writeFileSync(runDir, "not a directory");

    await backgroundTasks[0]!();

    expect(notifications).toEqual([
      expect.objectContaining({
        status: "completed",
        runId: "wf_completed_artifact_failure_12345678",
        outputPath: join(runDir, "output.json"),
        resultPreview: "ok",
      }),
    ]);
  });
});
