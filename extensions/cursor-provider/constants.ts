import type { SettingSource } from "@cursor/sdk";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const CURSOR_PROVIDER_ID = "cursor";
export const CURSOR_DISPLAY_NAME = "Cursor";
export const CURSOR_API = "cursor-sdk";
export const CURSOR_SDK_BASE_URL = "sdk://cursor-local-agent";
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";
export const CURSOR_COMPOSER_MODEL_ID = "composer-2.5";
// Pi supplies its own prompt, so avoid loading Cursor IDE setting layers that can conflict.
export const CURSOR_SETTING_SOURCES: SettingSource[] = [];

export const CURSOR_MODELS = [
  {
    id: CURSOR_COMPOSER_MODEL_ID,
    name: "Composer 2.5",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
] satisfies ProviderModelConfig[];
