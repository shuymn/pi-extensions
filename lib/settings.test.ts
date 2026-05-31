import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readExtensionSettings,
  readGlobalExtensionSettings,
  updateGlobalExtensionSettings,
} from "./settings";

describe("extension settings", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-extension-settings-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reads a named section from global settings", () => {
    const globalPath = join(tempDir, "settings.json");
    writeFileSync(globalPath, JSON.stringify({ feature: { enabled: true }, other: false }));

    expect(readGlobalExtensionSettings<{ enabled?: boolean }>("feature", globalPath)).toEqual({
      enabled: true,
    });
  });

  test("project settings override global settings", () => {
    const globalPath = join(tempDir, "global.json");
    const projectPath = join(tempDir, "project.json");
    writeFileSync(globalPath, JSON.stringify({ feature: { enabled: true, retries: 2 } }));
    writeFileSync(projectPath, JSON.stringify({ feature: { retries: 4 } }));

    expect(
      readExtensionSettings<{ enabled?: boolean; retries?: number }>("feature", {
        globalPath,
        projectPath,
      }),
    ).toEqual({ enabled: true, retries: 4 });
  });

  test("returns empty settings for missing, invalid, or non-object sections", () => {
    const invalidJsonPath = join(tempDir, "invalid.json");
    const nonObjectSectionPath = join(tempDir, "section.json");
    writeFileSync(invalidJsonPath, "not json");
    writeFileSync(nonObjectSectionPath, JSON.stringify({ feature: "enabled" }));

    expect(readGlobalExtensionSettings("feature", join(tempDir, "missing.json"))).toEqual({});
    expect(readGlobalExtensionSettings("feature", invalidJsonPath)).toEqual({});
    expect(readGlobalExtensionSettings("feature", nonObjectSectionPath)).toEqual({});
  });

  test("updates a global extension section while preserving unrelated settings", () => {
    const globalPath = join(tempDir, "settings.json");
    writeFileSync(globalPath, JSON.stringify({ theme: "dark", feature: { previous: "kept" } }));

    const updated = updateGlobalExtensionSettings<{ enabled?: boolean; previous?: string }>(
      "feature",
      (current) => ({ ...current, enabled: true }),
      globalPath,
    );

    expect(updated).toEqual({ previous: "kept", enabled: true });
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
      theme: "dark",
      feature: { previous: "kept", enabled: true },
    });
  });

  test("creates parent directories when updating global settings", () => {
    const globalPath = join(tempDir, "nested", "settings.json");

    updateGlobalExtensionSettings<{ enabled?: boolean }>(
      "feature",
      (current) => ({ ...current, enabled: true }),
      globalPath,
    );

    expect(existsSync(globalPath)).toBe(true);
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
      feature: { enabled: true },
    });
    expect(readdirSync(join(tempDir, "nested"))).not.toContain("settings.json.lock");
  });

  test("rejects invalid global settings without overwriting the file", () => {
    const globalPath = join(tempDir, "settings.json");
    writeFileSync(globalPath, "not json");

    expect(() =>
      updateGlobalExtensionSettings<{ enabled?: boolean }>(
        "feature",
        (current) => ({ ...current, enabled: true }),
        globalPath,
      ),
    ).toThrow();
    expect(readFileSync(globalPath, "utf8")).toBe("not json");
  });

  test("rejects non-object global settings without overwriting the file", () => {
    const globalPath = join(tempDir, "settings.json");
    writeFileSync(globalPath, JSON.stringify([]));

    expect(() =>
      updateGlobalExtensionSettings<{ enabled?: boolean }>(
        "feature",
        (current) => ({ ...current, enabled: true }),
        globalPath,
      ),
    ).toThrow("Settings file must contain a JSON object");
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual([]);
  });

  test("rejects non-object extension sections without overwriting the section", () => {
    const globalPath = join(tempDir, "settings.json");
    writeFileSync(globalPath, JSON.stringify({ feature: "enabled", theme: "dark" }));

    expect(() =>
      updateGlobalExtensionSettings<{ enabled?: boolean }>(
        "feature",
        (current) => ({ ...current, enabled: true }),
        globalPath,
      ),
    ).toThrow("Settings section must contain a JSON object");
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({
      feature: "enabled",
      theme: "dark",
    });
  });
});
