import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export function resolveWorkflowRoot(cwd: string): string {
  const start = resolve(cwd);
  let current = start;

  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, "workflows");
    if (isDirectory(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return join(start, CONFIG_DIR_NAME, "workflows");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
