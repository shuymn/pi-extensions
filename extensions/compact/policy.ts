import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";

import {
  type ExtensionSettingsPaths,
  projectSettingsPath,
  readExtensionSettings,
  readGlobalExtensionSettings,
} from "../../lib/settings";

export const COMPACT_TOOL_NAME = "compact_context";
export const DEFAULT_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;
export const DEFAULT_WARNING_CONTEXT_RATIO = 0.75;
export const DEFAULT_WARNING_MARGIN_TOKENS = 4_096;
const MAX_WARNING_MARGIN_CONTEXT_RATIO = 0.1;
const COMPACTION_SETTINGS_KEY = "compaction";

export type CompactRequestState =
  | { phase: "idle" }
  | {
      phase: "pending";
      customInstructions?: string;
      continuationPrompt?: string;
      stopAfterCompaction: boolean;
    }
  | { phase: "compacting" };

export type CompactScheduleOptions = {
  customInstructions?: string;
  continuationPrompt?: string;
  stopAfterCompaction?: boolean;
};

export type CompactScheduleResult =
  | { accepted: true; state: Extract<CompactRequestState, { phase: "pending" }> }
  | { accepted: false; state: CompactRequestState; reason: "pending" | "compacting" };

export type TakePendingResult =
  | {
      taken: true;
      state: Extract<CompactRequestState, { phase: "compacting" }>;
      customInstructions?: string;
      continuationPrompt?: string;
      stopAfterCompaction: boolean;
    }
  | { taken: false; state: CompactRequestState; reason: "not_pending" };

export type ContextUsageInput = {
  tokens?: number | null;
  contextWindow?: number | null;
};

export type WarningDecision =
  | {
      inject: true;
      tokens: number;
      contextWindow: number;
      reserveTokens: number;
      autoCompactThreshold: number;
      warningThreshold: number;
      warningMarginTokens: number;
    }
  | {
      inject: false;
      reason:
        | "pending"
        | "compacting"
        | "unknown_usage"
        | "invalid_context_window"
        | "invalid_reserve_tokens"
        | "no_safe_warning_window"
        | "auto_threshold_reached"
        | "not_near_threshold";
      tokens?: number;
      contextWindow?: number;
      reserveTokens?: number;
      autoCompactThreshold?: number;
      warningThreshold?: number;
      warningMarginTokens?: number;
    };

interface CompactionSettings {
  reserveTokens?: unknown;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function resolveReserveTokens(
  reserveTokens: unknown,
  fallback = DEFAULT_RESERVE_TOKENS,
): number {
  return positiveInteger(reserveTokens) ?? fallback;
}

export function readCompactionReserveTokens(paths: ExtensionSettingsPaths = {}): number {
  const settings = readExtensionSettings<CompactionSettings>(COMPACTION_SETTINGS_KEY, paths);
  const reserveTokens = positiveInteger(settings.reserveTokens);
  if (reserveTokens !== undefined) return reserveTokens;

  const globalSettings = readGlobalExtensionSettings<CompactionSettings>(
    COMPACTION_SETTINGS_KEY,
    paths.globalPath,
  );
  return resolveReserveTokens(globalSettings.reserveTokens);
}

export function readCompactionReserveTokensForCwd(cwd: string): number {
  return readCompactionReserveTokens({ projectPath: projectSettingsPath(cwd) });
}

export function initialCompactRequestState(): CompactRequestState {
  return { phase: "idle" };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function scheduleCompactRequest(
  state: CompactRequestState,
  options: CompactScheduleOptions = {},
): CompactScheduleResult {
  if (state.phase === "pending") return { accepted: false, state, reason: "pending" };
  if (state.phase === "compacting") return { accepted: false, state, reason: "compacting" };

  const customInstructions = normalizeOptionalText(options.customInstructions);
  const continuationPrompt = normalizeOptionalText(options.continuationPrompt);

  return {
    accepted: true,
    state: {
      phase: "pending",
      ...(customInstructions ? { customInstructions } : {}),
      ...(continuationPrompt ? { continuationPrompt } : {}),
      stopAfterCompaction: options.stopAfterCompaction === true,
    },
  };
}

export function takePendingCompactRequest(state: CompactRequestState): TakePendingResult {
  if (state.phase !== "pending") return { taken: false, state, reason: "not_pending" };

  return {
    taken: true,
    ...(state.customInstructions ? { customInstructions: state.customInstructions } : {}),
    ...(state.continuationPrompt ? { continuationPrompt: state.continuationPrompt } : {}),
    stopAfterCompaction: state.stopAfterCompaction,
    state: { phase: "compacting" },
  };
}

export function finishCompactRequest(): CompactRequestState {
  return initialCompactRequestState();
}

export function buildCompactWarningMessage(): string {
  return [
    "Context usage is high and Pi's built-in auto-compaction threshold is approaching.",
    "Do not start a broad new task.",
    "If all user-requested work is complete and your only remaining action is a final response or completion report, do not compact; answer the user instead.",
    `If unfinished user-requested work remains and the current atomic step is complete, call \`${COMPACT_TOOL_NAME}\` as the only tool.`,
    `If unfinished work remains but the current step is not complete, finish the smallest safe step, then call \`${COMPACT_TOOL_NAME}\`.`,
  ].join(" ");
}

export function builtInAutoCompactThreshold(
  contextWindow: unknown,
  reserveTokens: unknown,
): number | undefined {
  const windowTokens = positiveInteger(contextWindow);
  const reserve = positiveInteger(reserveTokens);
  if (windowTokens === undefined) return undefined;
  if (reserve === undefined) return undefined;

  return windowTokens - reserve;
}

function warningMarginTokens(
  contextWindow: number,
  autoCompactThreshold: number,
  requestedMargin: number,
): number {
  const fixedMargin = positiveInteger(requestedMargin) ?? DEFAULT_WARNING_MARGIN_TOKENS;
  const maxByContext = Math.floor(contextWindow * MAX_WARNING_MARGIN_CONTEXT_RATIO);
  const maxByThreshold = Math.floor(autoCompactThreshold / 2);
  return Math.min(fixedMargin, maxByContext, maxByThreshold);
}

function warningThresholdTokens({
  contextWindow,
  autoCompactThreshold,
  fallbackMargin,
}: {
  contextWindow: number;
  autoCompactThreshold: number;
  fallbackMargin: number;
}): { threshold: number; margin: number } | undefined {
  const ratioThreshold = Math.floor(contextWindow * DEFAULT_WARNING_CONTEXT_RATIO);
  if (ratioThreshold < autoCompactThreshold) {
    return { threshold: ratioThreshold, margin: autoCompactThreshold - ratioThreshold };
  }

  const margin = warningMarginTokens(contextWindow, autoCompactThreshold, fallbackMargin);
  if (margin <= 0) return undefined;
  return { threshold: autoCompactThreshold - margin, margin };
}

export function decideCompactWarning({
  usage,
  reserveTokens,
  state,
  warningMargin = DEFAULT_WARNING_MARGIN_TOKENS,
}: {
  usage: ContextUsageInput | undefined;
  reserveTokens: number;
  state: CompactRequestState;
  warningMargin?: number;
}): WarningDecision {
  if (state.phase === "pending") return { inject: false, reason: "pending" };
  if (state.phase === "compacting") return { inject: false, reason: "compacting" };

  const tokens = positiveInteger(usage?.tokens);
  if (tokens === undefined) return { inject: false, reason: "unknown_usage" };

  const contextWindow = positiveInteger(usage?.contextWindow);
  if (contextWindow === undefined)
    return { inject: false, reason: "invalid_context_window", tokens };

  const reserve = positiveInteger(reserveTokens);
  if (reserve === undefined) {
    return { inject: false, reason: "invalid_reserve_tokens", tokens, contextWindow };
  }

  const autoCompactThreshold = contextWindow - reserve;
  if (autoCompactThreshold <= 1) {
    return {
      inject: false,
      reason: "no_safe_warning_window",
      tokens,
      contextWindow,
      reserveTokens: reserve,
      autoCompactThreshold,
    };
  }

  if (tokens >= autoCompactThreshold) {
    return {
      inject: false,
      reason: "auto_threshold_reached",
      tokens,
      contextWindow,
      reserveTokens: reserve,
      autoCompactThreshold,
    };
  }

  const warningThreshold = warningThresholdTokens({
    contextWindow,
    autoCompactThreshold,
    fallbackMargin: warningMargin,
  });
  if (!warningThreshold) {
    return {
      inject: false,
      reason: "no_safe_warning_window",
      tokens,
      contextWindow,
      reserveTokens: reserve,
      autoCompactThreshold,
    };
  }

  const { threshold, margin } = warningThreshold;
  if (tokens < threshold) {
    return {
      inject: false,
      reason: "not_near_threshold",
      tokens,
      contextWindow,
      reserveTokens: reserve,
      autoCompactThreshold,
      warningThreshold: threshold,
      warningMarginTokens: margin,
    };
  }

  return {
    inject: true,
    tokens,
    contextWindow,
    reserveTokens: reserve,
    autoCompactThreshold,
    warningThreshold: threshold,
    warningMarginTokens: margin,
  };
}
