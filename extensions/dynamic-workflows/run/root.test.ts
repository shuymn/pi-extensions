import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWorkflowRoot } from "./root";

const tempDirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-root-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow root resolution", () => {
  test("prefers an existing ancestor .pi/workflows root", () => {
    const repo = tempRepo();
    const existingRoot = join(repo, ".pi", "workflows");
    mkdirSync(existingRoot, { recursive: true });
    const nested = join(repo, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    expect(resolveWorkflowRoot(nested)).toBe(existingRoot);
  });

  test("falls back to cwd/.pi/workflows when no ancestor workflow root exists", () => {
    const repo = tempRepo();
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });

    expect(resolveWorkflowRoot(nested)).toBe(join(nested, ".pi", "workflows"));
  });

  test("normalizes relative cwd before resolving workflow root", () => {
    const repo = tempRepo();
    const previousCwd = process.cwd();
    try {
      process.chdir(repo);
      expect(resolveWorkflowRoot(".")).toBe(resolve(".pi", "workflows"));
    } finally {
      process.chdir(previousCwd);
    }
  });
});
