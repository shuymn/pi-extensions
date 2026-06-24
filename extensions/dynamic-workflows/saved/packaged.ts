import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowRootDescriptor } from "./resolver";

export const EXTENSION_PACKAGED_WORKFLOWS_DIRNAME = "workflows";

/**
 * Absolute path to the official workflows packaged with this Pi Extension
 * package, resolved relative to this module so it works regardless of the
 * caller's cwd. Scripts placed here are discovered by `meta.name` like project
 * and skill-packaged workflows, but a project `.pi/workflows/<name>.js` with
 * the same `meta.name` still wins.
 */
export function extensionPackagedWorkflowRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", EXTENSION_PACKAGED_WORKFLOWS_DIRNAME);
}

export function extensionPackagedWorkflowRootDescriptors(): WorkflowRootDescriptor[] {
  return [{ path: extensionPackagedWorkflowRoot(), source: "extension" }];
}
