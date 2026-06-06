import type {
  AgentOptions,
  InteractionUpdate,
  ModelSelection,
  Run,
  SDKUserMessage,
  SendOptions,
} from "@cursor/sdk";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ThinkingContent,
} from "@earendil-works/pi-ai";
import {
  CURSOR_API_KEY_ENV,
  CURSOR_COMPOSER_MODEL_ID,
  CURSOR_SETTING_SOURCES,
} from "./constants.js";
import { buildCursorSdkMessage } from "./message.js";
import { withQuietCursorSdkStartup } from "./startup-output.js";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type MinimalCursorAgent = {
  close(): void;
  send(message: SDKUserMessage, options?: SendOptions): Promise<Run>;
};

type MinimalCursorAgentConstructor = {
  create(options: AgentOptions): Promise<MinimalCursorAgent>;
};

export type CursorSdkLoader = () => Promise<{ Agent: MinimalCursorAgentConstructor }>;

export const loadCursorSdk: CursorSdkLoader = async () => {
  const sdk = await import("@cursor/sdk");
  return { Agent: sdk.Agent };
};

export function cursorSdkModelSelection(modelId: string): ModelSelection {
  if (modelId === CURSOR_COMPOSER_MODEL_ID) return { id: "default" };
  return { id: modelId };
}

function createAssistantMessage(model: Model<Api>, signal?: AbortSignal): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: structuredClone(EMPTY_USAGE),
    stopReason: signal?.aborted ? "aborted" : "stop",
    timestamp: Date.now(),
  };
}

function appendTextDelta(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  state: { textIndex?: number },
  delta: string,
): void {
  if (!delta) return;
  if (state.textIndex === undefined) {
    output.content.push({ type: "text", text: "" });
    state.textIndex = output.content.length - 1;
    stream.push({ type: "text_start", contentIndex: state.textIndex, partial: output });
  }
  const block = output.content[state.textIndex];
  if (block.type !== "text") return;
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex: state.textIndex, delta, partial: output });
}

function appendThinkingDelta(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  state: { thinkingIndex?: number },
  delta: string,
): void {
  if (!delta) return;
  if (state.thinkingIndex === undefined) {
    output.content.push({ type: "thinking", thinking: "" });
    state.thinkingIndex = output.content.length - 1;
    stream.push({ type: "thinking_start", contentIndex: state.thinkingIndex, partial: output });
  }
  const block = output.content[state.thinkingIndex] as ThinkingContent;
  if (block.type !== "thinking") return;
  block.thinking += delta;
  stream.push({
    type: "thinking_delta",
    contentIndex: state.thinkingIndex,
    delta,
    partial: output,
  });
}

function closeOpenBlocks(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  state: { textIndex?: number; thinkingIndex?: number },
): void {
  if (state.thinkingIndex !== undefined) {
    const block = output.content[state.thinkingIndex] as ThinkingContent;
    stream.push({
      type: "thinking_end",
      contentIndex: state.thinkingIndex,
      content: block.type === "thinking" ? block.thinking : "",
      partial: output,
    });
    state.thinkingIndex = undefined;
  }
  if (state.textIndex !== undefined) {
    const block = output.content[state.textIndex];
    stream.push({
      type: "text_end",
      contentIndex: state.textIndex,
      content: block.type === "text" ? block.text : "",
      partial: output,
    });
    state.textIndex = undefined;
  }
}

function hasText(output: AssistantMessage): boolean {
  return output.content.some((block) => block.type === "text" && block.text.length > 0);
}

function createCursorAgentOptions(model: Model<Api>, apiKey: string): AgentOptions {
  return {
    apiKey,
    model: cursorSdkModelSelection(model.id),
    local: { cwd: process.cwd(), settingSources: CURSOR_SETTING_SOURCES },
    mode: "agent",
  };
}

export function createStreamCursorSdk(loader: CursorSdkLoader = loadCursorSdk) {
  return function streamCursorSdk(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const output = createAssistantMessage(model, options?.signal);
      const blockState: { textIndex?: number; thinkingIndex?: number } = {};
      let run: Run | undefined;
      let agentClosed = false;
      const safeCloseAgent = (agent: MinimalCursorAgent) => {
        if (agentClosed) return;
        agentClosed = true;
        try {
          agent.close();
        } catch {
          // Closing is best-effort cleanup. Preserve the original stream outcome.
        }
      };

      try {
        const apiKey = options?.apiKey || process.env[CURSOR_API_KEY_ENV];
        if (!apiKey) throw new Error("Cursor SDK requires CURSOR_API_KEY or pi API-key auth.");

        stream.push({ type: "start", partial: output });
        options?.signal?.throwIfAborted();

        const agent = await withQuietCursorSdkStartup(async () => {
          const { Agent: CursorAgent } = await loader();
          return CursorAgent.create(createCursorAgentOptions(model, apiKey));
        });

        const onAbort = () => {
          run?.cancel().catch(() => {});
          safeCloseAgent(agent);
        };
        options?.signal?.addEventListener("abort", onAbort, { once: true });

        try {
          run = await agent.send(buildCursorSdkMessage(context), {
            mode: "agent",
            model: cursorSdkModelSelection(model.id),
            onDelta: ({ update }: { update: InteractionUpdate }) => {
              if (update.type === "text-delta") {
                appendTextDelta(stream, output, blockState, update.text);
                return;
              }
              if (update.type === "thinking-delta") {
                appendThinkingDelta(stream, output, blockState, update.text);
              }
            },
          });

          if (options?.signal?.aborted) throw new Error("Cursor SDK run aborted");
          const result = await run.wait();
          if (options?.signal?.aborted) throw new Error("Cursor SDK run aborted");
          if (!hasText(output) && result.result) {
            appendTextDelta(stream, output, blockState, result.result);
          }

          closeOpenBlocks(stream, output, blockState);
          if (result.status === "cancelled") {
            output.stopReason = "aborted";
            stream.push({ type: "error", reason: "aborted", error: output });
          } else if (result.status === "error") {
            output.stopReason = "error";
            output.errorMessage = result.result || "Cursor SDK run failed.";
            stream.push({ type: "error", reason: "error", error: output });
          } else {
            stream.push({ type: "done", reason: "stop", message: output });
          }
        } finally {
          options?.signal?.removeEventListener("abort", onAbort);
          safeCloseAgent(agent);
        }
      } catch (error) {
        closeOpenBlocks(stream, output, blockState);
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } finally {
        stream.end();
      }
    })();

    return stream;
  };
}

export const streamCursorSdk = createStreamCursorSdk();
