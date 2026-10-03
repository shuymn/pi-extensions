import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addUsage, emptyUsage, runDelegatedSession } from "../../lib/delegated-session";
import { isOneShotPrimaryModeSelected } from "../../lib/one-shot-flow";
import { notifyIfUI } from "../../lib/tui";
import { createReviewControls } from "./controls";
import { createReviewMutationTools } from "./mutation-tools";
import { ReviewInspectSchema, type ReviewRun, ReviewRunSchema } from "./types";

const RESULT_ENTRY = "review-result";

export function createReviewExtension(runAgent = runDelegatedSession) {
  return (pi: ExtensionAPI) => {
    let controls: ReturnType<typeof createReviewControls> | undefined;
    let context: ExtensionContext;
    let authorizedRunId: string | undefined;
    let mutationFiles: string[] | undefined;
    let operationUsage: Usage | undefined;
    let active: { controller: AbortController; done: Promise<unknown> } | undefined;
    let releaseAbort: (() => void) | undefined;

    const revoke = () => {
      authorizedRunId = undefined;
      releaseAbort?.();
      releaseAbort = undefined;
    };
    const reset = async () => {
      revoke();
      active?.controller.abort();
      await active?.done;
      controls = undefined;
      mutationFiles = undefined;
    };
    const getControls = (ctx: ExtensionContext) => {
      context = ctx;
      controls ??= createReviewControls({
        cwd: ctx.cwd,
        execGit: (args, options) => pi.exec("git", args, options),
        execGh: (args, options) => pi.exec("gh", args, options),
        authorizeFix: async (run) => {
          const authorized = authorizedRunId === run.runId;
          revoke(); // Consent is ephemeral and single-use, including failed preflight.
          mutationFiles = authorized ? [...run.targetFiles] : undefined;
          return authorized;
        },
        runAgent: async (request) => {
          if (!context.model) throw new Error("Select a model before reviewing.");
          if (!request.readOnly && !mutationFiles) throw new Error("No authorized fix scope.");
          const usage = operationUsage;
          const result = await runAgent({
            ...request,
            name: request.label,
            cwd: context.cwd,
            model: context.model,
            modelRegistry: context.modelRegistry,
            thinkingLevel: pi.getThinkingLevel(),
            systemPrompt: context.getSystemPrompt(),
            exec: (command, args, options) => pi.exec(command, args, options),
            customTools: request.readOnly
              ? []
              : createReviewMutationTools(context.cwd, mutationFiles ?? []),
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
        "Inspect a host-resolved repository scope with bounded read-only agents and validated coverage. Inspection and validation are static; runtime checks are reported separately as not_run. inspect returns a runId, findings, issues, and receipts; status reads an in-memory run. fix requires the user to invoke /review-fix <runId> first, fresh scope checks, and complete validation. Tool arguments cannot grant permission. Fix can edit only reviewed files, with no shell, network or delegation tools; report unrun checks honestly. Runs are session-local; completed reports are also recorded in session entries.",
      exposure: isOneShotPrimaryModeSelected() ? "direct" : "deferred",
      executionMode: "sequential",
      parameters: Type.Object(
        {
          action: StringEnum(["inspect", "status", "fix"]),
          inspect: Type.Optional(ReviewInspectSchema),
          runId: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
      outputSchema: Type.Object({ run: ReviewRunSchema }),
      async execute(_id, params, signal, _update, ctx) {
        if (active) throw new Error("A review operation is already running.");
        if (
          params.action === "inspect" ? params.runId !== undefined : params.inspect !== undefined
        ) {
          throw new Error("Use inspect options only for inspect, and runId only for status/fix.");
        }
        const runId = params.runId ?? "";
        if (params.action !== "inspect" && !runId) throw new Error("runId is required.");
        const control = getControls(ctx);
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const usage = emptyUsage();
        operationUsage = usage;
        const operation = (async () => {
          const run: ReviewRun =
            params.action === "inspect"
              ? await control.inspect(params.inspect, combined)
              : params.action === "fix"
                ? await control.fix(runId, combined)
                : control.status(runId);
          if (params.action !== "status") pi.appendEntry(RESULT_ENTRY, run);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(run) }],
            details: { run },
            structuredContent: { run },
            ...(params.action !== "status" ? { usage } : {}),
          };
        })();
        active = { controller, done: operation.catch(() => {}) };
        try {
          return await operation;
        } finally {
          active = undefined;
          operationUsage = undefined;
          mutationFiles = undefined;
          if (params.action === "fix") revoke();
        }
      },
    });

    pi.registerCommand("review-fix", {
      description: "検証済み review の修正を一度だけ認可: /review-fix <runId>",
      handler: async (args, ctx) => {
        if (!ctx.isIdle() || ctx.hasPendingMessages() || active) {
          notifyIfUI(ctx, "実行中です。処理が終了してから修正を認可してください。", "warning");
          return;
        }
        try {
          const run = getControls(ctx).status(args.trim());
          if (run.noFix || run.status !== "ready" || run.findings.length === 0 || run.fix) {
            throw new Error(
              "修正可能な検証済み findings がありません。再度 review を実行してください。",
            );
          }
          revoke();
          authorizedRunId = run.runId;
          pi.sendMessage(
            {
              customType: "review-fix-request",
              content: `The user authorizes one local fix attempt for review ${run.runId}. Call review with action=fix and that runId. Do not bypass its safety checks. Report the result and unrun verification; this does not authorize commits, publication, or external writes.`,
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
    pi.on("input", async () => revoke());
    pi.on("agent_settled", async () => revoke());
    pi.on("turn_start", async (_event, ctx) => {
      releaseAbort?.();
      releaseAbort = undefined;
      if (!authorizedRunId || !ctx.signal) return;
      const signal = ctx.signal;
      signal.addEventListener("abort", revoke, { once: true });
      releaseAbort = () => signal.removeEventListener("abort", revoke);
      if (signal.aborted) revoke();
    });
  };
}

export default createReviewExtension();
