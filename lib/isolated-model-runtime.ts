import {
  type AnyModel,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createFallbackVirtualModel,
  FALLBACK_ROUTER_ID,
  FALLBACK_ROUTER_PROVIDER,
  getFallbackRouterCandidates,
} from "./fallback-router";

/** Preserve the parent's effective providers and live auth without exposing its runtime. */
export async function createIsolatedModelRuntime(registry: ModelRegistry): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const providerIds = new Set(registry.getAll().map((model) => model.provider));
  for (const id of providerIds) {
    const provider = registry.getProvider(id);
    if (!provider) continue;
    runtime.registerNativeProvider({
      ...provider,
      // Virtual catalog entries are not physical provider models. Pi 1.0.0's
      // public ModelRegistry cannot export their router definitions.
      getModels: () => provider.getModels().filter((model) => model.api !== "pi-virtual"),
      getAllModels: () =>
        (provider.getAllModels?.() ?? provider.getModels()).filter(
          (model) => model.api !== "pi-virtual",
        ),
      // Resolve against the parent on every request, including refreshed OAuth
      // credentials, runtime API keys, headers, endpoint overrides and ambient env.
      auth: {
        apiKey: {
          name: provider.name,
          resolve: () => registry.getProviderAuth(id),
        },
      },
    });
  }
  // ModelRegistry exposes request-time model configuration, but not its backing
  // models.json. Bridge the public auth boundary as well as provider availability:
  // copying provider auth alone loses modelOverrides/model-specific headers.
  // Keep virtual routing and all conversation state in this child runtime.
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (
    selected: string | AnyModel,
    overrides: Parameters<ModelRuntime["getAuth"]>[1] = {},
  ) => {
    if (typeof selected === "string") return getAuth(selected, overrides);
    if (
      selected.api === "pi-virtual" ||
      selected.type === "image" ||
      selected.type === "classifier"
    )
      return getAuth(selected, overrides);
    overrides.signal?.throwIfAborted();
    const resolved = await registry.getApiKeyAndHeaders(selected);
    overrides.signal?.throwIfAborted();
    if (!resolved.ok) throw new Error(resolved.error);
    return {
      auth: {
        apiKey: overrides.apiKey ?? resolved.apiKey,
        headers: resolved.headers,
        baseUrl: resolved.baseUrl,
      },
      env: resolved.env || overrides.env ? { ...resolved.env, ...overrides.env } : undefined,
    };
  };
  const candidates = getFallbackRouterCandidates(registry);
  if (candidates) {
    const childRegistry = new ModelRegistry(runtime);
    runtime.registerVirtualModel(createFallbackVirtualModel(childRegistry, candidates));
  }
  // Keep foreign virtual selections visible, but fail explicitly at dispatch rather than
  // silently choosing a physical model (or borrowing the parent's session-bound
  // router). Registering a catalog entry alone produces Pi's misleading "not
  // registered" error. A direct stream proxy would lose reason/state/retry data.
  const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  for (const model of registry.getAll()) {
    if (model.api !== "pi-virtual") continue;
    if (
      candidates &&
      model.provider === FALLBACK_ROUTER_PROVIDER &&
      model.id === FALLBACK_ROUTER_ID
    )
      continue;
    runtime.registerVirtualModel({
      ...model,
      thinkingLevels: levels.filter((level) => model.thinkingLevelMap?.[level] != null),
      route() {
        throw new Error(
          `Virtual model ${model.provider}/${model.id} is unsupported in isolated sessions: ` +
            "Pi 1.0.0 does not expose router definitions through ModelRegistry. " +
            "Select a physical model explicitly for this run.",
        );
      },
    });
  }
  // Virtual dispatch checks the runtime's availability snapshot, not getAuth().
  // Provider registration refreshes it asynchronously; settle it before a child can route.
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
