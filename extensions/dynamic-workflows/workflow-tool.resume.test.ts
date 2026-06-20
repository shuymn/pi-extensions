import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkflowAgentJournalKey } from "./journal/key";
import {
  loadWorkflowToolModule,
  readJournalLines,
  tempWorkflowRoot,
} from "./workflow-tool.test-support";

describe("dynamic workflow tool resume", () => {
  test("resumes from a previous run by replaying completed agents and spawning incomplete agents", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const previousRunId = "wf_previous_12345678";
    const previousRunDir = join(workflowRoot, previousRunId);
    const script = `
      export const meta = {
        name: "resume_smoke",
        phases: [{ title: "Run" }],
      };
      phase("Run");
      const cached = await agent("cached prompt", { label: "cached" });
      const incomplete = await agent("incomplete prompt", { label: "incomplete" });
      return { cached, incomplete };
    `;
    mkdirSync(previousRunDir, { recursive: true });
    writeFileSync(join(previousRunDir, "script.js"), script);
    const cachedKey = createWorkflowAgentJournalKey({
      prompt: "cached prompt",
      label: "cached",
      phase: "Run",
      cwd: "/repo",
    });
    const incompleteKey = createWorkflowAgentJournalKey({
      prompt: "incomplete prompt",
      label: "incomplete",
      phase: "Run",
      cwd: "/repo",
    });
    writeFileSync(
      join(previousRunDir, "journal.jsonl"),
      `${[
        JSON.stringify({ type: "started", key: cachedKey, agentId: "old-cached" }),
        JSON.stringify({
          type: "result",
          key: cachedKey,
          agentId: "old-cached",
          result: { cached: true },
        }),
        JSON.stringify({ type: "started", key: incompleteKey, agentId: "old-incomplete" }),
      ].join("\n")}\n`,
    );

    const calls: Array<{ prompt: string; options: unknown }> = [];
    const backgroundTasks: Array<() => Promise<void>> = [];
    let nextJournalAgentId = 0;
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_resume_12345678",
      taskIdFactory: () => "task_resume_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      journalAgentIdFactory: () => {
        nextJournalAgentId += 1;
        return `journal-agent-${nextJournalAgentId}`;
      },
      agent: (prompt, options) => {
        calls.push({ prompt, options });
        return { fresh: prompt };
      },
    });

    const result = await tool.execute(
      "call",
      { resumeFromRunId: previousRunId },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );

    expect(result.details).toMatchObject({
      status: "launched",
      runId: "wf_resume_12345678",
      resumeFromRunId: previousRunId,
      workflowName: "resume_smoke",
    });
    expect(readFileSync(join(workflowRoot, "wf_resume_12345678", "script.js"), "utf8")).toBe(
      script,
    );

    await backgroundTasks[0]!();

    expect(calls).toEqual([
      {
        prompt: "incomplete prompt",
        options: expect.objectContaining({
          label: "incomplete",
          phase: "Run",
          transcript: expect.objectContaining({
            transcriptId: "0002-incomplete",
            runId: "wf_resume_12345678",
            taskId: "task_resume_12345678",
            workflowName: "resume_smoke",
            transcriptsDir: join(workflowRoot, "wf_resume_12345678", "transcripts"),
          }),
        }),
      },
    ]);
    const runDir = join(workflowRoot, "wf_resume_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "completed",
      resumeFromRunId: previousRunId,
      result: {
        cached: { cached: true },
        incomplete: { fresh: "incomplete prompt" },
      },
      agentCount: 2,
    });
    expect(JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))).toMatchObject({
      status: "completed",
      agentCount: 2,
      agents: [
        { label: "cached", status: "completed", resultPreview: '{"cached":true}' },
        {
          label: "incomplete",
          status: "completed",
          resultPreview: '{"fresh":"incomplete prompt"}',
        },
      ],
    });
    expect(readJournalLines(join(runDir, "journal.jsonl"))).toEqual([
      { type: "started", key: cachedKey, agentId: "journal-agent-1" },
      { type: "result", key: cachedKey, agentId: "journal-agent-1", result: { cached: true } },
      { type: "started", key: incompleteKey, agentId: "journal-agent-2" },
      {
        type: "result",
        key: incompleteKey,
        agentId: "journal-agent-2",
        result: { fresh: "incomplete prompt" },
      },
    ]);
  });

  test("resumes with latest duplicate result and reruns incomplete or changed agent calls", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const workflowRoot = tempWorkflowRoot();
    const previousRunId = "wf_previous_resume_matrix_12345678";
    const previousRunDir = join(workflowRoot, previousRunId);
    mkdirSync(previousRunDir, { recursive: true });
    const oldSchema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const newSchema = {
      type: "object",
      properties: { verdict: { type: "string" }, confidence: { type: "number" } },
      required: ["verdict", "confidence"],
    };
    const duplicateKey = createWorkflowAgentJournalKey({
      prompt: "duplicate prompt",
      label: "duplicate",
      phase: "Run",
      cwd: "/repo",
    });
    const incompleteKey = createWorkflowAgentJournalKey({
      prompt: "incomplete prompt",
      label: "incomplete",
      phase: "Run",
      cwd: "/repo",
    });
    const oldPromptKey = createWorkflowAgentJournalKey({
      prompt: "old prompt",
      label: "changed prompt",
      phase: "Run",
      cwd: "/repo",
    });
    const newPromptKey = createWorkflowAgentJournalKey({
      prompt: "new prompt",
      label: "changed prompt",
      phase: "Run",
      cwd: "/repo",
    });
    const oldSchemaKey = createWorkflowAgentJournalKey({
      prompt: "schema prompt",
      label: "changed schema",
      phase: "Run",
      schema: oldSchema,
      cwd: "/repo",
    });
    const newSchemaKey = createWorkflowAgentJournalKey({
      prompt: "schema prompt",
      label: "changed schema",
      phase: "Run",
      schema: newSchema,
      cwd: "/repo",
    });
    writeFileSync(
      join(previousRunDir, "journal.jsonl"),
      `${[
        JSON.stringify({ type: "started", key: duplicateKey, agentId: "old-duplicate-1" }),
        JSON.stringify({
          type: "result",
          key: duplicateKey,
          agentId: "old-duplicate-1",
          result: { duplicate: "first" },
        }),
        JSON.stringify({ type: "started", key: duplicateKey, agentId: "old-duplicate-2" }),
        JSON.stringify({
          type: "result",
          key: duplicateKey,
          agentId: "old-duplicate-2",
          result: { duplicate: "second" },
        }),
        JSON.stringify({ type: "started", key: incompleteKey, agentId: "old-incomplete" }),
        JSON.stringify({ type: "started", key: oldPromptKey, agentId: "old-prompt" }),
        JSON.stringify({
          type: "result",
          key: oldPromptKey,
          agentId: "old-prompt",
          result: { stale: "prompt" },
        }),
        JSON.stringify({ type: "started", key: oldSchemaKey, agentId: "old-schema" }),
        JSON.stringify({
          type: "result",
          key: oldSchemaKey,
          agentId: "old-schema",
          result: { stale: "schema" },
        }),
      ].join("\n")}\n`,
    );

    const script = `
      export const meta = {
        name: "resume_matrix",
        phases: [{ title: "Run" }],
      };
      phase("Run");
      const duplicate = await agent("duplicate prompt", { label: "duplicate" });
      const incomplete = await agent("incomplete prompt", { label: "incomplete" });
      const changedPrompt = await agent("new prompt", { label: "changed prompt" });
      const changedSchema = await agent("schema prompt", {
        label: "changed schema",
        schema: args.newSchema,
      });
      return { duplicate, incomplete, changedPrompt, changedSchema };
    `;
    const calls: Array<{ prompt: string; options: { schema?: unknown } }> = [];
    const backgroundTasks: Array<() => Promise<void>> = [];
    let nextJournalAgentId = 0;
    const tool = createWorkflowTool({
      workflowRoot,
      runIdFactory: () => "wf_resume_matrix_12345678",
      taskIdFactory: () => "task_resume_matrix_12345678",
      backgroundScheduler: (task) => backgroundTasks.push(task),
      journalAgentIdFactory: () => {
        nextJournalAgentId += 1;
        return `journal-agent-${nextJournalAgentId}`;
      },
      agent: (prompt, options) => {
        calls.push({ prompt, options });
        return { fresh: prompt, schema: options.schema };
      },
    });

    await tool.execute(
      "call",
      { resumeFromRunId: previousRunId, script, args: { newSchema } },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );
    await backgroundTasks[0]!();

    expect(calls).toEqual([
      { prompt: "incomplete prompt", options: expect.objectContaining({ schema: undefined }) },
      { prompt: "new prompt", options: expect.objectContaining({ schema: undefined }) },
      { prompt: "schema prompt", options: expect.objectContaining({ schema: newSchema }) },
    ]);
    const runDir = join(workflowRoot, "wf_resume_matrix_12345678");
    expect(JSON.parse(readFileSync(join(runDir, "output.json"), "utf8"))).toMatchObject({
      status: "completed",
      result: {
        duplicate: { duplicate: "second" },
        incomplete: { fresh: "incomplete prompt" },
        changedPrompt: { fresh: "new prompt" },
        changedSchema: { fresh: "schema prompt", schema: newSchema },
      },
      agentCount: 4,
    });
    expect(readJournalLines(join(runDir, "journal.jsonl"))).toEqual([
      {
        type: "started",
        key: duplicateKey,
        agentId: "journal-agent-1",
      },
      {
        type: "result",
        key: duplicateKey,
        agentId: "journal-agent-1",
        result: { duplicate: "second" },
      },
      {
        type: "started",
        key: incompleteKey,
        agentId: "journal-agent-2",
      },
      {
        type: "result",
        key: incompleteKey,
        agentId: "journal-agent-2",
        result: { fresh: "incomplete prompt" },
      },
      {
        type: "started",
        key: newPromptKey,
        agentId: "journal-agent-3",
      },
      {
        type: "result",
        key: newPromptKey,
        agentId: "journal-agent-3",
        result: { fresh: "new prompt" },
      },
      {
        type: "started",
        key: newSchemaKey,
        agentId: "journal-agent-4",
      },
      {
        type: "result",
        key: newSchemaKey,
        agentId: "journal-agent-4",
        result: { fresh: "schema prompt", schema: newSchema },
      },
    ]);
  });
});
