import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CODEX_FAST_STATUS_KEY,
  CODEX_FAST_STATUS_ON,
  isOpenAICodexModel,
} from "../../lib/codex-fast";
import { readGlobalExtensionSettings, updateGlobalExtensionSettings } from "../../lib/settings";
import { notifyIfUI } from "../../lib/tui";

const FAST_SERVICE_TIER = "priority";
const CODEX_FAST_SETTINGS_KEY = "codex-fast";
const USAGE = "使い方: /codex-fast [on|off|toggle|status]";

interface CodexFastSettings {
  enabled?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function applyCodexFastServiceTier(
  payload: unknown,
  model: unknown,
  enabled: boolean,
): Record<string, unknown> | undefined {
  if (!enabled) return undefined;
  if (!isOpenAICodexModel(model)) return undefined;
  if (!isRecord(payload)) return undefined;

  return { ...payload, service_tier: FAST_SERVICE_TIER };
}

function readPersistedEnabled(): boolean {
  return readGlobalExtensionSettings<CodexFastSettings>(CODEX_FAST_SETTINGS_KEY).enabled === true;
}

function persistEnabled(enabled: boolean): void {
  updateGlobalExtensionSettings<CodexFastSettings>(CODEX_FAST_SETTINGS_KEY, (current) => ({
    ...current,
    enabled,
  }));
}

function setStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui">, enabled: boolean): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, enabled ? CODEX_FAST_STATUS_ON : undefined);
}

export default function codexFastExtension(pi: ExtensionAPI): void {
  let enabled = readPersistedEnabled();

  function setEnabled(nextEnabled: boolean, ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
    persistEnabled(nextEnabled);
    enabled = nextEnabled;
    setStatus(ctx, enabled);
    notifyIfUI(
      ctx,
      enabled ? "Codex fast mode を有効化しました。" : "Codex fast mode を無効化しました。",
      "info",
    );
  }

  pi.registerCommand("codex-fast", {
    description: "Control OpenAI Codex fast service tier with global settings persistence",
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
          enabled ? "Codex fast mode は有効です。" : "Codex fast mode は無効です。",
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
    setStatus(ctx, enabled);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    setStatus(ctx, false);
  });

  pi.on("before_provider_request", (event, ctx) =>
    applyCodexFastServiceTier(event.payload, ctx.model, enabled),
  );
}
