import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { terminatingTextResult } from "../../lib/structured-tool";
import { notifyIfUI } from "../../lib/tui";
import {
  buildCompactWarningMessage,
  COMPACT_TOOL_NAME,
  type CompactRequestState,
  decideCompactWarning,
  finishCompactRequest,
  initialCompactRequestState,
  readCompactionReserveTokensForCwd,
  scheduleCompactRequest,
  takePendingCompactRequest,
} from "./policy";

const DEFAULT_CONTINUATION_PROMPT = [
  "Context compaction completed.",
  "Continue the current user-requested work from the compaction summary, recent context, and any active reminders.",
  "Do not repeat completed steps.",
  "Do not request another compaction immediately unless context is still high and the next safe checkpoint has been reached.",
].join(" ");

const COMPACT_CONTINUATION_CUSTOM_TYPE = "compact-continuation";

const COMPACT_TOOL_PARAMETERS = Type.Object({
  customInstructions: Type.Optional(
    Type.String({
      description:
        "Optional instructions for Pi's compaction summary. Use only when a concise focus will make the checkpoint more useful.",
    }),
  ),
  continuationPrompt: Type.Optional(
    Type.String({
      description:
        "Optional follow-up instruction to run after successful compaction. Use a concise prompt for continuing unfinished user-requested work.",
    }),
  ),
  stopAfterCompaction: Type.Optional(
    Type.Boolean({
      description:
        "When true, compact and stop instead of automatically triggering a follow-up turn. Use only when no continuation is needed.",
    }),
  ),
});

type CompactToolParams = Static<typeof COMPACT_TOOL_PARAMETERS>;

type CompactToolDetails =
  | {
      accepted: true;
      status: "scheduled";
      customInstructions?: string;
      continuationPrompt?: string;
      stopAfterCompaction: boolean;
    }
  | {
      accepted: false;
      status: "pending" | "compacting";
    };

function appendTransientWarning(messages: ContextEvent["messages"]): ContextEvent["messages"] {
  return [
    ...messages,
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: buildCompactWarningMessage() }],
      timestamp: Date.now(),
    },
  ];
}

function compactPendingMessage(status: "pending" | "compacting"): string {
  return status === "pending"
    ? "A context compaction request is already scheduled for turn_end."
    : "Context compaction is already in progress.";
}

function notifyCompactionStarted(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  notifyIfUI(ctx, "コンテキスト圧縮を開始しました。", "info");
}

function notifyCompactionScheduled(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  notifyIfUI(ctx, "コンテキスト圧縮を予約しました。ターン終了時に実行します。", "info");
}

function notifyCompactionCompleted(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  notifyIfUI(ctx, "コンテキスト圧縮が完了しました。", "info");
}

function notifyCompactionFailed(ctx: Pick<ExtensionContext, "hasUI" | "ui">, error: Error): void {
  notifyIfUI(ctx, `コンテキスト圧縮に失敗しました: ${error.message}`, "error");
}

function sendContinuation(pi: ExtensionAPI, continuationPrompt?: string): void {
  pi.sendMessage(
    {
      customType: COMPACT_CONTINUATION_CUSTOM_TYPE,
      content: continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT,
      display: false,
      details: {
        source: COMPACT_TOOL_NAME,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

export default function compactExtension(pi: ExtensionAPI) {
  let state: CompactRequestState = initialCompactRequestState();
  let warningAlreadyInjected = false;

  function finishCompaction(): void {
    state = finishCompactRequest();
    warningAlreadyInjected = false;
  }

  pi.registerTool({
    name: COMPACT_TOOL_NAME,
    label: "Compact Context",
    description:
      "Request Pi context compaction at a semantic checkpoint. The request is scheduled and runs after the current tool result lands at turn_end.",
    promptSnippet: "Request Pi context compaction at a semantic checkpoint",
    promptGuidelines: [
      `Use ${COMPACT_TOOL_NAME} only when context usage is high and the current atomic step is complete.`,
      `Call ${COMPACT_TOOL_NAME} as the only tool; do not combine it with other tool calls in the same response.`,
      `Do not use ${COMPACT_TOOL_NAME} as a general summarization tool or as a substitute for answering the user.`,
      "By default, compaction will trigger a follow-up turn to continue unfinished work; set stopAfterCompaction only when no continuation is needed.",
    ],
    parameters: COMPACT_TOOL_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params: CompactToolParams, _signal, _onUpdate, ctx) {
      const result = scheduleCompactRequest(state, params);
      if (!result.accepted) {
        const status = result.reason;
        return terminatingTextResult(compactPendingMessage(status), {
          accepted: false,
          status,
        } satisfies CompactToolDetails);
      }

      state = result.state;
      notifyCompactionScheduled(ctx);

      return terminatingTextResult(
        "Context compaction has been scheduled and will run at turn_end.",
        {
          accepted: true,
          status: "scheduled",
          customInstructions: state.customInstructions,
          continuationPrompt: state.continuationPrompt,
          stopAfterCompaction: state.stopAfterCompaction,
        } satisfies CompactToolDetails,
      );
    },
  });

  pi.on("context", async (event, ctx) => {
    const decision = decideCompactWarning({
      usage: ctx.getContextUsage(),
      reserveTokens: readCompactionReserveTokensForCwd(ctx.cwd),
      state,
    });

    if (!decision.inject) {
      if (decision.reason === "not_near_threshold") warningAlreadyInjected = false;
      return;
    }

    if (warningAlreadyInjected) return;

    warningAlreadyInjected = true;
    return {
      messages: appendTransientWarning(event.messages),
    };
  });

  pi.on("turn_end", async (_event, ctx) => {
    const pending = takePendingCompactRequest(state);
    if (!pending.taken) return;

    state = pending.state;
    notifyCompactionStarted(ctx);

    try {
      ctx.compact({
        customInstructions: pending.customInstructions,
        onComplete: () => {
          finishCompaction();
          notifyCompactionCompleted(ctx);
          if (!pending.stopAfterCompaction) sendContinuation(pi, pending.continuationPrompt);
        },
        onError: (error) => {
          finishCompaction();
          notifyCompactionFailed(ctx, error);
        },
      });
    } catch (error) {
      finishCompaction();
      notifyCompactionFailed(ctx, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
