import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  OPENAI_FAST_ICON,
  OPENAI_FAST_STATUS_KEY,
  OPENAI_FAST_STATUS_ON,
} from "../../lib/openai-fast";
import { createFakePi, type ExecCall, type ExecResult } from "../../tests/support/fake-pi";
import statuslineExtension from "./index";

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type Footer = ReturnType<FooterFactory>;

function setup(
  options: {
    hasUI?: boolean;
    mode?: ExtensionContext["mode"];
    cwd?: string;
    model?: unknown;
    models?: unknown[];
    usage?: ContextUsage;
    branch?: string;
    thinkingLevel?: string;
    exec?: (call: ExecCall) => ExecResult | Promise<ExecResult>;
  } = {},
) {
  const pi = createFakePi({
    exec: options.exec ?? (() => ({ code: 0, stdout: "/work/my-project\n", stderr: "" })),
    thinkingLevel: options.thinkingLevel,
  });
  statuslineExtension(pi as never);
  let footer: Footer | undefined;
  let branch = options.branch;
  const statuses = new Map<string, string>();
  const listeners = new Set<() => void>();
  const unsubscribe = mock((listener: () => void) => listeners.delete(listener));
  const requestRender = mock(() => {});
  const setFooter = mock((factory: FooterFactory | undefined) => {
    footer?.dispose?.();
    footer = factory?.(
      { requestRender } as unknown as Parameters<FooterFactory>[0],
      {} as Parameters<FooterFactory>[1],
      {
        getGitBranch: () => branch ?? null,
        getExtensionStatuses: () => statuses,
        getAvailableProviderCount: () => 1,
        onBranchChange(listener) {
          listeners.add(listener);
          return () => {
            unsubscribe(listener);
          };
        },
      },
    );
  });
  const model = Object.hasOwn(options, "model")
    ? options.model
    : { name: "claude", provider: "anthropic", contextWindow: 100_000 };
  const ctx = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    cwd: options.cwd ?? "/fallback/project",
    model,
    modelRegistry: { getAvailable: () => options.models ?? [model] },
    getContextUsage: () => options.usage,
    isIdle: () => true,
    ui: { setFooter },
  };
  return {
    pi,
    ctx,
    statuses,
    requestRender,
    unsubscribe,
    listeners,
    get footer() {
      return footer;
    },
    async emit(event: string) {
      for (const handler of pi.getEventHandlers(event)) await handler({}, ctx);
    },
    text(width = 500) {
      if (!footer) throw new Error("No custom footer installed");
      return Bun.stripANSI(footer.render(width)[0]);
    },
    setBranch(value: string) {
      branch = value;
      for (const listener of listeners) listener();
    },
  };
}

function at(hours: number, minutes = 0, seconds = 0) {
  setSystemTime(new Date(2026, 0, 1, hours, minutes, seconds));
}

describe("statusline custom footer", () => {
  beforeEach(() => at(12));
  afterEach(() => setSystemTime());

  test("When started, the footer shall restore project, branch, model, thinking and context display", async () => {
    const f = setup({
      model: { name: "sonnet", provider: "anthropic", contextWindow: 100_000 },
      models: [
        { name: "sonnet", provider: "anthropic" },
        { name: "sonnet", provider: "openrouter" },
      ],
      thinkingLevel: "high",
      branch: "feature/statusline",
      usage: { tokens: 25_000, contextWindow: 100_000, percent: 25 },
    });
    await f.emit("session_start");
    expect(f.text()).toBe(
      "12:00:00 | my-project on  feature/statusline via anthropic/sonnet・high | ctx ● 25%",
    );
    expect(f.footer!.render(500)[0]).toContain("\x1b[38;2;80;220;255m");
    expect(f.pi.execCalls).toEqual([
      {
        command: "git",
        args: ["rev-parse", "--show-toplevel"],
        options: { timeout: 1000 },
      },
    ]);
  });

  test.each([
    "git-root",
    "cwd",
  ])("When external footer fields contain controls, the footer shall keep one physical line and only its own styling: %s", async (source) => {
    const name = "bad\nmodel\x1b[1m";
    const project = "my\nproject\x1b]0;injected title\x07";
    const f = setup({
      cwd: `/work/${project}`,
      exec: () => ({
        code: source === "git-root" ? 0 : 1,
        stdout: `/work/${project}\n`,
        stderr: "",
      }),
      branch: "feature\tbad\x1b[2J\u0085branch",
      model: { name, provider: "test\rprovider\x1b]8;;https://example.invalid\x1b\\" },
      models: [{ name }, { name }],
    });
    await f.emit("session_start");
    const lines = f.footer!.render(500);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    const plain = line
      .replaceAll("\x1b[38;2;255;200;60m", "")
      .replaceAll("\x1b[38;2;80;220;255m", "")
      .replaceAll("\x1b[38;2;220;120;255m", "")
      .replaceAll("\x1b[38;2;255;80;80m", "")
      .replaceAll("\x1b[0m", "");
    expect(plain).toBe(
      "12:00:00 | my project on  feature bad branch via test provider/bad model・medium",
    );
    expect(line).toContain("\x1b[38;2;80;220;255m");
    expect(visibleWidth(line)).toBeLessThanOrEqual(500);
    f.setBranch("new\nbranch\x1b[2J");
    expect(f.text()).toContain(" on  new branch via ");
    expect(stripTerminalSequences(f.footer!.render(24)[0]!)).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
  });

  test.each([
    { model: { name: "gpt", provider: "openai", api: "openai-responses" }, indicator: true },
    {
      model: { name: "gpt", provider: "openai-codex", api: "openai-codex-responses" },
      indicator: false,
    },
    { model: { name: "gpt", provider: "custom", api: "openai-responses" }, indicator: false },
    { model: { name: "gpt", provider: "openai", api: "openai-completions" }, indicator: false },
    { model: { name: "claude", provider: "anthropic" }, indicator: false },
  ])("When OpenAI fast is enabled, its icon shall be limited to OpenAI Responses models: %j", async ({
    model,
    indicator,
  }) => {
    const f = setup({ model });
    await f.emit("session_start");
    expect(f.text()).not.toContain(OPENAI_FAST_ICON);
    f.statuses.set(OPENAI_FAST_STATUS_KEY, OPENAI_FAST_STATUS_ON);
    expect(f.text().includes(OPENAI_FAST_ICON)).toBe(indicator);
    f.statuses.delete(OPENAI_FAST_STATUS_KEY);
    expect(f.text()).not.toContain(OPENAI_FAST_ICON);
  });

  test.each([
    [{ displayName: "Display Model" }, "Display Model"],
    [{ id: "model-id" }, "model-id"],
    [{}, "model"],
    [undefined, "no model"],
  ])("When a name is unavailable, the footer shall preserve fallback labels: %j", async (model, name) => {
    const f = setup({ model });
    await f.emit("session_start");
    expect(f.text()).toContain(`via ${name}・medium`);
    expect(f.text()).not.toContain(" on ");
  });

  test.each([
    "nonzero",
    "empty",
    "throw",
  ])("When Git root lookup returns %s, the footer shall use cwd", async (result) => {
    const f = setup({
      cwd: "/Users/me/project/",
      exec: () => {
        if (result === "throw") throw new Error("Git unavailable");
        return { code: result === "nonzero" ? 1 : 0, stdout: "", stderr: "" };
      },
    });
    await f.emit("session_start");
    expect(f.text()).toContain(" | project via claude・medium");
  });

  test("When a virtual model has different limits, context usage shall use Pi's effective-model percentage", async () => {
    const f = setup({
      model: { name: "Fallback", provider: "fallback", contextWindow: 1_000_000 },
      usage: { tokens: 25_000, contextWindow: 100_000, percent: 25 },
    });
    await f.emit("session_start");
    expect(f.text()).toContain("ctx ● 25%");
    expect(f.text()).not.toContain("ctx ● 3%");
  });

  test("When native compaction leaves usage unknown, the footer shall omit it until known", async () => {
    const f = setup({ usage: { tokens: null, contextWindow: 100_000, percent: null } });
    await f.emit("session_start");
    expect(f.text()).not.toContain("ctx ●");
    f.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 100_000, percent: 0 });
    expect(f.text()).toContain("ctx ● 0%");
    f.ctx.getContextUsage = () => undefined;
    expect(f.text()).not.toContain("ctx ●");
  });

  test.each([
    0, 1, 8, 24, 80,
  ])("When terminal width is %i, ANSI and wide characters shall remain within it", async (width) => {
    const f = setup({
      exec: () => ({ code: 0, stdout: "/仕事/長いプロジェクト🚀", stderr: "" }),
      branch: "feature/日本語",
      model: { name: "長いモデル名é", provider: "test" },
    });
    await f.emit("session_start");
    for (const line of f.footer!.render(width))
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  test("When turns finish, duration shall reset per turn and ready time shall update only when idle", async () => {
    const f = setup();
    await f.emit("session_start");
    at(12, 0, 5);
    await f.emit("turn_start");
    at(12, 1, 7);
    await f.emit("turn_end");
    expect(f.text()).toContain("took 1m2s");
    expect(f.text()).toStartWith("12:00:00");
    f.ctx.isIdle = () => false;
    at(12, 1, 10);
    const renders = f.requestRender.mock.calls.length;
    await f.emit("agent_settled");
    expect(f.requestRender).toHaveBeenCalledTimes(renders);
    expect(f.text()).toStartWith("12:00:00");
    f.ctx.isIdle = () => true;
    await f.emit("agent_settled");
    expect(f.text()).toStartWith("12:01:10");
    await f.emit("turn_start");
    expect(f.text()).not.toContain("took");
    at(12, 1, 13);
    await f.emit("turn_end");
    expect(f.text()).toContain("took 3s");
  });

  test("When a turn exceeds one hour, duration shall keep hours and minutes", async () => {
    const f = setup();
    await f.emit("session_start");
    await f.emit("turn_start");
    at(13, 2, 3);
    await f.emit("turn_end");
    expect(f.text()).toContain("took 1h2m3s");
  });

  test("When the session restarts, ready time and duration shall reset and the old footer shall be disposed", async () => {
    const f = setup();
    await f.emit("session_start");
    await f.emit("turn_start");
    at(12, 0, 5);
    await f.emit("turn_end");
    expect(f.text()).toContain("took 5s");
    await f.emit("turn_start");
    at(13);
    await f.emit("session_start");
    await f.emit("turn_end");
    expect(f.text()).toStartWith("13:00:00");
    expect(f.text()).not.toContain("took");
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(1);
  });

  test("When model, thinking or branch changes, the footer shall render current state", async () => {
    const f = setup({ branch: "main" });
    await f.emit("session_start");
    f.ctx.model = { name: "new-model", provider: "test" };
    await f.emit("model_select");
    f.pi.getThinkingLevel = () => "high";
    await f.emit("thinking_level_select");
    f.setBranch("feature/new");
    expect(f.requestRender).toHaveBeenCalledTimes(3);
    expect(f.text()).toContain("feature/new via new-model・high");
  });

  test("When shutdown occurs, the owned footer shall release its subscription and stop rendering", async () => {
    const f = setup();
    await f.emit("session_start");
    await f.emit("session_shutdown");
    await f.emit("session_shutdown");
    expect(f.ctx.ui.setFooter).toHaveBeenCalledTimes(2);
    expect(f.ctx.ui.setFooter).toHaveBeenLastCalledWith(undefined);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.listeners.size).toBe(0);
    await f.emit("model_select");
    expect(f.requestRender).not.toHaveBeenCalled();
  });

  test("When another extension replaces the footer, shutdown shall leave its component alone", async () => {
    const f = setup();
    await f.emit("session_start");
    const other = { render: () => ["other footer"], invalidate() {}, dispose: mock(() => {}) };
    f.ctx.ui.setFooter(() => other);
    await f.emit("session_shutdown");
    expect(f.footer).toBe(other);
    expect(f.ctx.ui.setFooter).toHaveBeenCalledTimes(2);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    expect(other.dispose).not.toHaveBeenCalled();
  });

  test.each([
    { hasUI: false, mode: "tui" },
    { hasUI: true, mode: "rpc" },
    { hasUI: false, mode: "print" },
    { hasUI: false, mode: "json" },
  ] as const)("While no TUI is attached, footer rendering and Git lookup shall be inert: %j", async (options) => {
    const f = setup(options);
    for (const event of [
      "session_start",
      "turn_start",
      "turn_end",
      "agent_settled",
      "session_shutdown",
    ]) {
      await f.emit(event);
    }
    expect(f.ctx.ui.setFooter).not.toHaveBeenCalled();
    expect(f.pi.execCalls).toEqual([]);
  });
});
