import { describe, expect, test } from "bun:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { withTimeout } from "../../tests/support/async";
import { createFakePi } from "../../tests/support/fake-pi";
import extension, {
  buildCursorSdkMessage,
  CURSOR_API,
  CURSOR_API_KEY_ENV,
  CURSOR_COMPOSER_MODEL_ID,
  CURSOR_DISPLAY_NAME,
  CURSOR_MODELS,
  CURSOR_PROVIDER_ID,
  CURSOR_SDK_BASE_URL,
  createStreamCursorSdk,
  cursorSdkModelSelection,
  isCursorSdkStartupNoise,
  serializeCursorContext,
} from "./index";

function fakeModel(): Model<Api> {
  return {
    ...CURSOR_MODELS[0],
    api: CURSOR_API,
    provider: CURSOR_PROVIDER_ID,
    baseUrl: CURSOR_SDK_BASE_URL,
  } as Model<Api>;
}

function createFinishedRun(result: string) {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "finished",
    supports: () => true,
    unsupportedReason: () => undefined,
    stream: async function* () {},
    conversation: async () => [],
    wait: async () => ({
      id: "run-1",
      status: "finished" as const,
      result,
    }),
    cancel: async () => {},
    onDidChangeStatus: () => () => {},
  };
}

async function collectStream(stream: ReturnType<ReturnType<typeof createStreamCursorSdk>>) {
  const events: unknown[] = [];
  await withTimeout(
    (async () => {
      for await (const event of stream) events.push(event);
    })(),
    "cursor-provider stream did not end",
  );
  return events;
}

describe("cursor-provider extension", () => {
  test("registers a minimal Cursor SDK provider for Composer 2.5", () => {
    const pi = createFakePi();

    extension(pi as never);

    const provider = pi.providers.get(CURSOR_PROVIDER_ID);
    expect(provider).toBeDefined();
    expect(provider?.name).toBe(CURSOR_DISPLAY_NAME);
    expect(provider?.baseUrl).toBe(CURSOR_SDK_BASE_URL);
    expect(provider?.apiKey).toBe(`$${CURSOR_API_KEY_ENV}`);
    expect(provider?.api).toBe(CURSOR_API);
    expect(provider?.streamSimple).toBeFunction();
    expect(provider?.models).toEqual(CURSOR_MODELS);

    expect(CURSOR_MODELS).toEqual([
      {
        id: CURSOR_COMPOSER_MODEL_ID,
        name: "Composer 2.5",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 32_768,
      },
    ]);
  });

  test("serializes Pi context into a plain Cursor SDK prompt", () => {
    const prompt = serializeCursorContext({
      systemPrompt: "Follow project instructions.",
      messages: [
        { role: "user", content: "First request", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Previous answer" },
            { type: "thinking", thinking: "hidden" },
          ],
          api: "test-api",
          provider: "test-provider",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", mimeType: "image/png", data: "abcd" },
          ],
          timestamp: 2,
        },
      ],
    });

    expect(prompt).toBe(
      [
        "[System]\nFollow project instructions.",
        "[User]\nFirst request",
        "[Assistant]\nPrevious answer",
        "[User]\nLook at this\n[image omitted from transcript]",
      ].join("\n\n"),
    );
  });

  test("serializes tool results with error and empty-output markers", () => {
    const prompt = serializeCursorContext({
      messages: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "bash",
          content: [{ type: "text", text: "" }],
          isError: true,
          timestamp: 2,
        },
      ],
    });

    expect(prompt).toBe(
      ["[Tool result: read]\nfile contents", "[Tool error: bash]\n[no output]"].join("\n\n"),
    );
  });

  test("forwards latest user images through the Cursor SDK message", () => {
    const context: Context = {
      messages: [
        { role: "user", content: "no image", timestamp: 1 },
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this" },
            { type: "image", mimeType: "image/png", data: "abcd" },
          ],
          timestamp: 2,
        },
      ],
    };

    expect(buildCursorSdkMessage(context)).toEqual({
      text: "[User]\nno image\n\n[User]\nLook at this\n[image omitted from transcript]",
      images: [{ data: "abcd", mimeType: "image/png" }],
    });
  });

  test("maps public Composer 2.5 model id to the Cursor SDK default model selector", () => {
    expect(cursorSdkModelSelection(CURSOR_COMPOSER_MODEL_ID)).toEqual({ id: "default" });
    expect(cursorSdkModelSelection("custom-model")).toEqual({ id: "custom-model" });
  });

  test("streams Cursor SDK text deltas", async () => {
    const seenCreate: unknown[] = [];
    const seenSend: unknown[] = [];
    const seenSendOptions: unknown[] = [];
    let closed = false;
    const streamCursorSdk = createStreamCursorSdk((async () => ({
      Agent: {
        create: async (options: unknown) => {
          seenCreate.push(options);
          return {
            close: () => {
              closed = true;
            },
            send: async (message: unknown, options: { onDelta?: (args: unknown) => void }) => {
              seenSend.push(message);
              seenSendOptions.push(options);
              options.onDelta?.({ update: { type: "text-delta", text: "Hello" } });
              options.onDelta?.({ update: { type: "text-delta", text: " world" } });
              return createFinishedRun("Hello world");
            },
          };
        },
      },
    })) as never);

    const events = await collectStream(
      streamCursorSdk(
        fakeModel(),
        { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] },
        { apiKey: "key" },
      ),
    );

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(seenCreate).toEqual([
      {
        apiKey: "key",
        model: { id: "default" },
        local: { cwd: process.cwd(), settingSources: [] },
        mode: "agent",
      },
    ]);
    expect(seenSend).toEqual([{ text: "[User]\nSay hi", images: undefined }]);
    expect(seenSendOptions).toEqual([
      expect.objectContaining({ mode: "agent", model: { id: "default" } }),
    ]);
    expect(closed).toBe(true);
  });

  test("filters only known Cursor SDK startup noise without muting other output", async () => {
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalConsoleLog = console.log;
    const originalConsoleWarn = console.warn;
    const output: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
      output.push(`stdout:${String(chunk)}`);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, ..._args: unknown[]) => {
      output.push(`stderr:${String(chunk)}`);
      return true;
    }) as typeof process.stderr.write;
    console.log = (...args: unknown[]) => {
      output.push(`log:${args.join(" ")}`);
    };
    console.warn = (...args: unknown[]) => {
      output.push(`warn:${args.join(" ")}`);
    };

    try {
      const streamCursorSdk = createStreamCursorSdk((async () => {
        console.log("[hooks] Cursor startup noise");
        process.stdout.write("visible tui redraw");
        return {
          Agent: {
            create: async () => {
              process.stdout.write("managed_skills.cursor noise");
              process.stderr.write(
                "Ripgrep path not configured. Call configureRipgrepPath() at startup.",
              );
              console.warn("CursorPluginsAgentSkillsService load completed");
              console.log("visible submitted prompt");
              return {
                close: () => {},
                send: async (_message: unknown, options: { onDelta?: (args: unknown) => void }) => {
                  console.warn("send warning");
                  options.onDelta?.({ update: { type: "text-delta", text: "ok" } });
                  return createFinishedRun("ok");
                },
              };
            },
          },
        };
      }) as never);

      await collectStream(
        streamCursorSdk(
          fakeModel(),
          { messages: [{ role: "user", content: "Say hi", timestamp: 1 }] },
          { apiKey: "key" },
        ),
      );

      expect(output).toEqual([
        "stdout:visible tui redraw",
        "log:visible submitted prompt",
        "warn:send warning",
      ]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.log = originalConsoleLog;
      console.warn = originalConsoleWarn;
    }
  });

  test("classifies Cursor SDK startup noise narrowly", () => {
    expect(isCursorSdkStartupNoise("[hooks] loaded")).toBe(true);
    expect(isCursorSdkStartupNoise("visible submitted prompt")).toBe(false);
  });
});
