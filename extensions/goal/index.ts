import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isOneShotPrimaryModeSelected } from "../../lib/one-shot-flow";
import { clearWidget, notifyIfUI, setAboveEditorWidget } from "../../lib/tui";
import {
  GOAL_ENTRY,
  type Goal,
  goalContext,
  goalStatusLabel,
  parseGoalStart,
  restoreGoal,
} from "./state";

export default function goalExtension(pi: ExtensionAPI) {
  // Bounded modes must not register Goal commands, restore state, or continue work.
  if (isOneShotPrimaryModeSelected()) return;

  let goal: Goal | undefined;
  // Deliberately ephemeral: stored state and model text cannot restore authorization.
  let authorized = false;
  let continuationPending = false;
  let releaseAbort: (() => void) | undefined;

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (goal && goal.status !== "completed") {
      setAboveEditorWidget(ctx, "goal", [
        `● Goal: ${goal.objective}`,
        goalStatusLabel(goal.status),
      ]);
    } else clearWidget(ctx, "goal");
  }

  function save(ctx: ExtensionContext) {
    if (goal) pi.appendEntry(GOAL_ENTRY, structuredClone(goal));
    render(ctx);
  }

  function revoke() {
    authorized = false;
    continuationPending = false;
    releaseAbort?.();
    releaseAbort = undefined;
  }

  function stop(ctx: ExtensionContext, status: "paused" | "waiting" | "failed", reason: string) {
    const cancelContinuation = continuationPending;
    revoke();
    if (goal?.status === "running") {
      goal = { ...goal, status, evidence: reason };
      save(ctx);
    }
    // A later boundary handler can open a human dialog after our proposal.
    // Revoke that proposal too, without interrupting ordinary tool follow-ups.
    if (cancelContinuation) ctx.abort();
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
            content: goal
              ? `Goal: ${goal.objective}\n状態: ${goalStatusLabel(goal.status)}\n完了条件:\n${goal.doneWhen.map((condition) => `- ${condition}`).join("\n")}\n証跡・停止理由: ${goal.evidence || "未記録"}`
              : "Goalはありません。",
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
        revoke();
        goal = { ...parsed, status: "running", continuations: 0, evidence: "" };
      } else if (action === "resume" && goal && goal.status !== "completed") {
        revoke();
        goal = { ...goal, status: "running" };
      } else {
        notifyIfUI(
          ctx,
          "開始には /goal start 目的 | 完了条件、再開には /goal resume を使ってください。",
          "warning",
        );
        return;
      }
      authorized = true;
      save(ctx);
      // Only an explicit user command starts a new run. All subsequent Goal work
      // belongs to Pi's current run via the native pre-settlement boundary below.
      pi.sendMessage(
        { customType: "goal-start", content: goalContext(goal), display: false },
        { triggerTurn: true },
      );
    },
  });

  pi.registerTool({
    name: "goal",
    exposure: "model-only",
    label: "Goal",
    description:
      "Read or finish an explicitly user-started Goal. This tool cannot start or resume execution. Use wait before requesting required human input/approval. Completion requires reported verification evidence for every doneWhen condition; the tool stores that report but does not verify its truth. complete, wait, and stop end the turn.",
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
          revoke();
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
              : "No Goal. Only the user can start one with /goal start objective | doneWhen.",
          },
        ],
        details: { goal: goal ? structuredClone(goal) : null },
        ...(params.action !== "status" ? { terminate: true } : {}),
      };
    },
  });

  const restore = (ctx: ExtensionContext) => {
    revoke();
    goal = restoreGoal(ctx.sessionManager.getBranch());
    save(ctx);
  };
  pi.on("session_start", async (_e, ctx) => restore(ctx));
  pi.on("session_tree", async (_e, ctx) => restore(ctx));
  const leaving = async (_e: unknown, ctx: ExtensionContext) => {
    stop(ctx, "paused", "Session changed or closed; use /goal resume to continue.");
  };
  pi.on("session_before_switch", leaving);
  pi.on("session_before_fork", leaving);
  pi.on("session_before_tree", leaving);
  pi.on("session_shutdown", leaving);

  pi.on("turn_start", async (_e, ctx) => {
    continuationPending = false;
    releaseAbort?.();
    releaseAbort = undefined;
    if (!authorized || !ctx.signal) return;
    const signal = ctx.signal;
    const abort = () => stop(ctx, "paused", "User interrupted execution.");
    signal.addEventListener("abort", abort, { once: true });
    releaseAbort = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!authorized || goal?.status !== "running") return;
    if (event.outcome !== "completed") {
      stop(
        ctx,
        event.outcome === "aborted" ? "paused" : "failed",
        `Execution ended: ${event.outcome}.`,
      );
      return;
    }
    // Another extension or a queued user message already owns the next request.
    if (event.continue || event.context.pendingMessages.length > 0) return;
    goal = { ...goal, continuations: goal.continuations + 1 };
    // Persist before proposing the next request: a later handler's stop/wait
    // record must not be overwritten by a stale running-state boundary draft.
    save(ctx);
    continuationPending = true;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "goal-continuation",
          content: `Continue the unfinished user-authorized Goal. Do not repeat completed work.\n\n${goalContext(goal)}`,
          display: false,
        },
      ],
      continue: true,
    };
  });

  pi.on("agent_settled", async (_e, ctx) => {
    // Notification only. This also covers aborts between turns or during native
    // compaction, when no live turn signal or pre-settlement event is available.
    continuationPending = false;
    stop(ctx, "paused", "Execution settled without continuation; use /goal resume to continue.");
  });
  pi.on("ui_prompt_start", async (_e, ctx) => {
    stop(ctx, "waiting", "Waiting for human input; use /goal resume after answering.");
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "ask_user_question") {
      stop(ctx, "waiting", "Human input is required; use /goal resume after answering.");
    }
  });
  pi.on("context", async (event) =>
    goal
      ? {
          messages: [
            ...event.messages,
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: goalContext(goal) }],
              timestamp: Date.now(),
            },
          ],
        }
      : undefined,
  );
}
