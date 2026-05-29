import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

function tryReadSettingsJson(path: string): SakuraAiEngineSettings {
  try {
    if (!existsSync(path)) return {};
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const extSettings = parsed["sakura-ai-engine"];
    if (extSettings === null || typeof extSettings !== "object" || Array.isArray(extSettings))
      return {};
    return extSettings as SakuraAiEngineSettings;
  } catch {
    return {};
  }
}

export function readSettings(globalPath?: string, projectPath?: string): SakuraAiEngineSettings {
  const globalSettingsPath = globalPath ?? join(getAgentDir(), "settings.json");
  const projectSettingsPath = projectPath ?? join(process.cwd(), ".pi", "settings.json");

  const globalSettings = tryReadSettingsJson(globalSettingsPath);
  const projectSettings = tryReadSettingsJson(projectSettingsPath);

  return {
    ...globalSettings,
    ...projectSettings,
  };
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
