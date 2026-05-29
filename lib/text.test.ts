import { describe, expect, test } from "bun:test";
import { hasControlCharacter, hasWhitespaceOrControl, truncate } from "./text";

describe("text helpers", () => {
  test("returns input unchanged when within the limit", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  test("truncates with existing message", () => {
    expect(truncate("abcdef", 3)).toBe(
      "abc\n\n[diff truncated at 3 chars; inspect files directly before editing]",
    );
  });

  test("detects control characters", () => {
    expect(hasControlCharacter("plain")).toBe(false);
    expect(hasControlCharacter("with\nnewline")).toBe(true);
    expect(hasControlCharacter("with\x7fdelete")).toBe(true);
  });

  test("detects whitespace or control characters", () => {
    expect(hasWhitespaceOrControl("plain")).toBe(false);
    expect(hasWhitespaceOrControl("has space")).toBe(true);
    expect(hasWhitespaceOrControl("has\ttab")).toBe(true);
  });
});
