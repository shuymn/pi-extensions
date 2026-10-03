import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  configureFallbackRouter,
  createFallbackVirtualModel,
  FALLBACK_ROUTER_ID,
  FALLBACK_ROUTER_PROVIDER,
} from "../../lib/fallback-router";
import { type ModelSpec, parseModelSpecList, THINKING_LEVEL_VALUES } from "../../lib/model-spec";

export const FALLBACK_MODEL_FLAG = "fallback-model";

export function parseFallbackModelList(raw: unknown): ModelSpec[] {
  return parseModelSpecList(raw);
}

export default function fallbackModelExtension(pi: ExtensionAPI): void {
  pi.registerFlag(FALLBACK_MODEL_FLAG, {
    description:
      'Ordered physical candidates including the primary model for fallback/auto, e.g. "provider/primary,provider/backup:high". Select fallback/auto explicitly.',
    type: "string",
  });

  pi.registerVirtualModel({
    provider: FALLBACK_ROUTER_PROVIDER,
    id: FALLBACK_ROUTER_ID,
    name: "Fallback (Auto)",
    thinkingLevels: THINKING_LEVEL_VALUES,
    route(request, ctx) {
      return createFallbackVirtualModel(
        ctx.modelRegistry,
        parseFallbackModelList(pi.getFlag(FALLBACK_MODEL_FLAG)),
      ).route(request);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    configureFallbackRouter(
      ctx.modelRegistry,
      parseFallbackModelList(pi.getFlag(FALLBACK_MODEL_FLAG)),
    );
  });
}
