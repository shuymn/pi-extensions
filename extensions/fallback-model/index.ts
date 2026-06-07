import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { notifyIfUI } from "../../lib/tui";

export const FALLBACK_MODEL_FLAG = "fallback-model";

const THINKING_LEVEL_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_VALUES);
const RETRYABLE_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|model.?unavailable|model.?not.?available|model.?not.?found/i;
const NON_FALLBACK_ERROR_PATTERN =
  /\b(401|403|unauthorized|forbidden|invalid api key|authentication|authorization)\b/i;

type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];

type FallbackModelSpec = {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
};

export function parseFallbackModelList(raw: unknown): FallbackModelSpec[] {
  if (typeof raw !== "string") return [];

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseFallbackModelEntry)
    .filter((entry): entry is FallbackModelSpec => entry !== undefined);
}

function parseFallbackModelEntry(entry: string): FallbackModelSpec | undefined {
  const slashIndex = entry.indexOf("/");
  if (slashIndex <= 0 || slashIndex === entry.length - 1) return undefined;

  const provider = entry.slice(0, slashIndex).trim();
  let model = entry.slice(slashIndex + 1).trim();
  if (!provider || !model) return undefined;

  const colonIndex = model.lastIndexOf(":");
  const suffix =
    colonIndex === -1
      ? ""
      : model
          .slice(colonIndex + 1)
          .trim()
          .toLowerCase();
  const thinkingLevel = THINKING_LEVELS.has(suffix) ? (suffix as ThinkingLevel) : undefined;
  if (thinkingLevel) {
    model = model.slice(0, colonIndex).trim();
    if (!model) return undefined;
  }

  return { provider, model, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

export function shouldFallbackForError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== "string" || errorMessage.trim() === "") return false;
  if (NON_FALLBACK_ERROR_PATTERN.test(errorMessage)) return false;
  return RETRYABLE_ERROR_PATTERN.test(errorMessage);
}

function sameModel(
  model: { provider?: string; id?: string } | undefined,
  spec: Pick<FallbackModelSpec, "provider" | "model">,
): boolean {
  return model?.provider === spec.provider && model.id === spec.model;
}

function displayModel(spec: FallbackModelSpec): string {
  return `${spec.provider}/${spec.model}${spec.thinkingLevel ? `:${spec.thinkingLevel}` : ""}`;
}

function retryableErrorMessage(errorMessage: unknown): string {
  const text =
    typeof errorMessage === "string" ? errorMessage : String(errorMessage ?? "unknown error");
  return `provider returned error: fallback model selected after: ${text}`;
}

export default function fallbackModelExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FALLBACK_MODEL_FLAG, {
    description:
      'Comma-separated fallback models, e.g. "provider/model,provider/model:high". Put thinking level in the final colon segment.',
    type: "string",
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (!shouldFallbackForError(message.errorMessage)) return;

    const fallbackModels = parseFallbackModelList(pi.getFlag(FALLBACK_MODEL_FLAG));
    if (fallbackModels.length === 0) return;

    for (const fallback of fallbackModels) {
      if (sameModel(ctx.model, fallback)) continue;

      const model = ctx.modelRegistry.find(fallback.provider, fallback.model);
      if (!model) continue;

      const changed = await pi.setModel(model);
      if (!changed) continue;

      if (fallback.thinkingLevel) {
        pi.setThinkingLevel(fallback.thinkingLevel);
      }

      notifyIfUI(ctx, `Fallback model に切り替えます: ${displayModel(fallback)}`, "warning");

      return {
        message: {
          ...message,
          errorMessage: retryableErrorMessage(message.errorMessage),
        },
      };
    }
  });
}
