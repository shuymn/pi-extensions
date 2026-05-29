import { afterEach, beforeEach } from "bun:test";

/**
 * Snapshots the given environment variables and clears them before each test,
 * then restores their original values afterward. Call inside a describe block.
 */
export function isolateEnvVars(keys: readonly string[]): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });
}
