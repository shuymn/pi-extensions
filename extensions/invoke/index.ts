import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createInvokeOperationRegistry, type InvokeOperation } from "./operations";
import { normalizeInvokeOperationName, parseInvokeCommandArgs } from "./parser";
import { createRuntimeReloadOperation, registerRuntimeReloadContinuation } from "./runtime-reload";

const BUSY_MESSAGE = "エージェントが処理中です。完了後に再実行してください。";

export type InvokeCommandOptions = {
  operations?: readonly InvokeOperation[];
};

export function registerInvokeCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  options: InvokeCommandOptions = {},
): void {
  const registry = createInvokeOperationRegistry(options.operations ?? []);

  pi.registerCommand("invoke", {
    description: "Invoke an allowlisted runtime operation",
    getArgumentCompletions: (argumentPrefix): AutocompleteItem[] | null => {
      const prefix = normalizeInvokeOperationName(argumentPrefix.trimStart());
      if (/\s/.test(prefix)) return null;

      const completions = [...registry.values()]
        .filter((operation) => operation.name.startsWith(prefix))
        .map((operation) => ({
          value: operation.name,
          label: operation.name,
          ...(operation.description ? { description: operation.description } : {}),
        }));

      return completions.length > 0 ? completions : null;
    },
    handler: async (commandArgs, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify(BUSY_MESSAGE, "warning");
        return;
      }

      const parsed = parseInvokeCommandArgs(commandArgs);
      if (!parsed.ok) {
        ctx.ui.notify(parsed.message, "error");
        return;
      }

      const operation = registry.get(parsed.value.operation);
      if (!operation) {
        ctx.ui.notify(`未対応の invoke operation です: ${parsed.value.operation}`, "error");
        return;
      }

      await operation.handler(parsed.value.args, ctx);
    },
  });
}

export default function invokeExtension(pi: ExtensionAPI) {
  registerRuntimeReloadContinuation(pi);
  registerInvokeCommand(pi, { operations: [createRuntimeReloadOperation(pi)] });
}
