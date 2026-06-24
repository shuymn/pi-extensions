import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { resolveWorkflowRoot } from "../run/root";
import { workflowCatalogForCwd, workflowCatalogForRoot } from "../saved/catalog";
import type { SavedWorkflow, SavedWorkflowRootInput } from "../saved/resolver";

export type WorkflowCommandLaunchInput = {
  workflow: SavedWorkflow;
  args?: unknown;
};

export type WorkflowCommandLaunchResult = {
  runId?: string;
  artifactDir?: string;
  outputPath?: string;
};

export type WorkflowCommandLauncher = (
  input: WorkflowCommandLaunchInput,
  ctx: ExtensionCommandContext,
) => Promise<WorkflowCommandLaunchResult | undefined>;

export type WorkflowAdditionalRootsProvider =
  | readonly SavedWorkflowRootInput[]
  | ((ctx: ExtensionCommandContext | undefined) => readonly SavedWorkflowRootInput[]);

export type WorkflowCommandOptions = {
  launchWorkflow: WorkflowCommandLauncher;
  additionalWorkflowRoots?: WorkflowAdditionalRootsProvider;
};

export type DirectWorkflowCommandRegistration = {
  name: string;
  commandName: string;
  path: string;
  fallbackCommand: string;
};

export type DirectWorkflowCommandSkipReason =
  | "command_collision"
  | "duplicate_saved_name"
  | "unsafe_name";

export type DirectWorkflowCommandSkip = {
  name: string;
  reason: DirectWorkflowCommandSkipReason;
  fallbackCommand: string;
  message: string;
  path?: string;
};

export type DirectWorkflowCommandRegistrationReport = {
  registered: DirectWorkflowCommandRegistration[];
  skipped: DirectWorkflowCommandSkip[];
};

export type DirectWorkflowCommandOptions = WorkflowCommandOptions & {
  notifyCollisionSkips?: boolean;
};

type ParsedWorkflowCommandArgs = {
  name: string;
  args?: unknown;
};

const WORKFLOW_COMMAND_USAGE = "使い方: /workflow <name> [JSON args]";
const DIRECT_WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const BUILTIN_SLASH_COMMAND_NAMES = new Set([
  "changelog",
  "clone",
  "compact",
  "copy",
  "export",
  "fork",
  "hotkeys",
  "import",
  "login",
  "logout",
  "model",
  "name",
  "new",
  "quit",
  "reload",
  "resume",
  "scoped-models",
  "session",
  "settings",
  "share",
  "tree",
  "trust",
]);

export function registerWorkflowCommand(
  pi: Pick<ExtensionAPI, "on" | "registerCommand">,
  options: WorkflowCommandOptions,
): void {
  let sessionCwd: string | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionCwd = ctx.cwd;
  });

  pi.registerCommand("workflow", {
    description:
      "Launch a saved dynamic workflow by name; fallback for workflows without direct slash commands",
    getArgumentCompletions: async (argumentPrefix) => {
      if (sessionCwd === undefined) return null;
      return getSavedWorkflowNameCompletions(
        workflowRootsForCwd(sessionCwd, options.additionalWorkflowRoots, undefined),
        argumentPrefix,
      );
    },
    handler: async (commandArgs, ctx) => {
      sessionCwd = ctx.cwd;
      if (!ctx.isIdle()) {
        ctx.ui.notify("エージェントが処理中です。完了後に再実行してください。", "warning");
        return;
      }

      try {
        const parsed = parseWorkflowCommandArgs(commandArgs);
        if (parsed === undefined) {
          ctx.ui.notify(WORKFLOW_COMMAND_USAGE, "error");
          return;
        }

        const workflow = await workflowCatalogForCommandContext(ctx, options).resolve(parsed.name);
        const result = await options.launchWorkflow({ workflow, args: parsed.args }, ctx);
        ctx.ui.notify(formatWorkflowLaunchNotice("/workflow", workflow, result), "info");
      } catch (error) {
        ctx.ui.notify(formatWorkflowLaunchError("/workflow", error), "error");
      }
    },
  });
}

export function registerDirectSavedWorkflowCommands(
  pi: Pick<ExtensionAPI, "getCommands" | "on" | "registerCommand">,
  options: DirectWorkflowCommandOptions,
): void {
  const registeredDirectNames = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    try {
      const report = await registerDirectSavedWorkflowCommandsForRoot(
        pi,
        resolveWorkflowRoot(ctx.cwd),
        options,
        registeredDirectNames,
      );
      const collisionSkips = report.skipped.filter((skip) => skip.reason === "command_collision");
      if ((options.notifyCollisionSkips ?? true) && collisionSkips.length > 0) {
        ctx.ui.notify(formatDirectWorkflowCollisionNotice(collisionSkips), "warning");
      }
    } catch (error) {
      ctx.ui.notify(formatDirectWorkflowRegistrationError(error), "warning");
    }
  });
}

export async function registerDirectSavedWorkflowCommandsForRoot(
  pi: Pick<ExtensionAPI, "getCommands" | "registerCommand">,
  workflowRoot: string,
  options: WorkflowCommandOptions,
  registeredDirectNames = new Set<string>(),
): Promise<DirectWorkflowCommandRegistrationReport> {
  const catalog = workflowCatalogForRoot(workflowRoot);
  const workflows = await catalog.listProjectSaved();
  const takenCommandNames = new Set([
    ...BUILTIN_SLASH_COMMAND_NAMES,
    ...pi.getCommands().map((command) => command.name),
    ...registeredDirectNames,
  ]);
  const report: DirectWorkflowCommandRegistrationReport = { registered: [], skipped: [] };

  for (const candidate of catalog.directCommandCandidates(workflows, {
    isNameSafe: isDirectWorkflowCommandNameSafe,
    takenCommandNames,
    registeredCommandNames: registeredDirectNames,
  })) {
    const { workflow, commandName, fallbackCommand } = candidate;

    if (!candidate.canRegister) {
      if (candidate.reason === "already_registered") continue;
      const reason = candidate.reason;
      if (reason === undefined) continue;
      report.skipped.push({
        name: workflow.name,
        path: workflow.path,
        reason,
        fallbackCommand,
        message: directWorkflowSkipMessage(reason, workflow.name, commandName),
      });
      continue;
    }

    pi.registerCommand(commandName, {
      description: `Launch saved dynamic workflow "${workflow.name}". Fallback: ${fallbackCommand}`,
      handler: async (commandArgs, ctx) => {
        await handleDirectWorkflowCommand(commandName, workflow.name, commandArgs, ctx, options);
      },
    });
    registeredDirectNames.add(commandName);
    takenCommandNames.add(commandName);
    report.registered.push({
      name: workflow.name,
      commandName,
      path: workflow.path,
      fallbackCommand,
    });
  }

  return report;
}

export function createWorkflowToolCommandLauncher(
  tool: Pick<ToolDefinition, "execute">,
): WorkflowCommandLauncher {
  return async ({ workflow, args }, ctx) => {
    const result = await tool.execute(
      "workflow-command",
      {
        script: workflow.script,
        ...(args === undefined ? {} : { args }),
      } as never,
      ctx.signal,
      undefined,
      ctx,
    );
    return workflowCommandLaunchResultFromDetails(result.details);
  };
}

export function parseWorkflowCommandArgs(input: string): ParsedWorkflowCommandArgs | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const parsedName = parseWorkflowCommandName(trimmed);
  return {
    name: parsedName.name,
    ...parseWorkflowCommandJsonArgsProperty(parsedName.argsText),
  };
}

function parseWorkflowCommandName(input: string): { name: string; argsText: string } {
  if (input.startsWith('"')) {
    const end = readJsonStringEnd(input);
    const rawName = input.slice(0, end);
    const name = JSON.parse(rawName);
    if (typeof name !== "string" || !name) throw new Error("workflow name must be a string.");
    return { name, argsText: input.slice(end).trim() };
  }

  const nameEnd = input.search(/\s/);
  return {
    name: nameEnd === -1 ? input : input.slice(0, nameEnd),
    argsText: nameEnd === -1 ? "" : input.slice(nameEnd).trim(),
  };
}

function readJsonStringEnd(input: string): number {
  for (let index = 1; index < input.length; index += 1) {
    const char = input[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') return index + 1;
  }
  throw new Error("workflow name string is unterminated.");
}

export function parseWorkflowCommandJsonArgs(input: string): unknown | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`args は JSON として指定してください: ${errorMessage(error)}`);
  }
}

export function isDirectWorkflowCommandNameSafe(name: string): boolean {
  return DIRECT_WORKFLOW_NAME_PATTERN.test(name);
}

export async function getSavedWorkflowNameCompletions(
  workflowRoot: string | readonly string[],
  argumentPrefix: string,
): Promise<AutocompleteItem[] | null> {
  const prefix = argumentPrefix.trimStart();
  if (/\s/.test(prefix)) return null;

  const catalog = workflowCatalogForRoot(
    "",
    Array.isArray(workflowRoot) ? workflowRoot : [workflowRoot],
  );
  const workflows = await catalog.list();
  const completions = catalog.completionCandidates(prefix, workflows);

  return completions.length === 0 ? null : completions;
}

async function handleDirectWorkflowCommand(
  commandName: string,
  workflowName: string,
  commandArgs: string,
  ctx: ExtensionCommandContext,
  options: WorkflowCommandOptions,
): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify("エージェントが処理中です。完了後に再実行してください。", "warning");
    return;
  }

  try {
    const args = parseWorkflowCommandJsonArgs(commandArgs);
    const workflow = await workflowCatalogForCommandContext(ctx, options).resolve(workflowName);
    const result = await options.launchWorkflow({ workflow, args }, ctx);
    ctx.ui.notify(formatWorkflowLaunchNotice(`/${commandName}`, workflow, result), "info");
  } catch (error) {
    ctx.ui.notify(formatWorkflowLaunchError(`/${commandName}`, error), "error");
  }
}

function parseWorkflowCommandJsonArgsProperty(input: string): { args?: unknown } {
  const args = parseWorkflowCommandJsonArgs(input);
  return args === undefined ? {} : { args };
}

function workflowCatalogForCommandContext(
  ctx: ExtensionCommandContext,
  options: Pick<WorkflowCommandOptions, "additionalWorkflowRoots">,
) {
  return workflowCatalogForCwd(
    ctx.cwd,
    workflowAdditionalRoots(options.additionalWorkflowRoots, ctx),
  );
}

function workflowRootsForCwd(
  cwd: string,
  additionalWorkflowRoots: WorkflowAdditionalRootsProvider | undefined,
  ctx: ExtensionCommandContext | undefined,
): string[] {
  // Autocomplete only needs names/descriptions, so it can pass bare paths back
  // through the catalog instead of preserving provenance descriptors here.
  return workflowCatalogForCwd(cwd, workflowAdditionalRoots(additionalWorkflowRoots, ctx)).roots
    .roots;
}

function workflowAdditionalRoots(
  provider: WorkflowAdditionalRootsProvider | undefined,
  ctx: ExtensionCommandContext | undefined,
): SavedWorkflowRootInput[] {
  const roots = typeof provider === "function" ? provider(ctx) : provider;
  return [...(roots ?? [])];
}

function workflowCommandLaunchResultFromDetails(
  details: unknown,
): WorkflowCommandLaunchResult | undefined {
  if (!isRecord(details)) return undefined;
  return {
    ...(typeof details.runId === "string" ? { runId: details.runId } : {}),
    ...(typeof details.artifactDir === "string" ? { artifactDir: details.artifactDir } : {}),
    ...(typeof details.outputPath === "string" ? { outputPath: details.outputPath } : {}),
  };
}

function directWorkflowSkipMessage(
  reason: DirectWorkflowCommandSkipReason,
  workflowName: string,
  commandName: string,
): string {
  switch (reason) {
    case "unsafe_name":
      return `workflow name is not safe as a slash command: ${workflowName}`;
    case "duplicate_saved_name":
      return `multiple saved workflows use the same name: ${workflowName}`;
    case "command_collision":
      return `slash command already exists: /${commandName}`;
  }
}
function formatWorkflowLaunchNotice(
  commandLabel: string,
  workflow: SavedWorkflow,
  result: WorkflowCommandLaunchResult | undefined,
): string {
  return [
    `${commandLabel}: ワークフロー「${workflow.name}」を起動しました。`,
    ...(result?.runId === undefined ? [] : [`runId: ${result.runId}`]),
    ...(result?.artifactDir === undefined ? [] : [`artifacts: ${result.artifactDir}`]),
    ...(result?.outputPath === undefined ? [] : [`output: ${result.outputPath}`]),
  ].join("\n");
}

function formatWorkflowLaunchError(commandLabel: string, error: unknown): string {
  return `${commandLabel}: ワークフローを起動できません: ${errorMessage(error)}`;
}

function formatDirectWorkflowCollisionNotice(skips: DirectWorkflowCommandSkip[]): string {
  const visibleSkips = skips.slice(0, 5);
  return [
    "保存済みワークフローの直接コマンド登録を一部スキップしました。必要なら /workflow <name> [JSON args] を使ってください。",
    ...visibleSkips.map((skip) => `- ${skip.name}: ${skip.fallbackCommand} [JSON args]`),
    ...(skips.length > visibleSkips.length ? [`…他 ${skips.length - visibleSkips.length} 件`] : []),
  ].join("\n");
}

function formatDirectWorkflowRegistrationError(error: unknown): string {
  return `保存済みワークフローの直接コマンドを更新できません: ${errorMessage(error)}\n必要なら /workflow <name> [JSON args] を使ってください。`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
