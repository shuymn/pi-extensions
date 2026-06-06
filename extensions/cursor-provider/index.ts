import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_API,
  CURSOR_API_KEY_ENV,
  CURSOR_DISPLAY_NAME,
  CURSOR_MODELS,
  CURSOR_PROVIDER_ID,
  CURSOR_SDK_BASE_URL,
} from "./constants.js";
import { streamCursorSdk } from "./stream.js";

export * from "./constants.js";
export * from "./message.js";
export * from "./startup-output.js";
export * from "./stream.js";

export default function cursorProviderExtension(pi: ExtensionAPI): void {
  pi.registerProvider(CURSOR_PROVIDER_ID, {
    name: CURSOR_DISPLAY_NAME,
    baseUrl: CURSOR_SDK_BASE_URL,
    apiKey: `$${CURSOR_API_KEY_ENV}`,
    api: CURSOR_API,
    models: CURSOR_MODELS,
    streamSimple: streamCursorSdk,
  });
}
