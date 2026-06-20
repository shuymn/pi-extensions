import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSavedWorkflows, resolveSavedWorkflow } from "./resolver";

const tempDirs: string[] = [];

function tempWorkflowRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-saved-workflows-"));
  tempDirs.push(dir);
  return join(dir, ".pi", "workflows");
}

function writeSavedWorkflow(root: string, fileName: string, script: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, fileName);
  writeFileSync(path, script);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("saved workflow resolver", () => {
  test("lists saved .js workflows by static meta parsing without executing scripts", async () => {
    const root = tempWorkflowRoot();
    const path = writeSavedWorkflow(
      root,
      "repo-review.js",
      `
        export const meta = {
          name: "repo_review",
          description: "Review the repository",
          phases: [{ title: "Review" }, { title: "Synthesize" }],
        };

        throw new Error("saved workflow discovery must not execute this script");
      `,
    );
    writeSavedWorkflow(root, "not-a-workflow.txt", "ignored");
    writeSavedWorkflow(root, "invalid.js", "export const nope = {};\n");
    mkdirSync(join(root, "wf_run_12345678"), { recursive: true });
    writeFileSync(
      join(root, "wf_run_12345678", "script.js"),
      `export const meta = { name: "run_artifact", phases: [{ title: "Run" }] };`,
    );

    await expect(listSavedWorkflows(root)).resolves.toEqual([
      {
        name: "repo_review",
        description: "Review the repository",
        phases: [{ title: "Review" }, { title: "Synthesize" }],
        path,
        fileName: "repo-review.js",
        script: expect.stringContaining("saved workflow discovery must not execute"),
      },
    ]);
  });

  test("returns an empty list when the workflow root does not exist", async () => {
    await expect(listSavedWorkflows(join(tempWorkflowRoot(), "missing"))).resolves.toEqual([]);
  });

  test("lists and resolves workflows from project and skill-packaged roots", async () => {
    const projectRoot = tempWorkflowRoot();
    const packageRoot = mkdtempSync(join(tmpdir(), "pi-skill-packaged-workflows-"));
    tempDirs.push(packageRoot);
    const skillWorkflowRoot = join(packageRoot, "skills", "deep-research", "workflows");
    const skillPath = writeSavedWorkflow(
      skillWorkflowRoot,
      "deep-research.js",
      `export const meta = { name: "deep_research", description: "Skill packaged research", phases: [{ title: "Research" }] };
return await agent("research");`,
    );
    const projectPath = writeSavedWorkflow(
      projectRoot,
      "repo-review.js",
      `export const meta = { name: "repo_review", phases: [{ title: "Review" }] };
return await agent("review");`,
    );
    const projectShadowPath = writeSavedWorkflow(
      projectRoot,
      "shadowed.js",
      `export const meta = { name: "shadowed", description: "Project override", phases: [{ title: "Run" }] };
return await agent("project");`,
    );
    writeSavedWorkflow(
      skillWorkflowRoot,
      "shadowed.js",
      `export const meta = { name: "shadowed", description: "Skill default", phases: [{ title: "Run" }] };
return await agent("skill");`,
    );

    const workflows = await listSavedWorkflows([projectRoot, skillWorkflowRoot]);

    expect(workflows.map((workflow) => workflow.name).sort()).toEqual([
      "deep_research",
      "repo_review",
      "shadowed",
      "shadowed",
    ]);
    await expect(
      resolveSavedWorkflow([projectRoot, skillWorkflowRoot], "deep_research"),
    ).resolves.toMatchObject({
      name: "deep_research",
      path: skillPath,
    });
    await expect(
      resolveSavedWorkflow([projectRoot, skillWorkflowRoot], "repo_review"),
    ).resolves.toMatchObject({
      name: "repo_review",
      path: projectPath,
    });
    await expect(
      resolveSavedWorkflow([projectRoot, skillWorkflowRoot], "shadowed"),
    ).resolves.toMatchObject({
      name: "shadowed",
      description: "Project override",
      path: projectShadowPath,
    });
  });

  test("resolves saved workflows by meta.name and reports missing or duplicate names", async () => {
    const root = tempWorkflowRoot();
    const firstPath = writeSavedWorkflow(
      root,
      "first.js",
      `export const meta = { name: "first", phases: [{ title: "Run" }] };\nreturn await agent("first");`,
    );
    writeSavedWorkflow(
      root,
      "duplicate-a.js",
      `export const meta = { name: "duplicate", phases: [{ title: "Run" }] };\nreturn await agent("a");`,
    );
    writeSavedWorkflow(
      root,
      "duplicate-b.js",
      `export const meta = { name: "duplicate", phases: [{ title: "Run" }] };\nreturn await agent("b");`,
    );

    await expect(resolveSavedWorkflow(root, "first")).resolves.toMatchObject({
      name: "first",
      path: firstPath,
      script: expect.stringContaining('agent("first")'),
    });
    await expect(resolveSavedWorkflow(root, "missing")).rejects.toThrow("saved workflow not found");
    await expect(resolveSavedWorkflow(root, "duplicate")).rejects.toThrow(
      "multiple saved workflows named",
    );
  });
});
