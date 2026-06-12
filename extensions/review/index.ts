import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecGh, ExecGit } from "../../lib/command";
import { parseCommandArgs } from "../../lib/command-args";
import { formatJsonTarget, normalizeBaseBranch } from "../../lib/git";
import { normalizePullRequestSelector } from "../../lib/github";
import {
  createProtectedBashOperations,
  type ExecFn,
  resetSandboxState,
} from "../../lib/protected-bash";
import {
  getLatestAssistantMessageText,
  latestAssistantWasAborted,
} from "../../lib/session-messages";
import { truncate } from "../../lib/text";
import { notifyIfUI } from "../../lib/tui";
import {
  REVIEW_WORKFLOW_EVENT_NAME,
  type ReviewWorkflowLifecycleEvent,
  type ReviewWorkflowLifecycleStatus,
  reviewWorkflowEventName,
} from "./events";
import { loadWorkflowPhases } from "./phases";
import { buildPhasePrompt } from "./prompts";
import type { NoFixReason, PreparedTargetScope } from "./target-scope";
import { prepareTargetScope } from "./target-scope";
import { clearReviewWidget, refreshReviewWidget } from "./widget";
import {
  type ActiveReviewRun,
  type QueuedPhase,
  type ReviewRunSeed,
  ReviewWorkflowController,
} from "./workflow";

const COMMAND_NAME = "review";
const TOOL_NAME = "review";
const MAX_PHASE_NOTE_CHARS = 20_000;
export const INVESTIGATION_ALLOWED_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "github_clone_workspace",
  "ask_user_question",
  "spawn_subagent",
  "get_subagent_result",
  "stop_subagent",
  "list_subagents",
  "tavily_search",
  "tavily_extract",
  "tavily_map",
  "tavily_crawl",
  "tavily_auth_status",
] as const;
const INVESTIGATION_ALLOWED_TOOLS: ReadonlySet<string> = new Set(INVESTIGATION_ALLOWED_TOOL_NAMES);

export {
  REVIEW_WORKFLOW_EVENT_NAME,
  type ReviewWorkflowLifecycleEvent,
  type ReviewWorkflowLifecycleStatus,
  WORKFLOW_CANCELLED_EVENT,
  WORKFLOW_COMPLETED_EVENT,
  WORKFLOW_FAILED_EVENT,
  WORKFLOW_STARTED_EVENT,
} from "./events";

const workflow = new ReviewWorkflowController();
let runStarting = false;
let startupGeneration = 0;

type ReviewOptions = {
  files: string[];
  staged: boolean;
  noFix: boolean;
  base?: string;
  pr?: string;
  instructions: string;
};

function parseArgs(args: string): ReviewOptions {
  const parsed = parseCommandArgs({
    args,
    booleanFlags: ["--staged", "--cached", "--no-fix"] as const,
    valueFlags: ["--base", "--pr"] as const,
  });
  if (parsed.valueErrors["--base"]) throw new Error(parsed.valueErrors["--base"]);
  if (parsed.valueErrors["--pr"]) throw new Error(parsed.valueErrors["--pr"]);
  const base = normalizeBaseBranch(parsed.values["--base"]);
  const pr = normalizePullRequestSelector(parsed.values["--pr"]);

  return {
    files: parsed.files,
    staged: parsed.flags["--staged"] || parsed.flags["--cached"],
    noFix: parsed.flags["--no-fix"],
    base,
    pr,
    instructions: parsed.instructions,
  };
}

function makeExecGit(pi: ExtensionAPI, cwd: string): ExecGit {
  return (args) => pi.exec("git", args, { cwd, timeout: 10_000 });
}

function makeExecGh(pi: ExtensionAPI, cwd: string): ExecGh {
  return (args) => pi.exec("gh", args, { cwd, timeout: 10_000 });
}

async function collectScope(
  pi: ExtensionAPI,
  cwd: string,
  options: ReviewOptions,
): Promise<PreparedTargetScope> {
  return prepareTargetScope({
    execGit: makeExecGit(pi, cwd),
    execGh: makeExecGh(pi, cwd),
    cwd,
    files: options.files,
    staged: options.staged,
    base: options.base,
    pr: options.pr,
  });
}

async function createReviewRun(
  pi: ExtensionAPI,
  cwd: string,
  options: ReviewOptions,
): Promise<ReviewRunSeed | undefined> {
  const { scope, targets, diff, noFixReason } = await collectScope(pi, cwd, options);
  if (targets.length === 0) return undefined;

  const effectiveNoFix = options.noFix || Boolean(noFixReason);
  const phases = await loadWorkflowPhases(effectiveNoFix);

  return {
    id: `${Date.now()}`,
    cwd,
    targets,
    diff,
    phases,
    noFix: effectiveNoFix,
    scope,
    ...(noFixReason ? { noFixReason } : {}),
    instructions: options.instructions,
  };
}

type ReviewRunCreationResult =
  | { kind: "ready"; run: ReviewRunSeed }
  | { kind: "empty" }
  | { kind: "cancelled" };

async function createReviewRunWithStartGuard(
  pi: ExtensionAPI,
  cwd: string,
  options: ReviewOptions,
): Promise<ReviewRunCreationResult> {
  runStarting = true;
  startupGeneration += 1;
  const generation = startupGeneration;
  try {
    const run = await createReviewRun(pi, cwd, options);
    if (startupGeneration !== generation) return { kind: "cancelled" };
    if (!run) {
      runStarting = false;
      return { kind: "empty" };
    }
    return { kind: "ready", run };
  } catch (error) {
    if (startupGeneration === generation) runStarting = false;
    throw error;
  }
}

function activeRun(): ActiveReviewRun | undefined {
  return workflow.getActiveRun();
}

function clearActiveRun(ctx?: Pick<ExtensionContext, "ui">): void {
  workflow.cancel();
  startupGeneration += 1;
  runStarting = false;
  if (ctx) clearReviewWidget(ctx);
}

function setPhaseWidget(
  ctx: Pick<ExtensionContext, "ui">,
  state: "queued" | "running",
  phaseNumber: number,
): void {
  const run = activeRun();
  if (!run) return;
  refreshReviewWidget(ctx, run, state, phaseNumber);
}

function reviewRunDetails(run: ReviewRunSeed) {
  return {
    phaseCount: run.phases.length,
    noFix: run.noFix,
    scope: run.scope,
    ...(run.noFixReason ? { noFixReason: run.noFixReason } : {}),
  };
}

function describeNoFixReasonJa(reason: NoFixReason): string {
  switch (reason.kind) {
    case "pr_head_mismatch":
      return "PR head と local HEAD が一致しない";
    case "pr_worktree_dirty":
      return "作業ツリーに未コミットの変更がある";
  }
}

function emitWorkflowLifecycleEvent(
  pi: ExtensionAPI,
  status: ReviewWorkflowLifecycleStatus,
  run: ReviewRunSeed,
  extra: Pick<ReviewWorkflowLifecycleEvent, "reason" | "error"> = {},
): void {
  const event: ReviewWorkflowLifecycleEvent = {
    name: REVIEW_WORKFLOW_EVENT_NAME,
    status,
    runId: run.id,
    cwd: run.cwd,
    targets: run.targets,
    ...reviewRunDetails(run),
    ...extra,
  };

  try {
    pi.events.emit(reviewWorkflowEventName(status), event);
  } catch {
    // Lifecycle observers must not affect the review workflow itself.
  }
}

function cancelActiveReviewRun(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "ui">,
  run = activeRun(),
): void {
  const runId = run?.id;
  if (run) {
    emitWorkflowLifecycleEvent(pi, "cancelled", run, {
      reason: "user_cancelled",
    });
  }
  clearActiveRun(ctx);
  notifyIfUI(
    ctx,
    runId
      ? `/review: ワークフロー ${runId} をキャンセルしました。`
      : "/review: キャンセルできるワークフローがありません。",
    "info",
  );
}

function failActiveRun(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, "ui">,
  message: string,
  error: unknown,
): void {
  const run = activeRun();
  if (run) {
    emitWorkflowLifecycleEvent(pi, "failed", run, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  clearActiveRun(ctx);
  notifyIfUI(ctx, message, "error");
}

function sendQueuedPhase(
  pi: ExtensionAPI,
  queued: QueuedPhase,
  ctx?: Pick<ExtensionContext, "ui">,
): void {
  if (ctx) setPhaseWidget(ctx, "running", queued.phaseIndex + 1);

  pi.sendMessage(
    {
      customType: "review-command",
      content: buildPhasePrompt(queued.run, queued.phaseIndex),
      display: false,
      details: {
        runId: queued.run.id,
        phase: queued.phase.file,
        phaseIndex: queued.phaseIndex + 1,
        ...reviewRunDetails(queued.run),
      },
    },
    // Trigger a fresh turn when idle, but if the previous turn has not finished
    // streaming yet (agent_end can fire before isStreaming clears), queue this as
    // a follow-up instead of steering/erroring with "Agent is already processing".
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function startReviewRun(
  pi: ExtensionAPI,
  run: ReviewRunSeed,
  ctx: Pick<ExtensionContext, "ui">,
): ActiveReviewRun {
  runStarting = false;
  const queued = workflow.start(run);
  emitWorkflowLifecycleEvent(pi, "started", queued.run);
  try {
    sendQueuedPhase(pi, queued, ctx);
  } catch (error) {
    failActiveRun(pi, ctx, "/review: ワークフローの phase をキューに追加できませんでした。", error);
    throw error;
  }
  return queued.run;
}

function sendNextPhase(pi: ExtensionAPI, runId: string, ctx: Pick<ExtensionContext, "ui">): void {
  if (activeRun()?.id !== runId) return;
  const queued = workflow.startQueuedPhase();
  if (!queued) return;
  try {
    sendQueuedPhase(pi, queued, ctx);
  } catch (error) {
    failActiveRun(pi, ctx, "/review: 次の phase をキューに追加できませんでした。", error);
  }
}

export function createReviewExtension() {
  return function reviewExtension(pi: ExtensionAPI): void {
    pi.on("input", async (_event, ctx) => {
      if (!activeRun() && !runStarting) return { action: "continue" as const };

      notifyIfUI(
        ctx,
        "/review: ワークフロー実行中の追加入力は保留できません。中止する場合は /review cancel を実行してください。",
        "warning",
      );
      return { action: "handled" as const };
    });

    pi.on("tool_call", async (event) => {
      if (!workflow.isReadOnlyPhase()) return;

      if (!INVESTIGATION_ALLOWED_TOOLS.has(event.toolName)) {
        return {
          block: true,
          reason: activeRun()?.noFix
            ? "/review --no-fix mode is read-only. This tool is not allowed while producing a report."
            : "/review investigation phases are read-only. This tool is allowed only in Fix and Verify phases.",
        };
      }

      if (event.toolName === "spawn_subagent") {
        (event.input as { readOnly?: boolean }).readOnly = true;
      }
    });

    pi.on("agent_end", async (event, ctx) => {
      const completingRun = activeRun();
      if (!completingRun?.phaseInProgress) return;

      if (latestAssistantWasAborted(event.messages)) {
        cancelActiveReviewRun(pi, ctx, completingRun);
        return;
      }

      const latestAssistantText = getLatestAssistantMessageText(event.messages);
      const decision = workflow.completePhase({
        latestAssistantText,
        truncateNotes: (text) => truncate(text, MAX_PHASE_NOTE_CHARS),
      });
      if (!decision) return;

      if (decision.kind === "completed") {
        emitWorkflowLifecycleEvent(pi, "completed", completingRun);
        runStarting = false;
        clearReviewWidget(ctx);
        notifyIfUI(ctx, `/review: ワークフロー ${decision.runId} が完了しました。`, "info");
        return;
      }

      setPhaseWidget(ctx, "queued", decision.phaseIndex + 1);
      sendNextPhase(pi, decision.run.id, ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const run = activeRun();
      if (run)
        emitWorkflowLifecycleEvent(pi, "cancelled", run, {
          reason: "session_shutdown",
        });
      clearActiveRun(ctx);
      await resetSandboxState();
    });

    pi.registerCommand(COMMAND_NAME, {
      description:
        "Run a multi-stage code review workflow and apply verified fixes, or report only with --no-fix",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        await ctx.waitForIdle();

        const trimmedArgs = args.trim();
        if (trimmedArgs === "cancel" || trimmedArgs === "--cancel") {
          cancelActiveReviewRun(pi, ctx);
          return;
        }

        if (activeRun() || runStarting) {
          ctx.ui.notify("/review: 別のレビューワークフローが既に実行中です。", "warning");
          return;
        }

        const options = parseArgs(args);
        const creation = await createReviewRunWithStartGuard(pi, ctx.cwd, options);
        if (creation.kind === "cancelled") return;
        if (creation.kind === "empty") {
          ctx.ui.notify(
            "/review: 変更ファイルが見つかりませんでした。ファイル全体をレビューするにはパスを明示してください。",
            "info",
          );
          return;
        }

        let active: ActiveReviewRun;
        try {
          active = startReviewRun(pi, creation.run, ctx);
        } catch {
          return;
        }
        if (active.noFixReason) {
          ctx.ui.notify(
            `/review: ${describeNoFixReasonJa(active.noFixReason)}ため no-fix mode に切り替えました。`,
            "warning",
          );
        }
        ctx.ui.notify(
          `/review: ${active.targets.length} 件のファイルについて phase 1/${active.phases.length} をキューに追加しました。`,
          "info",
        );
      },
    });

    // Register the review tool.
    pi.registerTool({
      name: TOOL_NAME,
      label: "Review",
      description:
        "Queue a multi-stage code review workflow for changed, staged, pull request, or explicitly listed files, then apply verified fixes or produce a no-fix report.",
      promptSnippet:
        "Queue a /review pass that runs Recon, Hunt, Validate, Gapfill, Dedupe, Trace, Fix, and Verify stages before applying only validated fixes. Set noFix to produce a consolidated report without fixes.",
      promptGuidelines: [
        "Use review when the user asks for a code review workflow that should identify actionable issues, verify them, fix the valid ones, and run relevant checks.",
        "Use review with explicit files when the user names file paths; otherwise let review target current git changes. Use pr when the user asks to review a specific pull request, staged when the user specifically asks to review staged/cached changes, or base when the user asks to review a branch against a base branch. Precedence is files over pr over base over staged.",
        "Use noFix when the user asks to report findings without fixing or editing files.",
      ],
      parameters: Type.Object({
        files: Type.Optional(
          Type.Array(
            Type.String({
              description: "File path to review as a whole-file target.",
            }),
            {
              description: "Explicit file paths to review. Omit to use git changes.",
            },
          ),
        ),
        staged: Type.Optional(
          Type.Boolean({
            description: "When true and files is omitted, review only staged/cached git changes.",
          }),
        ),
        base: Type.Optional(
          Type.String({
            description:
              "Optional base branch. When files and pr are omitted, review the diff from base...HEAD instead of local working tree changes. If staged is also true, base takes precedence.",
          }),
        ),
        pr: Type.Optional(
          Type.String({
            description:
              "Optional pull request selector. When files is omitted, review the specified PR using gh pr view/diff. Accepts a number, owner/repo#number, or GitHub pull request URL.",
          }),
        ),
        noFix: Type.Optional(
          Type.Boolean({
            description:
              "When true, report validated review findings without applying fixes or editing files.",
          }),
        ),
        instructions: Type.Optional(
          Type.String({
            description: "Additional user instructions for this review pass.",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (activeRun() || runStarting) {
          return {
            content: [
              {
                type: "text",
                text: "Another review workflow is already running.",
              },
            ],
            details: { activeRunId: activeRun()?.id },
          };
        }

        const options: ReviewOptions = {
          files: params.files ?? [],
          staged: params.staged ?? false,
          noFix: params.noFix ?? false,
          base: normalizeBaseBranch(params.base),
          pr: normalizePullRequestSelector(params.pr),
          instructions: params.instructions?.trim() ?? "",
        };
        const creation = await createReviewRunWithStartGuard(pi, ctx.cwd, options);

        if (creation.kind === "cancelled") {
          return {
            content: [{ type: "text", text: "Review startup was cancelled." }],
            details: { targets: [] },
          };
        }

        if (creation.kind === "empty") {
          return {
            content: [
              {
                type: "text",
                text: "No changed files found for review. Pass explicit files to review whole files.",
              },
            ],
            details: { targets: [] },
          };
        }

        const active = startReviewRun(pi, creation.run, ctx);
        return {
          content: [
            {
              type: "text",
              text: `Queued review workflow ${active.id} phase 1/${active.phases.length} for ${active.targets.length} file(s):\n${active.targets
                .map(formatJsonTarget)
                .join("\n")}`,
            },
          ],
          details: {
            runId: active.id,
            targets: active.targets,
            ...reviewRunDetails(active),
          },
        };
      },
    });

    // Register a conditional bash tool override that sandboxes bash
    // during read-only review phases.
    const defaultBashTool = createBashToolDefinition(process.cwd());
    pi.registerTool({
      ...defaultBashTool,
      name: "bash",
      label: "bash",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!workflow.isReadOnlyPhase()) {
          const normalBashDef = createBashToolDefinition(ctx.cwd, {
            operations: createLocalBashOperations(),
          });
          return normalBashDef.execute(toolCallId, params, signal, onUpdate, ctx);
        }

        const execFn: ExecFn = (command, args, opts) =>
          pi.exec(command, args, {
            cwd: opts?.cwd ?? ctx.cwd,
            timeout: opts?.timeout,
          });

        const protectedOps = createProtectedBashOperations(execFn, ctx.cwd);
        const protectedBashDef = createBashToolDefinition(ctx.cwd, {
          operations: protectedOps,
        });

        try {
          return await protectedBashDef.execute(toolCallId, params, signal, onUpdate, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: message }],
            details: undefined,
          };
        }
      },
    });
  };
}

export default createReviewExtension();
