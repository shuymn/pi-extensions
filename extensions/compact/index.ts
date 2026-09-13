import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

import { terminatingTextResult } from "../../lib/structured-tool";
import { notifyIfUI } from "../../lib/tui";
import {
  buildCompactWarningMessage,
  COMPACT_TOOL_NAME,
  decideCompactWarning,
  readAutoCompactionEnabledForCwd,
  readCompactionReserveTokensForCwd,
} from "./policy";

import { createContinuationRuntime } from "./runtime";

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
        "When true, compact and stop instead of automatically triggering a follow-up turn. This is not a substitute for a final response when all user-requested work is complete.",
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

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

type CompactToolRenderResult = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

const TOOL_RENDER_PREVIEW_MAX_CHARS = 240;

function optionalTextPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length <= TOOL_RENDER_PREVIEW_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RENDER_PREVIEW_MAX_CHARS - 1)}…`;
}

function renderCompactCall(args: unknown, theme: ThemeLike): Text {
  const params = (args ?? {}) as Partial<CompactToolParams>;
  const customInstructionLine = optionalTextPreview(params.customInstructions);
  const title = theme.fg("toolTitle", theme.bold(COMPACT_TOOL_NAME));
  const lines = customInstructionLine ? [title, theme.fg("dim", customInstructionLine)] : [title];
  return new Text(lines.join("\n"), 0, 0);
}

function fallbackResultText(result: CompactToolRenderResult): string {
  const first = result.content?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function isCompactToolDetails(value: unknown): value is CompactToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as { accepted?: unknown; status?: unknown };
  if (details.accepted === true) return details.status === "scheduled";
  if (details.accepted === false)
    return details.status === "pending" || details.status === "compacting";
  return false;
}

function renderCompactResult(
  result: CompactToolRenderResult,
  _options: unknown,
  theme: ThemeLike,
): Text {
  const details = result.details;
  if (!isCompactToolDetails(details)) return new Text(fallbackResultText(result), 0, 0);

  if (!details.accepted) {
    return new Text(theme.fg("warning", compactPendingMessage(details.status)), 0, 0);
  }

  return new Text("", 0, 0);
}

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
    ? "A context compaction request is already scheduled for agent_settled."
    : "Context compaction is already in progress.";
}

function notifyCompactionScheduled(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  notifyIfUI(ctx, "コンテキスト圧縮を予約しました。実行が落ち着いた後に実行します。", "info");
}

export default function compactExtension(pi: ExtensionAPI) {
  const runtime = createContinuationRuntime(pi);
  let warningAlreadyInjected = false;
  pi.on("session_compact", async () => {
    warningAlreadyInjected = false;
  });
  pi.on("session_start", async () => {
    warningAlreadyInjected = false;
  });

  pi.registerTool({
    name: COMPACT_TOOL_NAME,
    label: "Compact Context",
    description:
      "Request Pi context compaction at a semantic checkpoint. The request is scheduled and runs after the current tool result lands at agent_settled.",
    promptSnippet: "Request Pi context compaction at a semantic checkpoint",
    promptGuidelines: [
      `Use ${COMPACT_TOOL_NAME} only when context usage is high, unfinished user-requested work remains, and the current atomic step is complete.`,
      `Call ${COMPACT_TOOL_NAME} as the only tool; do not combine it with other tool calls in the same response.`,
      `Do not use ${COMPACT_TOOL_NAME} for general summarization or when only a final response or completion report remains.`,
      `${COMPACT_TOOL_NAME} continues unfinished work by default; set stopAfterCompaction only when compaction is needed without a follow-up.`,
    ],
    parameters: COMPACT_TOOL_PARAMETERS,
    executionMode: "sequential",
    renderCall: renderCompactCall,
    renderResult: renderCompactResult,
    async execute(_toolCallId, params: CompactToolParams, _signal, _onUpdate, ctx) {
      const result = runtime.schedule(params);
      if (!result.accepted) {
        const status = result.reason;
        return terminatingTextResult(compactPendingMessage(status), {
          accepted: false,
          status,
        } satisfies CompactToolDetails);
      }

      const state = result.state;
      notifyCompactionScheduled(ctx);

      return terminatingTextResult(
        "Context compaction has been scheduled and will run at agent_settled.",
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
    const autoCompactionEnabled = readAutoCompactionEnabledForCwd(ctx.cwd);
    const decision = decideCompactWarning({
      usage: ctx.getContextUsage(),
      reserveTokens: readCompactionReserveTokensForCwd(ctx.cwd),
      state: runtime.state,
      autoCompactionEnabled,
    });

    if (!decision.inject) {
      if (decision.reason === "not_near_threshold") warningAlreadyInjected = false;
      return;
    }

    if (
      warningAlreadyInjected &&
      (autoCompactionEnabled || decision.tokens < decision.autoCompactThreshold)
    )
      return;

    warningAlreadyInjected = true;
    return {
      messages: appendTransientWarning(event.messages),
    };
  });
}
