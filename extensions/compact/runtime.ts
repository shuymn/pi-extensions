import { StringEnum } from "@earendil-works/pi-ai";
import {
  compact as compactPrepared,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearWidget, notifyIfUI, setAboveEditorWidget } from "../../lib/tui";
import {
  CONTINUATION_LIMIT,
  GOAL_ENTRY,
  type Goal,
  goalContext,
  parseGoalStart,
  restoreGoal,
} from "./goal";
import {
  type CompactRequestState,
  type CompactScheduleOptions,
  initialCompactRequestState,
  scheduleCompactRequest,
} from "./policy";

const CONTINUE =
  "Continue the unfinished user-requested work using the latest Goal state, compaction summary, handoff instructions, and recent context. Do not repeat completed work.";

// One owner for both Goal and checkpoint continuation. No durable queued messages or timers.
export function createContinuationRuntime(pi: ExtensionAPI) {
  let goal: Goal | undefined;
  let authorized = false;
  let ordinaryWorkAllowed = true;
  let compact: CompactRequestState = initialCompactRequestState();
  let epoch = 0;
  let ended = false;
  let completedCheckpoint: Extract<CompactRequestState, { phase: "pending" }> | undefined;
  let stopBeforeRetry = false;
  let lastFailure: string | undefined;
  let releaseAbort: (() => void) | undefined;

  function save(ctx: ExtensionContext) {
    if (goal) pi.appendEntry(GOAL_ENTRY, structuredClone(goal));
    if (ctx.hasUI) {
      if (goal)
        setAboveEditorWidget(ctx, "goal", [
          `● Goal: ${goal.objective}`,
          `${goal.status} (${goal.continuations}/${CONTINUATION_LIMIT})`,
        ]);
      else clearWidget(ctx, "goal");
    }
  }
  function invalidate() {
    epoch++;
    completedCheckpoint = undefined;
    stopBeforeRetry = false;
    compact = initialCompactRequestState();
    ended = false;
    releaseAbort?.();
    releaseAbort = undefined;
  }
  function stop(ctx: ExtensionContext, status: "paused" | "waiting" | "failed", reason: string) {
    invalidate();
    authorized = false;
    ordinaryWorkAllowed = false;
    if (goal && goal.status !== "completed") {
      goal = { ...goal, status, evidence: reason };
      save(ctx);
    }
  }
  function watchAbort(signal: AbortSignal | undefined, ctx: ExtensionContext) {
    releaseAbort?.();
    if (!signal) return;
    const abort = () => stop(ctx, "paused", "User interrupted execution.");
    signal.addEventListener("abort", abort, { once: true });
    releaseAbort = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  }
  function send(ctx: ExtensionContext, prompt: string, source: string, automatic: boolean) {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (!authorized && !ordinaryWorkAllowed) return;
    if (source === "goal" || source === "goal-command" || authorized) {
      if (!goal || !authorized || goal.status !== "running") return;
      if (automatic) {
        if (goal.continuations >= CONTINUATION_LIMIT) {
          authorized = false;
          goal = {
            ...goal,
            status: "limited",
            evidence: "Continuation limit reached; use /goal resume to continue.",
          };
          save(ctx);
          notifyIfUI(
            ctx,
            "Goalの自動継続上限に達しました。再開には /goal resume を使ってください。",
            "warning",
          );
          return;
        }
        goal = { ...goal, continuations: goal.continuations + 1 };
        save(ctx);
      }
    }
    pi.sendMessage(
      { customType: "work-continuation", content: prompt, display: false, details: { source } },
      { triggerTurn: true },
    );
  }
  function failed(ctx: ExtensionContext, message: string) {
    stop(ctx, "failed", message);
    // Visible also in RPC/print sessions; no turn is triggered.
    pi.sendMessage(
      { customType: "work-stopped", content: `継続を停止しました: ${message}`, display: true },
      { triggerTurn: false },
    );
    notifyIfUI(ctx, `継続を停止しました: ${message}`, "error");
  }
  function settle(ctx: ExtensionContext) {
    if (!ended || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    ended = false;
    releaseAbort?.();
    releaseAbort = undefined;
    if (lastFailure) {
      failed(ctx, lastFailure);
      return;
    }
    if (completedCheckpoint) {
      const completed = completedCheckpoint;
      completedCheckpoint = undefined;
      if (completed.stopAfterCompaction) stop(ctx, "paused", "Stopped after compaction.");
      else
        send(
          ctx,
          [completed.customInstructions, completed.continuationPrompt ?? CONTINUE]
            .filter(Boolean)
            .join("\n\n"),
          "compact_context",
          true,
        );
      return;
    }
    if (compact.phase === "pending") {
      const pending = compact;
      compact = { phase: "compacting" };
      const requestEpoch = ++epoch;
      notifyIfUI(ctx, "コンテキスト圧縮を開始しました。", "info");
      const valid = () => epoch === requestEpoch && compact.phase === "compacting";
      const error = (e: Error) => {
        if (valid()) failed(ctx, e.message);
      };
      try {
        ctx.compact({
          customInstructions: pending.customInstructions,
          onComplete: () => {
            if (!valid()) return;
            compact = initialCompactRequestState();
            releaseAbort?.();
            releaseAbort = undefined;
            notifyIfUI(ctx, "コンテキスト圧縮が完了しました。", "info");
            if (pending.stopAfterCompaction) stop(ctx, "paused", "Stopped after compaction.");
            else send(ctx, pending.continuationPrompt ?? CONTINUE, "compact_context", true);
          },
          onError: error,
        });
      } catch (e) {
        error(e instanceof Error ? e : new Error(String(e)));
      }
      return;
    }
    if (compact.phase === "idle" && authorized) send(ctx, CONTINUE, "goal", true);
  }

  pi.registerCommand("goal", {
    description:
      "Goalを明示開始・再開・停止: /goal start 目的 | 完了条件 [| 条件]、resume、stop、status",
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/);
      if (action === "stop") {
        stop(ctx, "paused", "User stopped the Goal.");
        ctx.abort();
        return;
      }
      if (action === "status" || !action) {
        pi.sendMessage(
          {
            customType: "goal-status",
            content: goal ? JSON.stringify(goal, null, 2) : "Goalはありません。",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        notifyIfUI(ctx, "実行中です。停止してからGoalを開始・再開してください。", "warning");
        return;
      }
      if (action === "start") {
        const parsed = parseGoalStart(rest.join(" "));
        if (!parsed) {
          notifyIfUI(ctx, "/goal start 目的 | 完了条件 [| 条件] を指定してください。", "warning");
          return;
        }
        invalidate();
        goal = { ...parsed, status: "running", continuations: 0, evidence: "" };
      } else if (action === "resume" && goal && goal.status !== "completed") {
        invalidate();
        goal = { ...goal, status: "running", continuations: 0, evidence: "" };
      } else {
        notifyIfUI(
          ctx,
          "開始には /goal start 目的 | 完了条件、再開には /goal resume を使ってください。",
          "warning",
        );
        return;
      }
      authorized = true;
      lastFailure = undefined;
      save(ctx);
      send(ctx, goalContext(goal), "goal-command", false);
    },
  });
  pi.registerTool({
    name: "goal",
    label: "Goal",
    description:
      "Read or finish an explicitly user-started Goal. This tool cannot start or resume automatic execution. Use wait before requesting required human input/approval. Completion requires verification evidence for all doneWhen conditions.",
    parameters: Type.Object({
      action: StringEnum(["status", "complete", "wait", "stop"]),
      evidence: Type.Optional(
        Type.String({
          description: "Required verification evidence for complete, or reason for wait/stop.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action !== "status") {
        if (!goal || !authorized || goal.status !== "running")
          throw new Error("No running user-authorized Goal.");
        if (!params.evidence?.trim()) throw new Error("Evidence or reason is required.");
        if (params.action === "complete") {
          invalidate();
          authorized = false;
          goal = { ...goal, status: "completed", evidence: params.evidence.trim() };
          save(ctx);
        } else stop(ctx, params.action === "wait" ? "waiting" : "paused", params.evidence.trim());
      }
      return {
        content: [
          {
            type: "text",
            text: goal
              ? JSON.stringify(goal)
              : "No Goal. Start explicitly with /goal start objective | doneWhen.",
          },
        ],
        details: { goal: goal ? structuredClone(goal) : null },
      };
    },
  });
  const restore = (ctx: ExtensionContext) => {
    invalidate();
    authorized = false;
    lastFailure = undefined;
    goal = restoreGoal(ctx.sessionManager.getBranch());
    save(ctx);
  };
  pi.on("input", async (e) => {
    if (e.source !== "extension") ordinaryWorkAllowed = true;
  });
  pi.on("session_start", async (_e, ctx) => restore(ctx));
  pi.on("session_tree", async (_e, ctx) => restore(ctx));
  const leaving = async (_e: unknown, ctx: ExtensionContext) => {
    if (goal?.status === "running") stop(ctx, "paused", "Session changed or closed.");
    else {
      invalidate();
      authorized = false;
    }
  };
  pi.on("session_before_switch", leaving);
  pi.on("session_before_fork", leaving);
  pi.on("session_before_tree", leaving);
  pi.on("session_shutdown", leaving);
  pi.on("turn_start", async (_e, ctx) => {
    if (stopBeforeRetry) {
      stop(ctx, "paused", "Stopped after compaction.");
      ctx.abort();
      return;
    }
    watchAbort(ctx.signal, ctx);
  });
  pi.on("agent_start", async () => {
    ended = false;
    lastFailure = undefined;
  });
  pi.on("agent_end", async (e, ctx) => {
    ended = true;
    const last = [...e.messages].reverse().find((m) => m.role === "assistant");
    if (last?.role === "assistant" && last.stopReason === "aborted") {
      stop(ctx, "paused", "User interrupted execution.");
      return;
    }
    lastFailure =
      last?.role === "assistant" && ["error", "length"].includes(last.stopReason)
        ? (last.errorMessage ?? `Assistant stopped: ${last.stopReason}`)
        : undefined;
  });
  pi.on("agent_settled", async (_e, ctx) => settle(ctx));
  pi.on("session_before_compact", async (e, ctx) => {
    watchAbort(e.signal, ctx);
    if (e.reason === "manual" || compact.phase !== "pending" || !compact.customInstructions) return;
    // Auto-compaction has no instruction override in Pi 0.85.1. Supply the
    // standard summarizer's result while Pi still owns publication and retry.
    const instructions = compact.customInstructions;
    try {
      const model = ctx.model;
      if (!model) throw new Error("No model available for compaction.");
      const provider = ctx.modelRegistry.getProvider(model.provider);
      if (!provider) throw new Error("No provider available for compaction.");
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      const headers = Object.fromEntries(
        Object.entries(auth.headers ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== null,
        ),
      );
      return {
        compaction: await compactPrepared(
          e.preparation,
          auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
          auth.apiKey,
          headers,
          undefined,
          e.signal,
          pi.getThinkingLevel(),
          (m, context, options) =>
            provider.streamSimple(
              m,
              {
                ...context,
                // Apply the focus to both history and split-turn summaries.
                messages: [
                  ...context.messages,
                  {
                    role: "user",
                    content: `Additional focus: ${instructions}`,
                    timestamp: Date.now(),
                  },
                ],
              },
              options,
            ),
          auth.env,
        ),
      };
    } catch (error) {
      if (!e.signal.aborted) failed(ctx, error instanceof Error ? error.message : String(error));
      // Do not silently fall back to a summary that omits the requested focus.
      return { cancel: true };
    }
  });
  pi.on("session_compact", async (e) => {
    if (compact.phase === "pending") {
      completedCheckpoint = compact;
      compact = initialCompactRequestState();
      stopBeforeRetry = e.willRetry && completedCheckpoint.stopAfterCompaction;
      // Native retry already consumes the checkpoint continuation.
      if (e.willRetry && !stopBeforeRetry) completedCheckpoint = undefined;
    }
    releaseAbort?.();
    releaseAbort = undefined;
    // Native overflow recovery owns its retry; do not create a second continuation.
  });
  pi.on("session_compact_failed", async (e, ctx) => {
    if (e.aborted) {
      if (goal?.status !== "failed") stop(ctx, "paused", "Compaction interrupted.");
    } else failed(ctx, e.errorMessage ?? "Compaction failed.");
  });
  pi.on("ui_prompt_start", async (_e, ctx) => {
    stop(ctx, "waiting", "Waiting for human input; use /goal resume after answering.");
  });
  pi.on("tool_result", async (e, ctx) => {
    if (
      e.toolName === "ask_user_question" &&
      (e.details as { status?: string } | undefined)?.status !== "completed"
    ) {
      stop(ctx, "waiting", "Human answer is required; use /goal resume after answering.");
    }
  });
  pi.on("context", async (e) =>
    goal
      ? {
          messages: [
            ...e.messages,
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: goalContext(goal) }],
              timestamp: Date.now(),
            },
          ],
        }
      : undefined,
  );

  return {
    get state() {
      return compact;
    },
    schedule(options: CompactScheduleOptions) {
      const result = scheduleCompactRequest(compact, options);
      if (result.accepted) compact = result.state;
      return result;
    },
  };
}
