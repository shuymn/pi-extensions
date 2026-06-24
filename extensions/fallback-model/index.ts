import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { shouldFallbackForError } from "../../lib/model-fallback";
import {
  formatModelSpecWithThinking,
  type ModelSpec,
  parseModelSpecList,
} from "../../lib/model-spec";
import { notifyIfUI } from "../../lib/tui";

export { shouldFallbackForError } from "../../lib/model-fallback";

export const FALLBACK_MODEL_FLAG = "fallback-model";

export function parseFallbackModelList(raw: unknown): ModelSpec[] {
  return parseModelSpecList(raw);
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
