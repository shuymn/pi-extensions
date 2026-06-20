import { existsSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export function resolveWorkflowRoot(cwd: string): string {
  const start = resolve(cwd);
  let current = start;

  while (true) {
    const candidate = join(current, ".pi", "workflows");
    if (isDirectory(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }

  return join(start, ".pi", "workflows");
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
