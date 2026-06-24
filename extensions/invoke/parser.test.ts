import { describe, expect, test } from "bun:test";
import { parseInvokeCommandArgs } from "./parser";

describe("parseInvokeCommandArgs", () => {
  test("requires an operation name", () => {
    expect(parseInvokeCommandArgs("")).toEqual({
      ok: false,
      reason: "missing_operation",
      message: "使い方: /invoke <operation> [JSON args]",
    });
    expect(parseInvokeCommandArgs("   ")).toMatchObject({ ok: false, reason: "missing_operation" });
  });

  test("parses an operation without args", () => {
    expect(parseInvokeCommandArgs("runtime.reload")).toEqual({
      ok: true,
      value: { operation: "runtime.reload" },
    });
    expect(parseInvokeCommandArgs("/runtime.reload")).toEqual({
      ok: true,
      value: { operation: "runtime.reload" },
    });
  });

  test("parses optional JSON args after the operation", () => {
    expect(
      parseInvokeCommandArgs(
        '  runtime.reload   {"continuationPrompt":"Resume work","stopAfterReload":true}',
      ),
    ).toEqual({
      ok: true,
      value: {
        operation: "runtime.reload",
        args: { continuationPrompt: "Resume work", stopAfterReload: true },
      },
    });
  });

  test("rejects invalid JSON args", () => {
    const result = parseInvokeCommandArgs("runtime.reload {bad");

    expect(result).toMatchObject({ ok: false, reason: "invalid_json" });
    if (result.ok) throw new Error("expected invalid JSON parse failure");
    expect(result.message).toContain("args は JSON として指定してください");
  });
});
