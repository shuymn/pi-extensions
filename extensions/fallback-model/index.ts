import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatModelSpecWithThinking, type ModelSpec, parseModelSpec } from "../../lib/model-spec";
import { notifyIfUI } from "../../lib/tui";

export const FALLBACK_MODEL_FLAG = "fallback-model";
const RETRYABLE_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|model.?unavailable|model.?not.?available|model.?not.?found/i;
const NON_FALLBACK_ERROR_PATTERN =
  /\b(401|403|unauthorized|forbidden|invalid api key|authentication|authorization)\b/i;

export function parseFallbackModelList(raw: unknown): ModelSpec[] {
  if (typeof raw !== "string") return [];

  return raw
    .split(",")
    .map(parseModelSpec)
    .filter((entry): entry is ModelSpec => entry !== undefined);
}

export function shouldFallbackForError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== "string" || errorMessage.trim() === "") return false;
  if (NON_FALLBACK_ERROR_PATTERN.test(errorMessage)) return false;
  return RETRYABLE_ERROR_PATTERN.test(errorMessage);
}

function sameModel(
  model: { provider?: string; id?: string } | undefined,
  spec: Pick<ModelSpec, "provider" | "model">,
): boolean {
  return model?.provider === spec.provider && model.id === spec.model;
}

function retryableErrorMessage(_errorMessage: unknown): string {
  return "provider returned error: fallback model selected for retry";
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

      notifyIfUI(
        ctx,
        `Fallback model に切り替えます: ${formatModelSpecWithThinking(fallback)}`,
        "warning",
      );

      return {
        message: {
          ...message,
          errorMessage: retryableErrorMessage(message.errorMessage),
        },
      };
    }
  });
}
