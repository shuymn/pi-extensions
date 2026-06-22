import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runWorkflow } from "../runtime/runtime";
import { listSavedWorkflows, resolveSavedWorkflow } from "./resolver";

const EXAMPLE_WORKFLOW_ROOT = join(process.cwd(), ".pi", "workflows");

describe("example saved workflows", () => {
  test("are discoverable as project saved workflows", async () => {
    const workflows = await listSavedWorkflows(EXAMPLE_WORKFLOW_ROOT);

    expect(workflows.map((workflow) => workflow.name).sort()).toEqual([
      "adversarial_review",
      "repo_inspection",
    ]);
    expect(workflows).toEqual([
      expect.objectContaining({
        name: "adversarial_review",
        description: "Stress-test a change with adversarial read-only review agents",
        fileName: "adversarial-review.js",
        phases: [{ title: "Attack" }, { title: "Verify" }, { title: "Synthesize" }],
      }),
      expect.objectContaining({
        name: "repo_inspection",
        description: "Inspect a repository with a few read-only specialist agents",
        fileName: "repo-inspection.js",
        phases: [{ title: "Inspect" }, { title: "Verify" }, { title: "Synthesize" }],
      }),
    ]);
  });

  test("repo_inspection runs with fake read-only agents", async () => {
    const workflow = await resolveSavedWorkflow(EXAMPLE_WORKFLOW_ROOT, "repo_inspection");
    const calls: Array<{ prompt: string; label?: string; phase?: string }> = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: { target: "extensions/dynamic-workflows", focus: "saved workflow examples" },
      agent: (prompt, options) => {
        calls.push({ prompt, label: options.label, phase: options.phase });
        return { label: options.label, promptPreview: prompt.slice(0, 80) };
      },
    });

    expect(result.meta.name).toBe("repo_inspection");
    expect(result.agentCount).toBe(5);
    expect(result.phases).toEqual(["Inspect", "Verify", "Synthesize"]);
    expect(calls.map((call) => call.label)).toEqual([
      "structure map",
      "test surface",
      "risk scan",
      "evidence verifier",
      "inspection synthesis",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "Inspect",
      "Inspect",
      "Inspect",
      "Verify",
      "Synthesize",
    ]);
    expect(calls[0]!.prompt).toContain("extensions/dynamic-workflows");
    expect(result.result).toMatchObject({ label: "inspection synthesis" });
  });

  test("adversarial_review runs with fake read-only agents", async () => {
    const workflow = await resolveSavedWorkflow(EXAMPLE_WORKFLOW_ROOT, "adversarial_review");
    const calls: Array<{ prompt: string; label?: string; phase?: string }> = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: { target: "extensions/dynamic-workflows", claim: "workflow examples are safe" },
      agent: (prompt, options) => {
        calls.push({ prompt, label: options.label, phase: options.phase });
        return { label: options.label, promptPreview: prompt.slice(0, 80) };
      },
    });

    expect(result.meta.name).toBe("adversarial_review");
    expect(result.agentCount).toBe(6);
    expect(result.phases).toEqual(["Attack", "Verify", "Synthesize"]);
    expect(calls.map((call) => call.label)).toEqual([
      "edge attack",
      "error path attack",
      "test gap attack",
      "finding verifier",
      "verification cross-check",
      "adversarial synthesis",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "Attack",
      "Attack",
      "Attack",
      "Verify",
      "Verify",
      "Synthesize",
    ]);
    expect(calls[0]!.prompt).toContain("workflow examples are safe");
    expect(result.result).toMatchObject({ label: "adversarial synthesis" });
  });
});
