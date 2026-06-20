import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialWorkflowRunState } from "./model";
import { getWorkflowRunPaths, WorkflowRunStore } from "./store";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-store-"));
  tempDirs.push(dir);
  return join(dir, ".pi", "workflows");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow run store", () => {
  test("writes manifest.json and script.js under the run directory", async () => {
    const root = tempRoot();
    const store = new WorkflowRunStore(root);
    const state = createInitialWorkflowRunState({
      runId: "wf_20260911T104416_abcdef12",
      taskId: "task_12345678",
      cwd: "/repo",
      workflowName: "store_smoke",
      phases: [{ title: "Run" }],
      startTime: "2026-09-11T10:44:16.000Z",
    });

    const paths = await store.createRun({ state, script: "export const meta = {};\n" });

    expect(paths).toEqual(getWorkflowRunPaths(root, state.runId));
    expect(readFileSync(paths.scriptPath, "utf8")).toBe("export const meta = {};\n");
    expect(JSON.parse(readFileSync(paths.manifestPath, "utf8"))).toEqual(state);
    expect(existsSync(paths.outputPath)).toBe(false);
    expect(readdirSync(paths.runDir).sort()).toEqual(["manifest.json", "script.js"]);
  });

  test("updates manifest and writes final output.json as stable pretty JSON", async () => {
    const root = tempRoot();
    const store = new WorkflowRunStore(root);
    const state = createInitialWorkflowRunState({
      runId: "wf_20260911T104416_abcdef12",
      taskId: "task_12345678",
      cwd: "/repo",
      workflowName: "store_smoke",
      phases: [{ title: "Run" }],
      startTime: "2026-09-11T10:44:16.000Z",
    });
    await store.createRun({ state, script: "return {};" });

    const nextState = { ...state, status: "completed" as const, resultPreview: "ok" };
    await store.writeManifest(nextState);
    const outputPath = await store.writeOutput(state.runId, {
      result: { ok: true },
      logs: ["done"],
    });

    expect(
      JSON.parse(readFileSync(getWorkflowRunPaths(root, state.runId).manifestPath, "utf8")),
    ).toEqual(nextState);
    expect(outputPath).toBe(getWorkflowRunPaths(root, state.runId).outputPath);
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${JSON.stringify({ result: { ok: true }, logs: ["done"] }, null, 2)}\n`,
    );
    expect(readdirSync(getWorkflowRunPaths(root, state.runId).runDir).sort()).toEqual([
      "manifest.json",
      "output.json",
      "script.js",
    ]);
  });

  test("refuses unsafe run ids and existing run directories", async () => {
    const root = tempRoot();
    const store = new WorkflowRunStore(root);
    const state = createInitialWorkflowRunState({
      runId: "wf_safe_12345678",
      taskId: "task_12345678",
      cwd: "/repo",
      workflowName: "store_smoke",
      phases: [{ title: "Run" }],
      startTime: "2026-09-11T10:44:16.000Z",
    });

    expect(() => getWorkflowRunPaths(root, "../escape")).toThrow("unsafe workflow run id");
    await store.createRun({ state, script: "return {};" });
    await expect(store.createRun({ state, script: "return {};" })).rejects.toThrow(
      "workflow run already exists",
    );
  });
});
