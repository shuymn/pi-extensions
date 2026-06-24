export type ParsedInvokeCommandArgs = {
  operation: string;
  args?: unknown;
};

export type InvokeCommandParseResult =
  | { ok: true; value: ParsedInvokeCommandArgs }
  | { ok: false; reason: "missing_operation" | "invalid_json"; message: string };

const USAGE = "使い方: /invoke <operation> [JSON args]";

export function parseInvokeCommandArgs(input: string): InvokeCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "missing_operation", message: USAGE };

  const operationEnd = trimmed.search(/\s/);
  const rawOperation = operationEnd === -1 ? trimmed : trimmed.slice(0, operationEnd);
  const operation = normalizeInvokeOperationName(rawOperation);
  const argsText = operationEnd === -1 ? "" : trimmed.slice(operationEnd).trim();
  if (!operation) return { ok: false, reason: "missing_operation", message: USAGE };
  if (!argsText) return { ok: true, value: { operation } };

  try {
    return { ok: true, value: { operation, args: JSON.parse(argsText) } };
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_json",
      message: `args は JSON として指定してください: ${errorMessage(error)}`,
    };
  }
}

export function normalizeInvokeOperationName(operation: string): string {
  return operation.startsWith("/") ? operation.slice(1) : operation;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
