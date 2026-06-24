import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type InvokeOperationHandler = (
  args: unknown | undefined,
  ctx: ExtensionCommandContext,
) => Promise<void> | void;

export type InvokeOperation = {
  name: string;
  description?: string;
  handler: InvokeOperationHandler;
};

export function createInvokeOperationRegistry(
  operations: readonly InvokeOperation[],
): Map<string, InvokeOperation> {
  return new Map(operations.map((operation) => [operation.name, operation]));
}
