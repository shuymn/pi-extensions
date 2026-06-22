import { afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTypeboxMock } from "../../tests/support/typebox-mock";

mock.module("@earendil-works/pi-coding-agent", () => ({}));
mock.module("@earendil-works/pi-tui", () => ({
  Text: class {
    constructor(public value: string) {}
  },
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
}));
installTypeboxMock();

export async function loadWorkflowToolModule() {
  return await import("./workflow-tool");
}

const tempDirs: string[] = [];

export function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-tool-"));
  tempDirs.push(dir);
  return dir;
}

export function tempWorkflowRoot(): string {
  return join(tempCwd(), ".pi", "workflows");
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function writeWorkflowFile(root: string, fileName: string, script: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, fileName);
  writeFileSync(path, script);
  return path;
}

export function readJournalLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
