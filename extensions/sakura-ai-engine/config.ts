import { readExtensionSettings } from "../../lib/settings";

export const SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS = 3_000;
export const SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS = 1;
export const SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV = "SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS";
export const SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV =
  "SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS";

export interface SakuraAiEngineSettings {
  rateLimitWindowMs?: number;
  maxConcurrentRequests?: number;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    value = Number(value);
  }
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === "") return fallback;

  const value = Number.parseInt(rawValue, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SAKURA_AI_ENGINE_SETTINGS_KEY = "sakura-ai-engine";

export function readSettings(globalPath?: string, projectPath?: string): SakuraAiEngineSettings {
  return readExtensionSettings<SakuraAiEngineSettings>(SAKURA_AI_ENGINE_SETTINGS_KEY, {
    globalPath,
    projectPath,
  });
}

export function readRateLimitConfig(settings?: SakuraAiEngineSettings) {
  const s = settings ?? readSettings();

  return {
    windowMs: readPositiveInteger(
      s.rateLimitWindowMs,
      readPositiveIntegerEnv(
        SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV,
        SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS,
      ),
    ),
    maxConcurrentRequests: readPositiveInteger(
      s.maxConcurrentRequests,
      readPositiveIntegerEnv(
        SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV,
        SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS,
      ),
    ),
  };
}
