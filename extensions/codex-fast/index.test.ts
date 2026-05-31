import { describe, expect, test } from "bun:test";

import { CODEX_FAST_STATUS_KEY, CODEX_FAST_STATUS_ON } from "../../lib/codex-fast";
import { createFakePi as createSharedFakePi } from "../../tests/support/fake-pi";
import codexFastExtension, { applyCodexFastServiceTier } from "./index";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: FakeContext) => Promise<void> | void;
};

type FakeContext = {
  hasUI: boolean;
  model?: unknown;
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
    setStatus: (key: string, value: string | undefined) => void;
  };
};

function createFakePi() {
  return createSharedFakePi<never, CommandDefinition>();
}

function createContext(
  model: unknown = { provider: "openai-codex", api: "openai-codex-responses" },
) {
  const notifications: Array<{ message: string; level: "info" | "warning" | "error" }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx: FakeContext = {
    hasUI: true,
    model,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.set(key, value);
      },
    },
  };

  return { ctx, notifications, statuses };
}

describe("codex-fast extension", () => {
  test("registers /codex-fast and a provider payload hook", () => {
    const pi = createFakePi();

    codexFastExtension(pi as never);

    expect(pi.getCommand("codex-fast")?.description).toContain("Codex");
    expect(pi.getEventHandlers("before_provider_request")).toHaveLength(1);
  });

  test("/codex-fast enables fast service tier for openai-codex requests", async () => {
    const pi = createFakePi();
    codexFastExtension(pi as never);

    const { ctx, notifications, statuses } = createContext();
    await pi.getCommand("codex-fast")!.handler("", ctx);

    const payload = { model: "gpt-5.5", stream: true };
    const result = pi.getEventHandlers("before_provider_request")[0]!({ payload }, ctx);

    expect(result).toEqual({ model: "gpt-5.5", stream: true, service_tier: "priority" });
    expect(payload).toEqual({ model: "gpt-5.5", stream: true });
    expect(notifications).toEqual([
      { message: "Codex fast mode を有効化しました。", level: "info" },
    ]);
    expect(statuses.get(CODEX_FAST_STATUS_KEY)).toBe(CODEX_FAST_STATUS_ON);
  });

  test("/codex-fast off disables service tier injection", async () => {
    const pi = createFakePi();
    codexFastExtension(pi as never);

    const { ctx, statuses } = createContext();
    await pi.getCommand("codex-fast")!.handler("on", ctx);
    await pi.getCommand("codex-fast")!.handler("off", ctx);

    const result = pi.getEventHandlers("before_provider_request")[0]!(
      { payload: { model: "gpt-5.5" } },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(statuses.get(CODEX_FAST_STATUS_KEY)).toBeUndefined();
  });

  test("status reports the current setting without changing it", async () => {
    const pi = createFakePi();
    codexFastExtension(pi as never);

    const { ctx, notifications } = createContext();
    await pi.getCommand("codex-fast")!.handler("status", ctx);
    const disabledResult = pi.getEventHandlers("before_provider_request")[0]!(
      { payload: { model: "gpt-5.5" } },
      ctx,
    );

    await pi.getCommand("codex-fast")!.handler("on", ctx);
    await pi.getCommand("codex-fast")!.handler("status", ctx);
    const enabledResult = pi.getEventHandlers("before_provider_request")[0]!(
      { payload: { model: "gpt-5.5" } },
      ctx,
    );

    expect(disabledResult).toBeUndefined();
    expect(enabledResult).toEqual({ model: "gpt-5.5", service_tier: "priority" });
    expect(notifications).toEqual([
      { message: "Codex fast mode は無効です。", level: "info" },
      { message: "Codex fast mode を有効化しました。", level: "info" },
      { message: "Codex fast mode は有効です。", level: "info" },
    ]);
  });

  test("does not change non-Codex models or non-object payloads", () => {
    expect(
      applyCodexFastServiceTier(
        { model: "claude-sonnet-4-6" },
        { provider: "anthropic", api: "anthropic-messages" },
        true,
      ),
    ).toBeUndefined();
    expect(
      applyCodexFastServiceTier("payload", { provider: "openai-codex" }, true),
    ).toBeUndefined();
    expect(
      applyCodexFastServiceTier({ model: "gpt-5.5" }, { provider: "openai-codex" }, false),
    ).toBeUndefined();
  });

  test("rejects unknown arguments", async () => {
    const pi = createFakePi();
    codexFastExtension(pi as never);

    const { ctx, notifications } = createContext();
    await pi.getCommand("codex-fast")!.handler("maybe", ctx);

    expect(notifications).toEqual([
      { message: "使い方: /codex-fast [on|off|toggle|status]", level: "error" },
    ]);
  });
});
