import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowCatalogForRoot } from "./catalog";

const tempDirs: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeWorkflow(root: string, fileName: string, script: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, fileName);
  writeFileSync(path, script);
  return path;
}

function workflowScript(name: string, description: string): string {
  return `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(
    description,
  )}, phases: [{ title: "Run" }] };\nreturn await agent("run");`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowCatalog provenance", () => {
  test("tags project, skill, and extension roots and orders project first", async () => {
    const projectRoot = join(tempRoot("pi-catalog-project-"), ".pi", "workflows");
    const skillRoot = join(tempRoot("pi-catalog-skill-"), "skills", "research", "workflows");
    const extensionRoot = join(tempRoot("pi-catalog-extension-"), "workflows");
    writeWorkflow(projectRoot, "p.js", workflowScript("project_flow", "project"));
    writeWorkflow(skillRoot, "s.js", workflowScript("skill_flow", "skill"));
    writeWorkflow(extensionRoot, "e.js", workflowScript("extension_flow", "extension"));

    const catalog = workflowCatalogForRoot(projectRoot, [
      skillRoot,
      { path: extensionRoot, source: "extension" },
    ]);

    expect(catalog.roots.rootDescriptors).toEqual([
      { path: projectRoot, source: "project" },
      { path: skillRoot, source: "skill" },
      { path: extensionRoot, source: "extension" },
    ]);

    const workflows = await catalog.list();
    expect(workflows.map((workflow) => [workflow.name, workflow.source])).toEqual([
      ["extension_flow", "extension"],
      ["project_flow", "project"],
      ["skill_flow", "skill"],
    ]);
  });

  test("project workflow overrides a same-named extension-packaged workflow", async () => {
    const projectRoot = join(tempRoot("pi-catalog-project-"), ".pi", "workflows");
    const extensionRoot = join(tempRoot("pi-catalog-extension-"), "workflows");
    const projectPath = writeWorkflow(
      projectRoot,
      "review-flow.js",
      workflowScript("review_flow", "project override"),
    );
    writeWorkflow(
      extensionRoot,
      "review-flow.js",
      workflowScript("review_flow", "extension default"),
    );

    const catalog = workflowCatalogForRoot(projectRoot, [
      { path: extensionRoot, source: "extension" },
    ]);

    await expect(catalog.resolve("review_flow")).resolves.toMatchObject({
      name: "review_flow",
      description: "project override",
      path: projectPath,
      source: "project",
    });
  });

  test("listProjectSaved ignores skill and extension roots", async () => {
    const projectRoot = join(tempRoot("pi-catalog-project-"), ".pi", "workflows");
    const extensionRoot = join(tempRoot("pi-catalog-extension-"), "workflows");
    writeWorkflow(projectRoot, "p.js", workflowScript("project_flow", "project"));
    writeWorkflow(extensionRoot, "e.js", workflowScript("extension_flow", "extension"));

    const catalog = workflowCatalogForRoot(projectRoot, [
      { path: extensionRoot, source: "extension" },
    ]);

    const projectSaved = await catalog.listProjectSaved();
    expect(projectSaved.map((workflow) => workflow.name)).toEqual(["project_flow"]);
    expect(projectSaved.every((workflow) => workflow.source === "project")).toBe(true);
  });

  test("extension-packaged workflows are never offered as direct slash commands", async () => {
    const projectRoot = join(tempRoot("pi-catalog-project-"), ".pi", "workflows");
    const extensionRoot = join(tempRoot("pi-catalog-extension-"), "workflows");
    writeWorkflow(projectRoot, "p.js", workflowScript("project_flow", "project"));
    writeWorkflow(extensionRoot, "e.js", workflowScript("extension_flow", "extension"));

    const catalog = workflowCatalogForRoot(projectRoot, [
      { path: extensionRoot, source: "extension" },
    ]);

    // Direct command registration only ever considers project saved workflows.
    const candidates = catalog.directCommandCandidates(await catalog.listProjectSaved(), {
      isNameSafe: () => true,
      takenCommandNames: new Set<string>(),
    });
    expect(candidates.map((candidate) => candidate.workflow.name)).toEqual(["project_flow"]);
    expect(candidates.every((candidate) => candidate.canRegister)).toBe(true);
  });
});
