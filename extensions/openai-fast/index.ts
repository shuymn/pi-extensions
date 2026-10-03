import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  isOpenAIResponsesModel,
  OPENAI_FAST_STATUS_KEY,
  OPENAI_FAST_STATUS_ON,
} from "../../lib/openai-fast";
import { readGlobalExtensionSettings, updateGlobalExtensionSettings } from "../../lib/settings";
import { notifyIfUI } from "../../lib/tui";

const FAST_SERVICE_TIER = "priority";
const OPENAI_FAST_SETTINGS_KEY = "openai-fast";
const USAGE = "使い方: /openai-fast [on|off|toggle|status]";

interface OpenAIFastSettings {
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function applyOpenAIFastServiceTier(
  payload: unknown,
  model: unknown,
  enabled: boolean,
): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  if (!isOpenAIResponsesModel(model)) return undefined;
  if (!isRecord(payload)) return undefined;

  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function readPersistedEnabled(): boolean {
  const current = readGlobalExtensionSettings<OpenAIFastSettings>(OPENAI_FAST_SETTINGS_KEY);
  const enabled =
    current.enabled ?? readGlobalExtensionSettings<OpenAIFastSettings>("codex-fast").enabled;
  return enabled === true;
}

function persistEnabled(enabled: boolean): void {
  updateGlobalExtensionSettings<OpenAIFastSettings>(OPENAI_FAST_SETTINGS_KEY, (current) => ({
    ...current,
    enabled,
  }));
}

function setStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">, enabled: boolean): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(OPENAI_FAST_STATUS_KEY, enabled ? OPENAI_FAST_STATUS_ON : undefined);
}

export default function openaiFastExtension(pi: ExtensionAPI): void {
  let enabled = readPersistedEnabled();
  let removeFastProvider: (() => void) | undefined;

  function setEnabled(nextEnabled: boolean, ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
    persistEnabled(nextEnabled);
    enabled = nextEnabled;
    setStatus(ctx, enabled);
    notifyIfUI(
      ctx,
      enabled ? "OpenAI fast mode を有効化しました。" : "OpenAI fast mode を無効化しました。",
      "info",
    );
  }

  pi.registerCommand("openai-fast", {
    description: "Control OpenAI Responses fast service tier with global settings persistence",
    handler: async (args, ctx) => {
      const command = args.trim() || "on";

      if (command === "on") {
        setEnabled(true, ctx);
        return;
      }

      if (command === "off") {
        setEnabled(false, ctx);
        return;
      }

      if (command === "toggle") {
        setEnabled(!enabled, ctx);
        return;
      }

      if (command === "status") {
        notifyIfUI(
          ctx,
          enabled ? "OpenAI fast mode は有効です。" : "OpenAI fast mode は無効です。",
          "info",
        );
        setStatus(ctx, enabled);
        return;
      }

      notifyIfUI(ctx, USAGE, "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = readPersistedEnabled();
    installFastProvider(ctx);
    setStatus(ctx, enabled);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    removeFastProvider?.();
    removeFastProvider = undefined;
    setStatus(ctx, false);
  });

  function installFastProvider(ctx: ExtensionContext): void {
    if (removeFastProvider) return;

    const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider("openai");
    const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig("openai");
    // The runtime's built-in has the persisted/remote catalog overlay. A fresh
    // openaiProvider() would lose its dynamic getters and refreshModels hook.
    const provider = nativeProvider ?? ctx.modelRegistry.getProvider("openai");
    if (!provider) return;

    function fastSamplingParams(model: unknown, current?: Record<string, unknown>) {
      return applyOpenAIFastServiceTier(current ?? {}, model, enabled) ?? current;
    }
    // Provider dispatch receives the physical request model, unlike ctx.model,
    // which can change while authentication is pending or represent a virtual model.
    const fastProvider: Provider = {
      ...provider,
      stream(model, context, options) {
        // Keep the dispatched API's conditional option type while copying its options.
        const streamOptions = Object.assign({}, options);
        streamOptions.samplingParams = fastSamplingParams(model, options?.samplingParams);
        return provider.stream(model, context, streamOptions);
      },
      streamSimple(model, context, options) {
        return provider.streamSimple(model, context, {
          ...options,
          samplingParams: fastSamplingParams(model, options?.samplingParams),
        });
      },
    };
    pi.registerProvider(fastProvider);
    removeFastProvider = () => {
      if (ctx.modelRegistry.getRegisteredNativeProvider("openai") !== fastProvider) return;
      // Do not leave an old enabled-state closure installed across /reload.
      if (nativeProvider) pi.registerProvider(nativeProvider);
      else if (providerConfig) pi.registerProvider("openai", providerConfig);
      else pi.unregisterProvider("openai");
    };
  }
}
