export const RUNTIME_RELOAD_OPERATION_NAME = "runtime.reload";
export const RUNTIME_RELOAD_MARKER_CUSTOM_TYPE = "invoke-runtime-reload";
export const RUNTIME_RELOAD_CONTINUATION_CUSTOM_TYPE = "invoke-runtime-reload-continuation";

const MARKER_VERSION = 1;

export type ArmedRuntimeReloadMarker = {
  version: typeof MARKER_VERSION;
  operation: typeof RUNTIME_RELOAD_OPERATION_NAME;
  status: "armed";
  invocationId: string;
  continuationPrompt?: string;
  stopAfterReload: boolean;
  createdAt: string;
};

export type ConsumedRuntimeReloadMarker = {
  version: typeof MARKER_VERSION;
  operation: typeof RUNTIME_RELOAD_OPERATION_NAME;
  status: "consumed";
  invocationId: string;
  consumedAt: string;
};

export type FailedRuntimeReloadMarker = {
  version: typeof MARKER_VERSION;
  operation: typeof RUNTIME_RELOAD_OPERATION_NAME;
  status: "failed";
  invocationId: string;
  errorMessage: string;
  failedAt: string;
};

export type RuntimeReloadMarker =
  | ArmedRuntimeReloadMarker
  | ConsumedRuntimeReloadMarker
  | FailedRuntimeReloadMarker;

type CustomEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

export function createArmedRuntimeReloadMarker(input: {
  invocationId: string;
  continuationPrompt?: string;
  stopAfterReload: boolean;
  now?: () => string;
}): ArmedRuntimeReloadMarker {
  return {
    version: MARKER_VERSION,
    operation: RUNTIME_RELOAD_OPERATION_NAME,
    status: "armed",
    invocationId: input.invocationId,
    ...(input.continuationPrompt ? { continuationPrompt: input.continuationPrompt } : {}),
    stopAfterReload: input.stopAfterReload,
    createdAt: (input.now ?? isoNow)(),
  };
}

export function createConsumedRuntimeReloadMarker(
  marker: Pick<ArmedRuntimeReloadMarker, "invocationId">,
  now: () => string = isoNow,
): ConsumedRuntimeReloadMarker {
  return {
    version: MARKER_VERSION,
    operation: RUNTIME_RELOAD_OPERATION_NAME,
    status: "consumed",
    invocationId: marker.invocationId,
    consumedAt: now(),
  };
}

export function createFailedRuntimeReloadMarker(
  marker: Pick<ArmedRuntimeReloadMarker, "invocationId">,
  errorMessage: string,
  now: () => string = isoNow,
): FailedRuntimeReloadMarker {
  return {
    version: MARKER_VERSION,
    operation: RUNTIME_RELOAD_OPERATION_NAME,
    status: "failed",
    invocationId: marker.invocationId,
    errorMessage,
    failedAt: now(),
  };
}

export function findPendingRuntimeReloadMarker(
  entries: readonly unknown[],
): ArmedRuntimeReloadMarker | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const marker = readRuntimeReloadMarker(entries[index]);
    if (!marker) continue;
    if (marker.status === "armed") return marker;
    return undefined;
  }

  return undefined;
}

export function readRuntimeReloadMarker(entry: unknown): RuntimeReloadMarker | undefined {
  if (!isObject(entry)) return undefined;
  const candidate = entry as CustomEntryLike;
  if (candidate.type !== "custom" || candidate.customType !== RUNTIME_RELOAD_MARKER_CUSTOM_TYPE) {
    return undefined;
  }

  return parseRuntimeReloadMarkerData(candidate.data);
}

function parseRuntimeReloadMarkerData(data: unknown): RuntimeReloadMarker | undefined {
  if (!isObject(data)) return undefined;
  if (data.version !== MARKER_VERSION) return undefined;
  if (data.operation !== RUNTIME_RELOAD_OPERATION_NAME) return undefined;
  if (typeof data.invocationId !== "string" || !data.invocationId) return undefined;

  if (data.status === "armed") {
    if (typeof data.stopAfterReload !== "boolean") return undefined;
    if (typeof data.createdAt !== "string") return undefined;
    if (data.continuationPrompt !== undefined && typeof data.continuationPrompt !== "string") {
      return undefined;
    }

    return {
      version: MARKER_VERSION,
      operation: RUNTIME_RELOAD_OPERATION_NAME,
      status: "armed",
      invocationId: data.invocationId,
      ...(data.continuationPrompt ? { continuationPrompt: data.continuationPrompt } : {}),
      stopAfterReload: data.stopAfterReload,
      createdAt: data.createdAt,
    };
  }

  if (data.status === "consumed") {
    if (typeof data.consumedAt !== "string") return undefined;
    return {
      version: MARKER_VERSION,
      operation: RUNTIME_RELOAD_OPERATION_NAME,
      status: "consumed",
      invocationId: data.invocationId,
      consumedAt: data.consumedAt,
    };
  }

  if (data.status === "failed") {
    if (typeof data.errorMessage !== "string") return undefined;
    if (typeof data.failedAt !== "string") return undefined;
    return {
      version: MARKER_VERSION,
      operation: RUNTIME_RELOAD_OPERATION_NAME,
      status: "failed",
      invocationId: data.invocationId,
      errorMessage: data.errorMessage,
      failedAt: data.failedAt,
    };
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoNow(): string {
  return new Date().toISOString();
}
