import { describe, expect, test } from "bun:test";
import { normalizePullRequestSelector } from "./github";

describe("github helpers", () => {
  test("validates pull request selectors", () => {
    expect(normalizePullRequestSelector(" 123 ")).toBe("123");
    expect(normalizePullRequestSelector("owner/repo#123")).toBe(
      "https://github.com/owner/repo/pull/123",
    );
    expect(normalizePullRequestSelector("https://github.com/owner/repo/pull/123")).toBe(
      "https://github.com/owner/repo/pull/123",
    );
    expect(normalizePullRequestSelector(" ")).toBeUndefined();
    for (const value of ["-123", "@123", "123\n--json body", "owner/repo#abc", "123 lock"]) {
      expect(() => normalizePullRequestSelector(value)).toThrow("Invalid pull request selector");
    }
  });
});
