function collectTextParts(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, output);
    return;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    output.push(record.text);
  }
}

function findLatestAssistantValue<T>(
  value: unknown,
  select: (record: Record<string, unknown>) => T | undefined,
): T | undefined {
  if (!value || typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const selected = findLatestAssistantValue(value[index], select);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (record.role === "assistant") {
    return select(record);
  }

  const children = Object.values(record);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const selected = findLatestAssistantValue(children[index], select);
    if (selected !== undefined) return selected;
  }

  return undefined;
}

function findLatestAssistantMessage(value: unknown): Record<string, unknown> | undefined {
  return findLatestAssistantValue(value, (record) => record);
}

function findLatestAssistantMessageText(value: unknown): string | undefined {
  return findLatestAssistantValue(value, (record) => {
    const textParts: string[] = [];
    collectTextParts(record.content, textParts);
    return textParts.length > 0 ? textParts.join("\n") : undefined;
  });
}

export function getLatestAssistantMessageText(messages: unknown): string | undefined {
  try {
    return findLatestAssistantMessageText(messages);
  } catch {
    return undefined;
  }
}

export function latestAssistantWasAborted(messages: unknown): boolean {
  try {
    return findLatestAssistantMessage(messages)?.stopReason === "aborted";
  } catch {
    return false;
  }
}

export function getLatestAssistantError(messages: unknown): string | undefined {
  try {
    const message = findLatestAssistantMessage(messages);
    if (message?.stopReason !== "error") return undefined;
    return typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  } catch {
    return undefined;
  }
}
