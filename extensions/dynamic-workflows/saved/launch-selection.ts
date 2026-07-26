import type { SavedWorkflow } from "./resolver";

const savedWorkflowSelections = new WeakMap<object, SavedWorkflow>();

export function preserveSavedWorkflowSelection<T extends object>(
  input: T,
  workflow: SavedWorkflow,
): T {
  savedWorkflowSelections.set(input, workflow);
  return input;
}

export function savedWorkflowSelection(input: unknown): SavedWorkflow | undefined {
  return typeof input === "object" && input !== null
    ? savedWorkflowSelections.get(input)
    : undefined;
}
