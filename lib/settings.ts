import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type JsonSettingsObject = Record<string, unknown>;

const SETTINGS_LOCK_RETRY_COUNT = 10;
const SETTINGS_LOCK_RETRY_DELAY_MS = 20;
const SETTINGS_LOCK_STALE_MS = 30_000;

export interface ExtensionSettingsPaths {
  globalPath?: string;
  projectPath?: string;
}

function isPlainObject(value: unknown): value is JsonSettingsObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd = process.cwd()): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

export function readSettingsJson(path: string): JsonSettingsObject {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readSectionFromSettings<T extends object>(
  settings: JsonSettingsObject,
  sectionKey: string,
): Partial<T> {
  const section = settings[sectionKey];
  return isPlainObject(section) ? (section as Partial<T>) : {};
}

function readSettingsJsonForUpdate(path: string): JsonSettingsObject {
  if (!existsSync(path)) return {};

  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainObject(parsed)) {
    throw new Error(`Settings file must contain a JSON object: ${path}`);
  }
  return parsed;
}

function readSectionForUpdate<T extends object>(
  settings: JsonSettingsObject,
  sectionKey: string,
): Partial<T> {
  const section = settings[sectionKey];
  if (section === undefined) return {};
  if (!isPlainObject(section)) {
    throw new Error(`Settings section must contain a JSON object: ${sectionKey}`);
  }
  return section as Partial<T>;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isStaleLock(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > SETTINGS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function acquireSettingsLock(settingsPath: string): () => void {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const lockPath = `${settingsPath}.lock`;
  let lastError: unknown;

  for (let attempt = 0; attempt <= SETTINGS_LOCK_RETRY_COUNT; attempt++) {
    try {
      mkdirSync(lockPath);
      return () => rmdirSync(lockPath);
    } catch (error) {
      lastError = error;
      if (isStaleLock(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (attempt === SETTINGS_LOCK_RETRY_COUNT) break;
      sleepSync(SETTINGS_LOCK_RETRY_DELAY_MS);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to acquire settings lock: ${lockPath}`);
}

function readExtensionSettingsSection<T extends object>(
  sectionKey: string,
  path: string,
): Partial<T> {
  return readSectionFromSettings<T>(readSettingsJson(path), sectionKey);
}

export function readGlobalExtensionSettings<T extends object>(
  sectionKey: string,
  path = globalSettingsPath(),
): Partial<T> {
  return readExtensionSettingsSection<T>(sectionKey, path);
}

export function readExtensionSettings<T extends object>(
  sectionKey: string,
  paths: ExtensionSettingsPaths = {},
): Partial<T> {
  const globalSettings = readExtensionSettingsSection<T>(
    sectionKey,
    paths.globalPath ?? globalSettingsPath(),
  );
  const projectSettings = readExtensionSettingsSection<T>(
    sectionKey,
    paths.projectPath ?? projectSettingsPath(),
  );

  return {
    ...globalSettings,
    ...projectSettings,
  };
}

function writeSettingsJson(path: string, settings: JsonSettingsObject): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function updateGlobalExtensionSettings<T extends object>(
  sectionKey: string,
  updater: (current: Partial<T>) => Partial<T>,
  path = globalSettingsPath(),
): Partial<T> {
  const releaseLock = acquireSettingsLock(path);
  try {
    const settings = readSettingsJsonForUpdate(path);
    const current = readSectionForUpdate<T>(settings, sectionKey);
    const next = updater({ ...current });

    settings[sectionKey] = next;
    writeSettingsJson(path, settings);

    return next;
  } finally {
    releaseLock();
  }
}
