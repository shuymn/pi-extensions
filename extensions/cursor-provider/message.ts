import type { SDKUserMessage } from "@cursor/sdk";
import type { Context, ImageContent, TextContent } from "@earendil-works/pi-ai";

function contentToText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      return "[image omitted from transcript]";
    })
    .join("\n");
}

export function serializeCursorContext(context: Context): string {
  const parts: string[] = [];
  if (context.systemPrompt?.trim()) parts.push(`[System]\n${context.systemPrompt}`);

  for (const message of context.messages) {
    if (message.role === "user") {
      parts.push(`[User]\n${contentToText(message.content)}`);
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) parts.push(`[Assistant]\n${text}`);
      continue;
    }

    if (message.role === "toolResult") {
      const text = contentToText(message.content);
      const label = message.isError ? "Tool error" : "Tool result";
      parts.push(`[${label}: ${message.toolName}]\n${text.trim() ? text : "[no output]"}`);
    }
  }

  return parts.join("\n\n");
}

function latestUserImages(context: Context): SDKUserMessage["images"] {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message.role !== "user" || typeof message.content === "string") continue;
    const images = message.content
      .filter((block): block is ImageContent => block.type === "image")
      .map((block) => ({ data: block.data, mimeType: block.mimeType }));
    return images.length > 0 ? images : undefined;
  }
}

export function buildCursorSdkMessage(context: Context): SDKUserMessage {
  return {
    text: serializeCursorContext(context),
    images: latestUserImages(context),
  };
}
