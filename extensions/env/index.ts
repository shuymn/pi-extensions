import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatModelSpecWithThinking, type ModelSpec, parseModelSpec } from "../../lib/model-spec";
import { projectSettingsPath, readExtensionSettings } from "../../lib/settings";
import { notifyIfUI } from "../../lib/tui";

export const ENV_SETTINGS_KEY = "env";
export const PI_MODEL_ENV = "PI_MODEL";

type EnvSettings = Partial<Record<string, unknown>>;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readPiModelValue(settings: EnvSettings): string | undefined {
  return stringValue(process.env[PI_MODEL_ENV]) ?? stringValue(settings[PI_MODEL_ENV]);
}

export function hasCliModelArg(argv: readonly string[] = process.argv): boolean {
  return argv.some(
    (arg) =>
      arg === "--model" ||
      arg.startsWith("--model=") ||
      arg === "--models" ||
      arg.startsWith("--models="),
  );
}

export function resolveEnvModelSelection(settings: EnvSettings = {}): ModelSpec | undefined {
  return parseModelSpec(readPiModelValue(settings));
}

export default function envExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (hasCliModelArg()) return;

    const settings = readExtensionSettings<EnvSettings>(ENV_SETTINGS_KEY, {
      projectPath: projectSettingsPath(ctx.cwd),
    });
    const configuredModel = resolveEnvModelSelection(settings);
    if (!configuredModel) return;

    const model = ctx.modelRegistry.find(configuredModel.provider, configuredModel.model);
    if (!model) {
      notifyIfUI(
        ctx,
        `env model が見つかりません: ${formatModelSpecWithThinking(configuredModel)}`,
        "warning",
      );
      return;
    }

    const changed = await pi.setModel(model);
    if (!changed) {
      notifyIfUI(
        ctx,
        `env model に切り替えられません: ${formatModelSpecWithThinking(configuredModel)}`,
        "warning",
      );
      return;
    }

    if (configuredModel.thinkingLevel) {
      pi.setThinkingLevel(configuredModel.thinkingLevel);
    }
  });
}
