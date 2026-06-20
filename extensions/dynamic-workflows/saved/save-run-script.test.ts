import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitialWorkflowRunState } from "../run/model";
import { WorkflowRunStore } from "../run/store";
import { savedWorkflowScriptPath, saveWorkflowRunScript } from "./save-run-script";

const tempDirs: string[] = [];

function tempWorkflowRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-save-run-script-"));
  tempDirs.push(dir);
  return join(dir, ".pi", "workflows");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("saveWorkflowRunScript", () => {
  test("copies only the executed run script into the saved workflow file", async () => {
    const workflowRoot = tempWorkflowRoot();
    const runId = "wf_save_12345678";
    const script = `
      export const meta = {
        name: "repo_audit",
        description: "Audit repository",
        phases: [{ title: "Audit" }],
      };
      return await agent("audit", { label: "audit" });
    `;
    const store = new WorkflowRunStore(workflowRoot);
    const paths = await store.createRun({
      state: createInitialWorkflowRunState({
        runId,
        taskId: "task_save_12345678",
        cwd: "/repo",
        workflowName: "repo_audit",
        description: "Audit repository",
        phases: [{ title: "Audit" }],
        scriptPath: join(workflowRoot, runId, "script.js"),
      }),
      script,
    });
    await store.writeOutput(runId, { status: "completed", result: { ok: true } });
    writeFileSync(paths.journalPath, `${JSON.stringify({ type: "started", key: "v1:key" })}\n`);
    mkdirSync(paths.transcriptsDir, { recursive: true });
    writeFileSync(join(paths.transcriptsDir, "0001-audit.json"), "{}\n");

    const saved = await saveWorkflowRunScript({ runId }, { workflowRoot });

    expect(saved).toEqual({
      runId,
      name: "repo_audit",
      path: join(workflowRoot, "repo_audit.js"),
      sourcePath: paths.scriptPath,
    });
    expect(readFileSync(saved.path, "utf8")).toBe(script);
    expect(existsSync(join(workflowRoot, "repo_audit", "manifest.json"))).toBe(false);
    expect(readdirSync(workflowRoot).sort()).toEqual(["repo_audit.js", runId]);
    expect(readdirSync(paths.runDir).sort()).toEqual([
      "journal.jsonl",
      "manifest.json",
      "output.json",
      "script.js",
      "transcripts",
    ]);
  });

  test("reports missing run scripts, invalid workflow scripts, and unsafe saved names", async () => {
    const workflowRoot = tempWorkflowRoot();

    await expect(
      saveWorkflowRunScript({ runId: "wf_missing_12345678" }, { workflowRoot }),
    ).rejects.toThrow("workflow run script is unavailable");

    const invalidRunId = "wf_invalid_12345678";
    mkdirSync(join(workflowRoot, invalidRunId), { recursive: true });
    writeFileSync(
      join(workflowRoot, invalidRunId, "script.js"),
      "return await agent('missing meta');\n",
    );
    await expect(saveWorkflowRunScript({ runId: invalidRunId }, { workflowRoot })).rejects.toThrow(
      "export const meta",
    );

    const unsafeRunId = "wf_unsafe_12345678";
    mkdirSync(join(workflowRoot, unsafeRunId), { recursive: true });
    writeFileSync(
      join(workflowRoot, unsafeRunId, "script.js"),
      `export const meta = { name: "../escape", phases: [{ title: "Run" }] };
       return await agent("unsafe");`,
    );
    await expect(saveWorkflowRunScript({ runId: unsafeRunId }, { workflowRoot })).rejects.toThrow(
      "unsafe saved workflow name",
    );
  });

  test("builds saved workflow paths directly under the workflow root", () => {
    expect(savedWorkflowScriptPath("/repo/.pi/workflows", "review-flow")).toBe(
      "/repo/.pi/workflows/review-flow.js",
    );
    expect(() => savedWorkflowScriptPath("/repo/.pi/workflows", "nested/review")).toThrow(
      "unsafe saved workflow name",
    );
  });
});
