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

const COMPACT_TOOL_PARAMETERS = Type.Object({
  customInstructions: Type.Optional(
    Type.String({
      description:
        "Optional instructions for Pi's compaction summary. Use only when a concise focus will make the checkpoint more useful.",
    }),
  ),
});

type CompactToolParams = Static<typeof COMPACT_TOOL_PARAMETERS>;

type CompactToolDetails = {
  accepted: boolean;
  status: "scheduled" | "pending" | "compacting";
  customInstructions?: string;
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

export default function compactExtension(pi: ExtensionAPI) {
  let state: CompactRequestState = initialCompactRequestState();

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
    ],
    parameters: COMPACT_TOOL_PARAMETERS,
    executionMode: "sequential",
    async execute(_toolCallId, params: CompactToolParams, _signal, _onUpdate, ctx) {
      const result = scheduleCompactRequest(state, params.customInstructions);
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

    if (!decision.inject) return;

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
          state = finishCompactRequest();
          notifyCompactionCompleted(ctx);
        },
        onError: (error) => {
          state = finishCompactRequest();
          notifyCompactionFailed(ctx, error);
        },
      });
    } catch (error) {
      state = finishCompactRequest();
      notifyCompactionFailed(ctx, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
