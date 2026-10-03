import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseCommandArgs } from "../../lib/command-args";
import { addUsage, emptyUsage, runDelegatedSession } from "../../lib/delegated-session";
import { notifyIfUI } from "../../lib/tui";
import { safeRepositoryPath } from "./authorization";
import { createReviewControls } from "./controls";
import {
  type ReviewInspectParams,
  ReviewInspectSchema,
  type ReviewRun,
  ReviewRunSchema,
} from "./types";

const RESULT_ENTRY = "review-result";

export function parseReviewArgs(args: string): ReviewInspectParams {
  const parsed = parseCommandArgs({
    args,
    booleanFlags: ["--staged", "--cached", "--no-fix"],
    valueFlags: ["--base", "--pr"],
  });
  const errors = Object.values(parsed.valueErrors);
  if (errors.length) throw new Error(errors.join("; "));
  const staged = parsed.flags["--staged"] || parsed.flags["--cached"];
  const base = parsed.values["--base"];
  const pr = parsed.values["--pr"];
  if (
    [parsed.files.length > 0, staged, base !== undefined, pr !== undefined].filter(Boolean).length >
    1
  ) {
    throw new Error("対象は files / --staged / --base / --pr のいずれか一つを指定してください。");
  }
  return {
    scope: parsed.files.length
      ? { mode: "files", files: parsed.files.map(safeRepositoryPath) }
      : pr !== undefined
        ? { mode: "pr", pr }
        : base !== undefined
          ? { mode: "base", base }
          : { mode: staged ? "staged" : "working" },
    noFix: parsed.flags["--no-fix"],
    ...(parsed.instructions ? { focus: [parsed.instructions] } : {}),
  };
}

export function createReviewExtension(runAgent = runDelegatedSession) {
  return (pi: ExtensionAPI) => {
    let controls: ReturnType<typeof createReviewControls> | undefined;
    let context: ExtensionContext;
    let commandRequest: ReviewInspectParams | undefined;
    let operationUsage: Usage | undefined;
    let active: { controller: AbortController; done: Promise<unknown> } | undefined;

    const revoke = () => {
      commandRequest = undefined;
    };
    const reset = async () => {
      revoke();
      active?.controller.abort();
      await active?.done;
      controls = undefined;
    };
    const getControls = (ctx: ExtensionContext) => {
      context = ctx;
      controls ??= createReviewControls({
        cwd: ctx.cwd,
        execGit: (args, options) => pi.exec("git", args, options),
        execGh: (args, options) => pi.exec("gh", args, options),
        runAgent: async (request) => {
          if (!context.model) throw new Error("Select a model before reviewing.");
          const usage = operationUsage;
          const result = await runAgent({
            ...request,
            name: request.label,
            cwd: context.cwd,
            model: context.model,
            modelRegistry: context.modelRegistry,
            thinkingLevel: pi.getThinkingLevel(),
            settings: pi.getSettings(),
            systemPrompt: `${context.getSystemPrompt()}\n\n${request.recoveryContext ?? ""}`,
            exec: (command, args, options) => pi.exec(command, args, options),
          });
          // Failed/cancelled children can still have incurred billable requests.
          if (usage) addUsage(usage, result.usage);
          return {
            status: result.status === "cancelled" ? "aborted" : result.status,
            output: result.result,
            error: result.error,
          };
        },
      });
      return controls;
    };

    pi.registerTool({
      name: "review",
      label: "Review",
      description:
        "Review a host-resolved repository scope, validate independent findings, then repair and verify them in one task by default (action=run). Use noFix=true or action=inspect only when the user requests report-only review. Repair includes repeated in-scope edits, failure investigation, and ordinary local bash verification until checks pass or a concrete blocker requires user input/access/scope expansion. No manual review-fix handoff is needed. Preserve unrelated changes; commit, push, publication, destructive operations, and external writes require separate authorization. status reads an in-memory run; reports are recorded in session entries.",
      exposure: "deferred",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          action: Type.Optional(StringEnum(["run", "inspect", "status"])),
          inspect: Type.Optional(ReviewInspectSchema),
          runId: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object({ run: ReviewRunSchema }),
      async execute(_id, params, signal, _update, ctx) {
        if (active) throw new Error("A review operation is already running.");
        const requestedAction = params.action ?? "run";
        if (
          requestedAction === "status" ? params.inspect !== undefined : params.runId !== undefined
        ) {
          throw new Error("Use inspect options for run/inspect, and runId only for status.");
        }
        if (requestedAction === "status" && !params.runId) throw new Error("runId is required.");
        // The command's actual scope and no-fix choice take precedence over model arguments.
        const action = commandRequest && requestedAction !== "status" ? "run" : requestedAction;
        const input = structuredClone({ ...params.inspect, ...commandRequest });
        if (commandRequest?.focus && params.inspect?.focus) {
          input.focus = [...new Set([...commandRequest.focus, ...params.inspect.focus])];
        }
        const control = getControls(ctx);
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const usage = emptyUsage();
        operationUsage = usage;
        const operation = (async () => {
          const run: ReviewRun =
            action === "run"
              ? await control.run(input, combined)
              : action === "inspect"
                ? await control.inspect(input, combined)
                : control.status(params.runId ?? "");
          if (action !== "status") pi.appendEntry(RESULT_ENTRY, run);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(run) }],
            details: { run },
            structuredContent: { run },
            ...(action !== "status" ? { usage } : {}),
          };
        })();
        active = { controller, done: operation.catch(() => {}) };
        try {
          return await operation;
        } finally {
          active = undefined;
          operationUsage = undefined;
        }
      },
    });

    pi.registerCommand("review", {
      description:
        "レビュー・修正・検証を実行（--no-fix で調査のみ）: /review [files | --staged | --base ref | --pr selector]",
      handler: async (args, ctx) => {
        if (!ctx.isIdle() || ctx.hasPendingMessages() || active) {
          notifyIfUI(
            ctx,
            "実行中です。処理の終了または中止後に review を開始してください。",
            "warning",
          );
          return;
        }
        try {
          revoke();
          commandRequest = parseReviewArgs(args);
          pi.sendMessage(
            {
              customType: "review-request",
              content: `The user requests a review task with these host-bound options: ${JSON.stringify(commandRequest)}. Call review with action=run. Review includes repair and verification unless noFix is true. Follow the review skill, account for coverage and checks, and report any concrete blockers. No separate fix approval is needed within scope; commits, publication, destructive operations, scope expansion, and external writes are not authorized.`,
              display: true,
            },
            { triggerTurn: true },
          );
        } catch (error) {
          revoke();
          notifyIfUI(ctx, error instanceof Error ? error.message : String(error), "error");
        }
      },
    });

    pi.on("session_start", reset);
    pi.on("session_before_switch", reset);
    pi.on("session_before_fork", reset);
    pi.on("session_before_tree", reset);
    pi.on("session_tree", reset);
    pi.on("session_shutdown", reset);
    pi.on("input", async () => {
      revoke();
      active?.controller.abort();
    });
    pi.on("agent_settled", async () => revoke());
  };
}

export default createReviewExtension();
