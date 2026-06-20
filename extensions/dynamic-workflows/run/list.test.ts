import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkflowRunManifests } from "./list";
import { createInitialWorkflowRunState, type WorkflowRunState } from "./model";
import { WorkflowRunStore } from "./store";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-list-"));
  tempDirs.push(dir);
  return join(dir, ".pi", "workflows");
}

async function writeRun(
  root: string,
  input: {
    runId: string;
    workflowName: string;
    sessionId?: string;
    updatedAt: string;
    status?: WorkflowRunState["status"];
  },
): Promise<void> {
  const state = createInitialWorkflowRunState({
    runId: input.runId,
    taskId: `task_${input.runId}`,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    cwd: "/repo",
    workflowName: input.workflowName,
    phases: [{ title: "Run" }],
    startTime: "2026-06-19T00:00:00.000Z",
  });
  state.status = input.status ?? "completed";
  state.updatedAt = input.updatedAt;

  const store = new WorkflowRunStore(root);
  await store.createRun({ state, script: "export const meta = {};" });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow run manifest listing", () => {
  test("filters by current session id and includes legacy manifests without a session id", async () => {
    const root = tempRoot();
    await writeRun(root, {
      runId: "wf_current_12345678",
      workflowName: "current_session",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:03.000Z",
    });
    await writeRun(root, {
      runId: "wf_legacy_12345678",
      workflowName: "legacy_without_session",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });
    await writeRun(root, {
      runId: "wf_other_12345678",
      workflowName: "other_session",
      sessionId: "session-2",
      updatedAt: "2026-06-19T00:00:04.000Z",
    });

    const visible = await listWorkflowRunManifests(root, { sessionId: "session-1" });

    expect(visible.map((state) => state.runId)).toEqual([
      "wf_current_12345678",
      "wf_legacy_12345678",
    ]);
  });

  test("lists all manifests when current session id is unavailable", async () => {
    const root = tempRoot();
    await writeRun(root, {
      runId: "wf_first_12345678",
      workflowName: "first",
      sessionId: "session-1",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
    await writeRun(root, {
      runId: "wf_second_12345678",
      workflowName: "second",
      sessionId: "session-2",
      updatedAt: "2026-06-19T00:00:02.000Z",
    });

    const visible = await listWorkflowRunManifests(root);

    expect(visible.map((state) => state.runId)).toEqual([
      "wf_second_12345678",
      "wf_first_12345678",
    ]);
  });

  test("ignores malformed or incomplete manifest files", async () => {
    const root = tempRoot();
    await writeRun(root, {
      runId: "wf_valid_12345678",
      workflowName: "valid",
      updatedAt: "2026-06-19T00:00:01.000Z",
    });
    writeFileSync(join(root, "not-a-run.js"), "export const meta = {};\n");
    const malformedDir = join(root, "wf_malformed_12345678");
    await new WorkflowRunStore(root).writeManifest(
      createInitialWorkflowRunState({
        runId: "wf_malformed_12345678",
        taskId: "task_malformed_12345678",
        cwd: "/repo",
        workflowName: "malformed",
        phases: [{ title: "Run" }],
      }),
    );
    writeFileSync(join(malformedDir, "manifest.json"), "{not json");

    const visible = await listWorkflowRunManifests(root);

    expect(visible.map((state) => state.runId)).toEqual(["wf_valid_12345678"]);
  });

  test("ignores manifests with malformed nested phase, agent, progress, or failure state", async () => {
    const root = tempRoot();
    await writeRun(root, {
      runId: "wf_valid_12345678",
      workflowName: "valid",
      updatedAt: "2026-06-19T00:00:05.000Z",
    });

    for (const [runId, mutate] of [
      [
        "wf_bad_phase_12345678",
        (state: WorkflowRunState) => (state.phases[0]!.status = "bogus" as never),
      ],
      [
        "wf_bad_agent_12345678",
        (state: WorkflowRunState) =>
          state.agents.push({
            id: "agent_1",
            label: "agent",
            status: "completed",
            promptPreview: 12 as never,
            queuedAt: "2026-06-19T00:00:00.000Z",
          }),
      ],
      [
        "wf_bad_progress_12345678",
        (state: WorkflowRunState) => (state.workflowProgress.runningAgents = "1" as never),
      ],
      [
        "wf_bad_failure_12345678",
        (state: WorkflowRunState) =>
          state.failures.push({ message: "failed", timestamp: undefined as never }),
      ],
    ] as const) {
      const state = createInitialWorkflowRunState({
        runId,
        taskId: `task_${runId}`,
        cwd: "/repo",
        workflowName: runId,
        phases: [{ title: "Run" }],
      });
      mutate(state);
      await new WorkflowRunStore(root).createRun({ state, script: "export const meta = {};" });
    }

    const visible = await listWorkflowRunManifests(root);

    expect(visible.map((state) => state.runId)).toEqual(["wf_valid_12345678"]);
  });
});
