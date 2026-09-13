import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("the package exposes /plan and /impl through native prompt discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-prompts-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({
        packages: [{ source: resolve(import.meta.dir, ".."), extensions: [] }],
      }),
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const { prompts, diagnostics } = loader.getPrompts();
    expect(diagnostics).toEqual([]);
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(["impl", "plan"]);
    for (const prompt of prompts) {
      expect(prompt.filePath).toBe(resolve(import.meta.dir, "../prompts", `${prompt.name}.md`));
      expect(prompt.content).toContain("$ARGUMENTS");
      expect(prompt.content).not.toStartWith("---");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
