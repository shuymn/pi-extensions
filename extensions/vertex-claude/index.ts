import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  ToolUnion,
} from "@anthropic-ai/sdk/resources/messages";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_LOCATION = "global";
const DEFAULT_ADC_PATH = join(
  homedir(),
  ".config",
  "gcloud",
  "application_default_credentials.json",
);

type ProjectEnvVar = "GOOGLE_CLOUD_PROJECT" | "GCLOUD_PROJECT" | "ANTHROPIC_VERTEX_PROJECT_ID";

type VertexModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

export const VERTEX_CLAUDE_MODELS: VertexModel[] = [
  {
    id: "claude-sonnet-4-6",
    name: "Sonnet 4.6 (Vertex)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: "claude-sonnet-4-6:1m",
    name: "Sonnet 4.6 1M (Vertex)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
];

export function resolveVertexBaseUrl(location: string): string {
  if (location === "global") return "https://aiplatform.googleapis.com/v1";
  if (location === "us") return "https://aiplatform.us.rep.googleapis.com/v1";
  if (location === "eu") return "https://aiplatform.eu.rep.googleapis.com/v1";
  return `https://${location}-aiplatform.googleapis.com/v1`;
}

export function resolveVertexModelRequest(modelId: string): {
  modelId: string;
  betaFeatures: string[];
} {
  if (!modelId.endsWith(":1m")) return { modelId, betaFeatures: [] };
  return {
    modelId: modelId.slice(0, -":1m".length),
    betaFeatures: ["context-1m-2025-08-07"],
  };
}

function resolveProjectId(): { id: string; envVar: ProjectEnvVar } | undefined {
  for (const envVar of [
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ] as const) {
    const value = process.env[envVar];
    if (value) return { id: value, envVar };
  }
}

function hasAdcCredentials(): boolean {
  return existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS || DEFAULT_ADC_PATH);
}

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertContentBlocks(content: (TextContent | ImageContent)[]) {
  const hasImages = content.some((item) => item.type === "image");
  if (!hasImages)
    return sanitizeSurrogates(content.map((item) => (item as TextContent).text).join("\n"));
  return content.map((item) =>
    item.type === "text"
      ? { type: "text" as const, text: sanitizeSurrogates(item.text) }
      : {
          type: "image" as const,
          source: { type: "base64" as const, media_type: item.mimeType, data: item.data },
        },
  );
}

export function convertMessages(
  messages: Message[],
  model: Model<Api>,
): MessageCreateParamsStreaming["messages"] {
  const params: MessageCreateParamsStreaming["messages"] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      if (typeof message.content === "string") {
        if (message.content.trim())
          params.push({ role: "user", content: sanitizeSurrogates(message.content) });
      } else {
        const blocks = message.content
          .map((item): ContentBlockParam | undefined => {
            if (item.type === "text")
              return item.text.trim()
                ? { type: "text", text: sanitizeSurrogates(item.text) }
                : undefined;
            if (!model.input.includes("image")) return undefined;
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: item.mimeType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: item.data,
              },
            };
          })
          .filter((item): item is ContentBlockParam => item !== undefined);
        if (blocks.length > 0) params.push({ role: "user", content: blocks });
      }
    } else if (message.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim())
          blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
        if (block.type === "thinking" && block.thinking.trim()) {
          blocks.push(
            (block as ThinkingContent).thinkingSignature?.trim()
              ? ({
                  type: "thinking",
                  thinking: sanitizeSurrogates(block.thinking),
                  signature: (block as ThinkingContent).thinkingSignature,
                } as ContentBlockParam)
              : { type: "text", text: sanitizeSurrogates(block.thinking) },
          );
        }
        if (block.type === "toolCall")
          blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
      }
      if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
    } else if (message.role === "toolResult") {
      const toolResults = [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: convertContentBlocks(message.content),
          is_error: message.isError,
        },
      ];
      let nextIndex = index + 1;
      while (nextIndex < messages.length && messages[nextIndex].role === "toolResult") {
        const next = messages[nextIndex] as ToolResultMessage;
        toolResults.push({
          type: "tool_result",
          tool_use_id: next.toolCallId,
          content: convertContentBlocks(next.content),
          is_error: next.isError,
        });
        nextIndex += 1;
      }
      index = nextIndex - 1;
      params.push({ role: "user", content: toolResults as ContentBlockParam[] });
    }
  }
  return params;
}

type ToolParameters = {
  properties?: Record<string, unknown>;
  required?: string[];
};

function convertTools(tools: Tool[]): ToolUnion[] {
  return tools.map((tool) => {
    const parameters = tool.parameters as ToolParameters;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object" as const,
        properties: parameters.properties || {},
        required: parameters.required || [],
      },
    };
  });
}

function mapStopReason(reason: string): StopReason {
  if (["end_turn", "pause_turn", "stop_sequence"].includes(reason)) return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "toolUse";
  return "error";
}

function parseCompleteJson(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  return JSON.parse(json);
}

export function streamVertexClaude(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const projectInfo = resolveProjectId();
      const location =
        process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION || DEFAULT_LOCATION;
      if (!projectInfo)
        throw new Error(
          "Vertex AI requires GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or ANTHROPIC_VERTEX_PROJECT_ID.",
        );
      if (!hasAdcCredentials())
        throw new Error(
          "Vertex AI requires Application Default Credentials. Run: gcloud auth application-default login",
        );

      const modelRequest = resolveVertexModelRequest(model.id);
      const betaFeatures = [
        "fine-grained-tool-streaming-2025-05-14",
        "interleaved-thinking-2025-05-14",
        ...modelRequest.betaFeatures,
      ];
      const client = new AnthropicVertex({
        projectId: projectInfo.id,
        region: location,
        baseURL: resolveVertexBaseUrl(location),
        defaultHeaders: {
          "anthropic-beta": betaFeatures.join(","),
        },
      });

      const params: MessageCreateParamsStreaming = {
        model: modelRequest.modelId,
        messages: convertMessages(context.messages, model),
        max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
        stream: true,
      };
      if (context.systemPrompt)
        params.system = [
          {
            type: "text",
            text: sanitizeSurrogates(context.systemPrompt),
            cache_control: { type: "ephemeral" },
          },
        ];
      if (options?.temperature !== undefined) params.temperature = options.temperature;
      if (context.tools?.length) params.tools = convertTools(context.tools);
      if (options?.reasoning && model.reasoning) {
        const budgets = { minimal: 1024, low: 4096, medium: 10_240, high: 20_480, xhigh: 32_768 };
        const thinkingBudget = budgets[options.reasoning] ?? budgets.medium;
        if (params.max_tokens <= thinkingBudget) params.max_tokens = thinkingBudget + 1024;
        params.thinking = { type: "enabled", budget_tokens: thinkingBudget };
      }

      const anthropicStream = client.messages.stream(params, { signal: options?.signal });
      stream.push({ type: "start", partial: output });
      type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
        index: number;
      };
      const blocks = output.content as Block[];

      for await (const event of anthropicStream) {
        if (event.type === "message_start") {
          output.usage.input = event.message.usage.input_tokens || 0;
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            const block: Block = { type: "text", text: "", index: event.index };
            output.content.push(block);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "thinking") {
            const block: Block = {
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block.type === "tool_use") {
            const block: Block = {
              type: "toolCall",
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: event.content_block.input as Record<string, unknown>,
              partialJson: "",
              index: event.index,
            };
            output.content.push(block);
            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          const contentIndex = blocks.findIndex((block) => block.index === event.index);
          const block = blocks[contentIndex];
          if (!block) continue;
          if (event.delta.type === "text_delta" && block.type === "text") {
            block.text += event.delta.text;
            stream.push({
              type: "text_delta",
              contentIndex,
              delta: event.delta.text,
              partial: output,
            });
          } else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += event.delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex,
              delta: event.delta.thinking,
              partial: output,
            });
          } else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
            block.partialJson += event.delta.partial_json;
            stream.push({
              type: "toolcall_delta",
              contentIndex,
              delta: event.delta.partial_json,
              partial: output,
            });
          } else if (event.delta.type === "signature_delta" && block.type === "thinking") {
            const delta = event.delta as { signature?: string };
            block.thinkingSignature = `${block.thinkingSignature || ""}${delta.signature || ""}`;
          }
        } else if (event.type === "content_block_stop") {
          const contentIndex = blocks.findIndex((block) => block.index === event.index);
          const block = blocks[contentIndex];
          if (!block) continue;
          delete (block as Partial<Block>).index;
          if (block.type === "text")
            stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
          if (block.type === "thinking")
            stream.push({
              type: "thinking_end",
              contentIndex,
              content: block.thinking,
              partial: output,
            });
          if (block.type === "toolCall") {
            block.arguments = parseCompleteJson(block.partialJson);
            delete (block as Partial<typeof block>).partialJson;
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
          }
        } else if (event.type === "message_delta") {
          const delta = event.delta as { stop_reason?: string };
          const usage = event.usage as {
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
          if (delta.stop_reason) output.stopReason = mapStopReason(delta.stop_reason);
          output.usage.output = usage.output_tokens ?? output.usage.output;
          output.usage.cacheRead = usage.cache_read_input_tokens ?? output.usage.cacheRead;
          output.usage.cacheWrite = usage.cache_creation_input_tokens ?? output.usage.cacheWrite;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
      }
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      for (const block of output.content) delete (block as { index?: number }).index;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  const location =
    process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION || DEFAULT_LOCATION;
  pi.registerProvider("google-vertex-claude", {
    name: "Google Vertex Claude",
    baseUrl: resolveVertexBaseUrl(location),
    apiKey: "GOOGLE_CLOUD_PROJECT",
    api: "vertex-claude-api",
    models: VERTEX_CLAUDE_MODELS,
    streamSimple: streamVertexClaude,
  });
}
