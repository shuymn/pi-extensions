import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRateLimitConfig,
  readSettings,
  SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS,
  SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV,
  SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV,
  SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS,
} from "./config";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("readSettings", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sakura-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reads from global settings.json", () => {
    const globalPath = join(tempDir, "global.json");
    writeFileSync(globalPath, JSON.stringify({ "sakura-ai-engine": { rateLimitWindowMs: 5000 } }));
    expect(readSettings(globalPath, join(tempDir, "no-project.json"))).toEqual({
      rateLimitWindowMs: 5000,
    });
  });

  test("project settings override global settings", () => {
    const globalPath = join(tempDir, "global.json");
    const projectPath = join(tempDir, "project.json");
    writeFileSync(
      globalPath,
      JSON.stringify({
        "sakura-ai-engine": { rateLimitWindowMs: 5000, maxConcurrentRequests: 1 },
      }),
    );
    writeFileSync(projectPath, JSON.stringify({ "sakura-ai-engine": { rateLimitWindowMs: 8000 } }));
    expect(readSettings(globalPath, projectPath)).toEqual({
      rateLimitWindowMs: 8000,
      maxConcurrentRequests: 1,
    });
  });

  test("returns empty object when files do not exist", () => {
    expect(readSettings(join(tempDir, "no.json"), join(tempDir, "no2.json"))).toEqual({});
  });

  test("returns empty object when sakura-ai-engine key is missing", () => {
    const path = join(tempDir, "settings.json");
    writeFileSync(path, JSON.stringify({ other: {} }));
    expect(readSettings(path, join(tempDir, "no-project.json"))).toEqual({});
  });

  test("returns empty object when sakura-ai-engine is not an object", () => {
    const path = join(tempDir, "settings.json");
    writeFileSync(path, JSON.stringify({ "sakura-ai-engine": "invalid" }));
    expect(readSettings(path, join(tempDir, "no-project.json"))).toEqual({});
  });

  test("returns empty object on parse error", () => {
    const path = join(tempDir, "settings.json");
    writeFileSync(path, "not json");
    expect(readSettings(path, join(tempDir, "no-project.json"))).toEqual({});
  });
});

describe("readRateLimitConfig", () => {
  let prevWindow: string | undefined;
  let prevConcurrency: string | undefined;

  beforeEach(() => {
    prevWindow = process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV];
    prevConcurrency = process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV];
    delete process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV];
    delete process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV];
  });

  afterEach(() => {
    restoreEnv(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV, prevWindow);
    restoreEnv(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV, prevConcurrency);
  });

  test("uses settings values when provided", () => {
    const result = readRateLimitConfig({
      rateLimitWindowMs: 5000,
      maxConcurrentRequests: 2,
    });
    expect(result.windowMs).toBe(5000);
    expect(result.maxConcurrentRequests).toBe(2);
  });

  test("falls back to env variables when settings are not provided", () => {
    process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV] = "4000";
    process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV] = "3";
    const result = readRateLimitConfig({});
    expect(result.windowMs).toBe(4000);
    expect(result.maxConcurrentRequests).toBe(3);
  });

  test("falls back to hardcoded defaults when nothing is configured", () => {
    const result = readRateLimitConfig({});
    expect(result.windowMs).toBe(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS);
    expect(result.maxConcurrentRequests).toBe(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS);
  });

  test("falls back for invalid settings values (non-numeric)", () => {
    const result = readRateLimitConfig({
      rateLimitWindowMs: "fast" as unknown as number,
      maxConcurrentRequests: null as unknown as number,
    });
    expect(result.windowMs).toBe(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS);
    expect(result.maxConcurrentRequests).toBe(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS);
  });

  test("accepts numeric string values from settings", () => {
    const result = readRateLimitConfig({
      rateLimitWindowMs: "5000" as unknown as number,
      maxConcurrentRequests: "3" as unknown as number,
    });
    expect(result.windowMs).toBe(5000);
    expect(result.maxConcurrentRequests).toBe(3);
  });

  test("rejects float values from settings", () => {
    const result = readRateLimitConfig({
      rateLimitWindowMs: 3000.5,
      maxConcurrentRequests: 1.5,
    });
    expect(result.windowMs).toBe(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS);
    expect(result.maxConcurrentRequests).toBe(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS);
  });

  test("falls back for invalid settings values (negative)", () => {
    const result = readRateLimitConfig({
      rateLimitWindowMs: -100,
      maxConcurrentRequests: -1,
    });
    expect(result.windowMs).toBe(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS);
    expect(result.maxConcurrentRequests).toBe(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS);
  });

  test("falls back for invalid settings values (zero)", () => {
    const result = readRateLimitConfig({
      rateLimitWindowMs: 0,
      maxConcurrentRequests: 0,
    });
    expect(result.windowMs).toBe(SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_MS);
    expect(result.maxConcurrentRequests).toBe(SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS);
  });

  test("settings take precedence over env variables", () => {
    process.env[SAKURA_AI_ENGINE_RATE_LIMIT_WINDOW_ENV] = "4000";
    process.env[SAKURA_AI_ENGINE_MAX_CONCURRENT_REQUESTS_ENV] = "3";
    const result = readRateLimitConfig({
      rateLimitWindowMs: 9999,
      maxConcurrentRequests: 7,
    });
    expect(result.windowMs).toBe(9999);
    expect(result.maxConcurrentRequests).toBe(7);
  });
});
