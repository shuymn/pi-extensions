import { describe, expect, test } from "bun:test";

import { getLatestAssistantMessageText, latestAssistantWasAborted } from "./session-messages";

describe("session message helpers", () => {
  test("returns string content from the latest assistant message", () => {
    expect(
      getLatestAssistantMessageText([
        { role: "assistant", content: "old" },
        { role: "user", content: "question" },
        { role: "assistant", content: "latest" },
      ]),
    ).toBe("latest");
  });

  test("joins array text parts with newlines", () => {
    expect(
      getLatestAssistantMessageText({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "first" },
              { type: "image", text: "ignored" },
              { type: "text", text: "second" },
            ],
          },
        ],
      }),
    ).toBe("first\nsecond");
  });

  test("finds assistant messages in nested objects using reverse traversal", () => {
    expect(
      getLatestAssistantMessageText({
        earlier: [{ role: "assistant", content: "earlier" }],
        later: {
          items: [{ role: "assistant", content: [{ type: "text", text: "later" }] }],
        },
      }),
    ).toBe("later");
  });

  test("returns undefined when no assistant text is present", () => {
    expect(
      getLatestAssistantMessageText([
        { role: "user", content: "question" },
        {
          role: "assistant",
          content: [{ type: "tool-result", text: "ignored" }],
        },
      ]),
    ).toBeUndefined();
  });

  test("falls back past textless assistant messages when extracting text", () => {
    expect(
      getLatestAssistantMessageText([
        { role: "assistant", content: "older text" },
        { role: "assistant", content: [{ type: "tool-result", text: "ignored" }] },
        { role: "assistant", content: [] },
      ]),
    ).toBe("older text");
  });

  test("returns undefined for invalid or broken inputs", () => {
    const broken = {};
    Object.defineProperty(broken, "boom", {
      enumerable: true,
      get() {
        throw new Error("broken getter");
      },
    });

    expect(getLatestAssistantMessageText(undefined)).toBeUndefined();
    expect(getLatestAssistantMessageText("assistant text")).toBeUndefined();
    expect(getLatestAssistantMessageText(broken)).toBeUndefined();
  });

  test("detects whether the latest assistant message was aborted", () => {
    expect(
      latestAssistantWasAborted([
        { role: "assistant", content: "old", stopReason: "aborted" },
        { role: "assistant", content: "latest", stopReason: "end_turn" },
      ]),
    ).toBe(false);

    expect(
      latestAssistantWasAborted({
        messages: [
          { role: "assistant", content: "old", stopReason: "end_turn" },
          { role: "assistant", content: [], stopReason: "aborted" },
        ],
      }),
    ).toBe(true);

    expect(latestAssistantWasAborted(undefined)).toBe(false);
  });
});
