import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  ModelRouteRequest,
  VirtualModelDefinition,
} from "@earendil-works/pi-coding-agent";

import { formatModelSpec, type ModelSpec, THINKING_LEVEL_VALUES } from "./model-spec";

export const FALLBACK_ROUTER_PROVIDER = "fallback";
export const FALLBACK_ROUTER_ID = "auto";

// Metadata only: never retain a parent router closure or its branch state.
const configurations = new WeakMap<ModelRegistry, readonly ModelSpec[]>();

function snapshot(candidates: readonly ModelSpec[]): readonly ModelSpec[] {
  return Object.freeze(candidates.map((candidate) => Object.freeze({ ...candidate })));
}

export function configureFallbackRouter(
  registry: ModelRegistry,
  candidates: readonly ModelSpec[],
): void {
  configurations.set(registry, snapshot(candidates));
}

export function getFallbackRouterCandidates(
  registry: ModelRegistry,
): readonly ModelSpec[] | undefined {
  return configurations.get(registry);
}

interface FallbackState {
  attempted: string[];
  current: string;
}

function key(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function readState(state: unknown): FallbackState | undefined {
  if (!state || typeof state !== "object") return undefined;
  const value = state as Partial<FallbackState>;
  if (
    typeof value.current !== "string" ||
    !Array.isArray(value.attempted) ||
    !value.attempted.every((entry) => typeof entry === "string")
  )
    return undefined;
  return value as FallbackState;
}

/** A fresh router using only public registry lookups and native branch-owned state. */
export function createFallbackVirtualModel(
  registry: ModelRegistry,
  candidates: readonly ModelSpec[],
): VirtualModelDefinition {
  const config = snapshot(candidates);

  function resolve(spec: ModelSpec): Model<Api> | undefined {
    const model = registry.find(spec.provider, spec.model);
    if (model?.api === "pi-virtual") {
      throw new Error(`Fallback candidate ${formatModelSpec(spec)} must be a physical model`);
    }
    return model;
  }

  function first(request: ModelRouteRequest, attempted: readonly string[] = []) {
    for (const spec of config) {
      const id = formatModelSpec(spec);
      if (attempted.includes(id)) continue;
      const model = resolve(spec);
      if (!model) continue;
      return {
        model,
        thinkingLevel: spec.thinkingLevel ?? request.thinkingLevel,
        ...(request.reason === "direct"
          ? {}
          : {
              state: { attempted: [...attempted, id], current: id },
            }),
      };
    }
    // Exhausting candidates does not replace the provider failure with a router error.
    // Let Pi spend any remaining native retry budget on the last physical model.
    if (request.reason === "retry" && request.failed) {
      return {
        model: request.failed.model,
        thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
        state: request.state,
      };
    }
    throw new Error(
      config.length === 0
        ? "Fallback router requires --fallback-model candidates (including the primary model)"
        : "No unattempted physical fallback candidate is present in the catalog",
    );
  }

  return {
    provider: FALLBACK_ROUTER_PROVIDER,
    id: FALLBACK_ROUTER_ID,
    name: "Fallback (Auto)",
    thinkingLevels: THINKING_LEVEL_VALUES,
    route(request) {
      // Direct calls neither read nor update the agent loop's routing state.
      if (request.reason === "direct" || request.reason === "user") return first(request);
      const state = readState(request.state);
      if (request.reason === "retry") {
        const attempted = [...(state?.attempted ?? [])];
        if (request.failed) {
          const failedKey = key(request.failed.model);
          if (!attempted.includes(failedKey)) attempted.push(failedKey);
        }
        // Native retry eligibility and budget are authoritative; do not classify errors here.
        return first(request, attempted);
      }

      // A successful continuation stays on its physical model and physical effort.
      // Without a successful response, keep the branch's choice.
      const sticky = request.previous;
      const current = sticky ? key(sticky.model) : state?.current;
      const spec = config.find((candidate) => formatModelSpec(candidate) === current);
      if (spec) {
        const model = resolve(spec);
        if (!model)
          throw new Error(
            `Fallback candidate ${formatModelSpec(spec)} is no longer in the catalog`,
          );
        return {
          model,
          thinkingLevel: sticky?.thinkingLevel ?? spec.thinkingLevel ?? request.thinkingLevel,
          state: request.state,
        };
      }
      return first(request, state?.attempted);
    },
  };
}
