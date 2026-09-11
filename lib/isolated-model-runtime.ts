import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Preserve the parent's effective providers and live auth without exposing its runtime. */
export async function createIsolatedModelRuntime(registry: ModelRegistry): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const providerIds = new Set(registry.getAll().map((model) => model.provider));
  for (const id of providerIds) {
    const provider = registry.getProvider(id);
    if (!provider) continue;
    runtime.registerNativeProvider({
      ...provider,
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
  return runtime;
}
