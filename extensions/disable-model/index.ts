import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { projectSettingsPath, readExtensionSettings } from "../../lib/settings";
import { notifyIfUI } from "../../lib/tui";

export const DISABLE_MODEL_SETTINGS_KEY = "disable-model";

type ModelLike = Pick<Model<Api>, "provider" | "id">;
type ModelRegistryLike = {
  getAll?: () => Model<Api>[];
  getAvailable?: () => Model<Api>[];
  find?: (provider: string, modelId: string) => Model<Api> | undefined;
};
type DisableModelContext = ExtensionContext;
type DisableModelSettings = {
  exclude?: unknown;
};
type ExclusionRule =
  | { type: "provider"; provider: string }
  | { type: "model"; provider: string; model: string };

type OriginalRegistryMethods = {
  getAll?: ModelRegistryLike["getAll"];
  getAvailable?: ModelRegistryLike["getAvailable"];
  find?: ModelRegistryLike["find"];
};

const originalRegistryMethods = new WeakMap<ModelRegistryLike, OriginalRegistryMethods>();

function normalizePattern(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function splitPatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(splitPatterns);
  }

  const pattern = normalizePattern(value);
  return pattern
    ? pattern
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export function parseExclusionRules(value: unknown): ExclusionRule[] {
  const seen = new Set<string>();
  const rules: ExclusionRule[] = [];

  for (const pattern of splitPatterns(value)) {
    const slashIndex = pattern.indexOf("/");
    const rule =
      slashIndex === -1 ? parseProviderRule(pattern) : parseModelRule(pattern, slashIndex);
    if (!rule) continue;

    const key = rule.type === "provider" ? `${rule.provider}/` : `${rule.provider}/${rule.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
  }

  return rules;
}

function hasUnsupportedGlobSyntax(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

function parseProviderRule(pattern: string): ExclusionRule | undefined {
  return hasUnsupportedGlobSyntax(pattern) || pattern.includes(":")
    ? undefined
    : { type: "provider", provider: pattern };
}

function parseModelRule(pattern: string, slashIndex: number): ExclusionRule | undefined {
  const provider = pattern.slice(0, slashIndex).trim();
  const model = pattern.slice(slashIndex + 1).trim();
  if (!provider || !model) return undefined;
  if (hasUnsupportedGlobSyntax(provider) || hasUnsupportedGlobSyntax(model)) return undefined;
  return { type: "model", provider, model };
}

type HiddenModelMatcher = {
  providers: ReadonlySet<string>;
  models: ReadonlySet<string>;
};

function modelKey(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

function createHiddenModelMatcher(rules: readonly ExclusionRule[]): HiddenModelMatcher {
  const providers = new Set<string>();
  const models = new Set<string>();

  for (const rule of rules) {
    if (rule.type === "provider") {
      providers.add(rule.provider);
    } else {
      models.add(`${rule.provider}/${rule.model}`);
    }
  }

  return { providers, models };
}

function matchesHiddenModel(model: ModelLike, matcher: HiddenModelMatcher): boolean {
  return matcher.providers.has(model.provider) || matcher.models.has(modelKey(model));
}

export function isModelHidden(model: ModelLike, rules: readonly ExclusionRule[]): boolean {
  return matchesHiddenModel(model, createHiddenModelMatcher(rules));
}

function readConfiguredRules(cwd: string): ExclusionRule[] {
  const settings = readExtensionSettings<DisableModelSettings>(DISABLE_MODEL_SETTINGS_KEY, {
    projectPath: projectSettingsPath(cwd),
  });

  return parseExclusionRules(settings.exclude);
}

function restoreModelRegistry(modelRegistry: ModelRegistryLike): void {
  const original = originalRegistryMethods.get(modelRegistry);
  if (!original) return;

  if (original.getAll) modelRegistry.getAll = original.getAll;
  if (original.getAvailable) modelRegistry.getAvailable = original.getAvailable;
  if (original.find) modelRegistry.find = original.find;
  originalRegistryMethods.delete(modelRegistry);
}

function patchModelRegistry(
  modelRegistry: ModelRegistryLike,
  rules: readonly ExclusionRule[],
): void {
  if (!originalRegistryMethods.has(modelRegistry)) {
    originalRegistryMethods.set(modelRegistry, {
      getAll: modelRegistry.getAll?.bind(modelRegistry),
      getAvailable: modelRegistry.getAvailable?.bind(modelRegistry),
      find: modelRegistry.find?.bind(modelRegistry),
    });
  }

  const original = originalRegistryMethods.get(modelRegistry);
  if (!original) return;

  const matcher = createHiddenModelMatcher(rules);
  const filterVisibleModels = (models: Model<Api>[]) =>
    models.filter((model) => !matchesHiddenModel(model, matcher));

  const originalGetAll = original.getAll;
  if (originalGetAll) {
    modelRegistry.getAll = () => filterVisibleModels(originalGetAll());
  }

  const originalGetAvailable = original.getAvailable;
  if (originalGetAvailable) {
    modelRegistry.getAvailable = () => filterVisibleModels(originalGetAvailable());
  }

  const originalFind = original.find;
  if (originalFind) {
    modelRegistry.find = (provider, modelId) => {
      const model = originalFind(provider, modelId);
      return model && matchesHiddenModel(model, matcher) ? undefined : model;
    };
  }
}

async function switchAwayFromHiddenModel(
  pi: ExtensionAPI,
  ctx: DisableModelContext,
  rules: readonly ExclusionRule[],
): Promise<void> {
  if (!ctx.model || !isModelHidden(ctx.model, rules)) return;

  const replacement = ctx.modelRegistry.getAvailable()[0];
  if (!replacement) {
    notifyIfUI(ctx, "disable-model の対象モデルが選択中ですが、切り替え先がありません", "error");
    ctx.shutdown();
    return;
  }

  const changed = await pi.setModel(replacement);
  if (!changed) {
    notifyIfUI(
      ctx,
      `disable-model の切り替えに失敗しました: ${replacement.provider}/${replacement.id}`,
      "error",
    );
    ctx.shutdown();
    return;
  }

  notifyIfUI(
    ctx,
    `disable-model によりモデルを切り替えました: ${replacement.provider}/${replacement.id}`,
    "warning",
  );
}

export default function disableModelExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const modelRegistry = ctx.modelRegistry as unknown as ModelRegistryLike;
    const rules = readConfiguredRules(ctx.cwd);
    if (rules.length === 0) {
      restoreModelRegistry(modelRegistry);
      return;
    }

    patchModelRegistry(modelRegistry, rules);
    await switchAwayFromHiddenModel(pi, ctx, rules);

    notifyIfUI(ctx, `disable-model 設定を適用しました: ${rules.length} 件`, "info");
  });
}
