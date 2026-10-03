import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi loads the declared optional capabilities, skills and prompt templates as a package", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-package-resources-"));
  const previousHome = process.env.HOME;
  // Pi also discovers ~/.agents/skills independently of agentDir.
  process.env.HOME = dir;
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [dirname(import.meta.dir)] }),
      noContextFiles: true,
      noThemes: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const paths = loaded.extensions.map((extension) => extension.path);
    for (const name of ["goal", "one-shot", "review", "subagents", "fallback-model"]) {
      expect(paths.some((path) => path.endsWith(`/extensions/${name}/index.ts`))).toBe(true);
    }
    for (const name of ["compact", "commit", "create-pr", "dynamic-workflows"]) {
      expect(paths.some((path) => path.endsWith(`/extensions/${name}/index.ts`))).toBe(false);
    }
    expect(
      loader
        .getSkills()
        .skills.map((skill) => skill.name)
        .sort(),
    ).toEqual(["research", "review"]);
    expect(
      loader
        .getPrompts()
        .prompts.map((prompt) => prompt.name)
        .sort(),
    ).toEqual(["impl", "plan"]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
