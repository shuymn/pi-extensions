import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { DelegatedSessionOptions, DelegatedSessionResult } from "../../lib/delegated-session";
import { withTimeout } from "../../tests/support/async";

const calls: DelegatedSessionOptions[] = [];
let runner: (options: DelegatedSessionOptions) => Promise<DelegatedSessionResult>;
const cleanups: Array<ReturnType<typeof mock>> = [];
const toolNames = [
  "tavily_search",
  "tavily_extract",
  "tavily_map",
  "tavily_crawl",
  "tavily_auth_status",
  "github_clone_workspace",
];
mock.module("../../lib/delegated-session", () => ({
  inheritDelegatedTool: (tool: AgentTool, info?: ToolInfo) => ({ ...tool, ...info }),
  runDelegatedSession: (options: DelegatedSessionOptions) => {
    calls.push(options);
    return runner(options);
  },
}));
mock.module("../../lib/investigation-tools", () => ({
  createInvestigationToolset: () => {
    let closed = false;
    const cleanup = mock(async () => {
      closed = true;
    });
    cleanups.push(cleanup);
    return {
      tools: toolNames.map((name) => ({
        name,
        annotations: { readOnlyHint: true },
        async execute() {
          if (closed) throw new Error("Toolset closed");
          return { content: [], details: { usable: true } };
        },
      })),
      toolNames,
      cleanup,
    };
  },
}));
const { default: extension } = await import("./index");
const dirs: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
function outcome(status: DelegatedSessionResult["status"] = "completed"): DelegatedSessionResult {
  return {
    status,
    result: { answer: 42 },
    text: "Result",
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    evidence: { messages: [], branch: [] },
    ...(status === "failed" ? { error: "original quota error" } : {}),
  };
}
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "subagents-policy-"));
  dirs.push(cwd);
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (...args: any[]) => any>();
  const callerTools = ["read", "grep", "find", "ls", "bash", "edit", "write", ...toolNames].map(
    (name) =>
      ({
        name,
        annotations: { readOnlyHint: !["bash", "edit", "write"].includes(name) },
      }) as ToolDefinition,
  );
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (name: string, fn: any) => handlers.set(name, fn),
    getThinkingLevel: () => "high",
    getAllTools: () =>
      [
        ...callerTools.map((tool) => ({
          ...tool,
          sourceInfo: {
            path: toolNames.includes(tool.name)
              ? resolve(
                  import.meta.dirname,
                  tool.name === "github_clone_workspace"
                    ? "../add-dir/index.ts"
                    : "../tavily/index.ts",
                )
              : "fixture",
          },
        })),
        ...tools.values(),
      ] as unknown as ToolInfo[],
    getSettings: () => ({ retry: { enabled: false } }),
    exec: mock(),
    sendUserMessage: mock(),
    sendMessage: mock(),
  };
  const model = { provider: "test", id: "primary" };
  const ctx = {
    cwd,
    model,
    getSystemPrompt: () => "Parent prompt",
    modelRegistry: {},
    get tools() {
      return [...callerTools, ...tools.values()];
    },
  };
  extension(pi as any);
  const invoke = (name: string, params: any = {}, signal?: AbortSignal, onUpdate?: any) =>
    tools.get(name)!.execute("id", params, signal, onUpdate, ctx as any);
  const emit = (name: string, event = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
  const value = {
    pi,
    ctx,
    tools,
    callerTools,
    invoke,
    emit,
    shutdown: () => emit("session_shutdown"),
  };
  shutdowns.push(value.shutdown);
  return value;
}
runner = async () => outcome();
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  calls.length = 0;
  cleanups.length = 0;
  runner = async () => outcome();
});
function nested(options: DelegatedSessionOptions) {
  return options.customTools!.find((tool) => tool.name === "spawn_subagent")!;
}
async function waitForCalls(count: number) {
  for (let i = 0; i < 100 && calls.length < count; i++) await Bun.sleep(1);
  expect(calls.length).toBe(count);
}
function blockedRunner(options: DelegatedSessionOptions): Promise<DelegatedSessionResult> {
  return new Promise((resolve) =>
    options.signal!.addEventListener("abort", () => resolve(outcome("cancelled")), { once: true }),
  );
}

test("registration keeps native deferred discovery and structured outputs", () => {
  const first = setup();
  expect([...first.tools.keys()]).toEqual([
    "spawn_subagent",
    "get_subagent_result",
    "stop_subagent",
    "list_subagents",
  ]);
  expect(first.tools.get("get_subagent_result")?.exposure).toBe("deferred");
  expect(first.tools.get("spawn_subagent")?.outputSchema).toBeDefined();
  expect(first.tools.get("stop_subagent")?.exposure).toBe("deferred");
});

test("foreground returns structured result, evidence, usage and removes its record", async () => {
  const ctx = setup();
  const updates: any[] = [];
  runner = async (options) => {
    options.onText?.("streamed");
    return outcome();
  };
  const result = await ctx.invoke(
    "spawn_subagent",
    { prompt: "task", schema: { type: "object" } },
    undefined,
    (value: any) => updates.push(value),
  );
  expect(result.structuredContent).toMatchObject({
    status: "completed",
    result: { answer: 42 },
    evidence: { messages: [] },
  });
  expect(result.usage?.totalTokens).toBe(3);
  expect(updates).toHaveLength(1);
  expect(calls[0].schema).toEqual({ type: "object" });
  expect(calls[0].model).toBe(ctx.ctx.model as any);
  expect(calls[0].thinkingLevel).toBe("high");
  expect(calls[0].allowedTools).toContain("spawn_subagent");
  expect((await ctx.invoke("list_subagents")).details).toMatchObject({ count: 0 });
  ctx.ctx.model = { provider: "test", id: "changed" };
  ctx.pi.getThinkingLevel = () => "low";
  await ctx.invoke("spawn_subagent", { prompt: "later" });
  expect(calls[1].model).toBe(ctx.ctx.model as any);
  expect(calls[1].thinkingLevel).toBe("low");
});

test.each([
  { allowedTools: [] },
  { allowedTools: ["tavily_search", "tavily_extract"] },
])("caller may restrict child task tools to %j", async ({ allowedTools }) => {
  const ctx = setup();
  await ctx.invoke("spawn_subagent", { prompt: "task", allowedTools });
  expect(calls[0].allowedTools).toEqual(allowedTools);
  expect(nested(calls[0])).toBeUndefined();
  await expect(
    ctx.invoke("spawn_subagent", { prompt: "task", allowedTools: ["workflow"] }),
  ).rejects.toThrow("unavailable tool: workflow");
});

test("nested delegation intersects tools, enforces readOnly and depth, and rejects background", async () => {
  const ctx = setup();
  const inheritedModel = ctx.ctx.model;
  runner = async (options) => {
    if (options.prompt === "parent") {
      const tool = nested(options);
      const execute = (params: any) =>
        tool.execute("nested", params, undefined, undefined, ctx.ctx as any);
      expect((await execute({ prompt: "task", background: true })).details).toMatchObject({
        status: "rejected",
      });
      await expect(execute({ prompt: "task", allowedTools: ["read"] })).rejects.toThrow(
        "unavailable tool: read",
      );
      await expect(
        execute({ prompt: "task", allowedTools: ["write"], readOnly: false }),
      ).rejects.toThrow("unavailable tool: write");
      ctx.ctx.model = { provider: "test", id: "changed" };
      ctx.pi.getThinkingLevel = () => "low";
      await execute({ prompt: "child", readOnly: false });
    }
    return outcome();
  };
  await ctx.invoke("spawn_subagent", {
    prompt: "parent",
    readOnly: true,
    allowedTools: ["tavily_search", "spawn_subagent"],
  });
  expect(calls).toHaveLength(2);
  expect(calls[1].allowedTools).toEqual(["tavily_search"]);
  expect(calls[1].readOnly).toBe(true);
  expect(nested(calls[1])).toBeUndefined();
  expect(calls[1].model).toBe(inheritedModel as any);
  expect(calls[1].thinkingLevel).toBe("high");
  expect(calls[1].settings).toBe(calls[0].settings);
  expect(calls[1].settings).toEqual({ retry: { enabled: false } });
});

test("WHEN tools change in the caller, default children SHALL inherit the actual loadout", async () => {
  const ctx = setup();
  ctx.callerTools.length = 0;
  const custom = {
    name: "custom_mutation",
    annotations: { readOnlyHint: false },
  } as ToolDefinition;
  ctx.callerTools.push(custom, { name: "powershell" } as ToolDefinition);
  await ctx.invoke("spawn_subagent", { prompt: "first" });
  expect(calls[0].allowedTools).toEqual(["custom_mutation", "powershell", "spawn_subagent"]);
  expect(calls[0].customTools?.find((tool) => tool.name === custom.name)).toMatchObject(custom);
  ctx.callerTools.push({ name: "later_tool" } as ToolDefinition);
  await ctx.invoke("spawn_subagent", { prompt: "second" });
  expect(calls[1].allowedTools).toContain("later_tool");
  expect(calls[1].allowedTools).not.toContain("read");
  expect(calls[1].allowedTools).not.toContain("tavily_search");
  expect(calls[1].allowedTools).not.toContain("get_subagent_result");
});

test("WHEN readOnly is requested, children SHALL retain annotated custom reads but not mutation tools", async () => {
  const ctx = setup();
  ctx.callerTools.push(
    { name: "custom_read", annotations: { readOnlyHint: true } } as ToolDefinition,
    { name: "custom_write" } as ToolDefinition,
    { name: "powershell" } as ToolDefinition,
  );
  await ctx.invoke("spawn_subagent", { prompt: "read", readOnly: true });
  expect(calls[0].allowedTools).toContain("custom_read");
  expect(calls[0].allowedTools).toContain("bash");
  expect(calls[0].allowedTools).toContain("spawn_subagent");
  expect(calls[0].allowedTools).not.toContain("custom_write");
  expect(calls[0].allowedTools).not.toContain("powershell");
  expect(calls[0].allowedTools).not.toContain("write");
});

test("WHEN a child explicitly restricts inherited custom tools, descendants SHALL not regain excluded tools", async () => {
  const ctx = setup();
  ctx.callerTools.push({ name: "custom_tool" } as ToolDefinition);
  runner = async (options) => {
    if (options.prompt === "parent") {
      const child = nested(options);
      await expect(
        child.execute(
          "id",
          { prompt: "forbidden", allowedTools: ["write"] },
          undefined,
          undefined,
          ctx.ctx as any,
        ),
      ).rejects.toThrow("unavailable tool: write");
      await child.execute("id", { prompt: "child" }, undefined, undefined, ctx.ctx as any);
    }
    return outcome();
  };
  await ctx.invoke("spawn_subagent", {
    prompt: "parent",
    allowedTools: ["custom_tool", "spawn_subagent"],
  });
  expect(calls[1].allowedTools).toEqual(["custom_tool"]);
});

test("a provider failure never replays task", async () => {
  const ctx = setup();
  runner = async () => outcome("failed");
  const result = await ctx.invoke("spawn_subagent", { prompt: "mutate once" });
  expect(calls).toHaveLength(1);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: "original quota error",
    status: "error",
  });
});

test("already-aborted foreground never starts", async () => {
  const ctx = setup();
  const controller = new AbortController();
  controller.abort();
  expect(
    (await ctx.invoke("spawn_subagent", { prompt: "task" }, controller.signal)).details,
  ).toMatchObject({ status: "stopped" });
  expect(calls).toHaveLength(0);
});

test("background lifecycle is session-owned; stop propagates down the tree without a wake", async () => {
  const first = setup();
  const second = setup();
  const inheritedModel = first.ctx.model;
  runner = async (options) => {
    if (options.prompt === "parent") {
      first.ctx.model = { provider: "test", id: "changed" };
      first.pi.getThinkingLevel = () => "low";
      return await nested(options)
        .execute("nested", { prompt: "child" }, undefined, undefined, first.ctx as any)
        .then(() => outcome("cancelled"));
    }
    return blockedRunner(options);
  };
  const started = await first.invoke("spawn_subagent", { prompt: "parent", background: true });
  const id = (started.details as any).id;
  await waitForCalls(2);
  for (const options of calls) {
    expect(options.model).toBe(inheritedModel as any);
    expect(options.thinkingLevel).toBe("high");
  }
  expect((await second.invoke("list_subagents")).details).toMatchObject({ count: 0 });
  expect((await second.invoke("stop_subagent", { id })).details).toMatchObject({
    status: "not_found",
  });
  await second.shutdown();
  expect(calls[0].signal?.aborted).toBe(false);
  const stopped = await first.invoke("stop_subagent", { id });
  expect(stopped.details).toMatchObject({ status: "stopped" });
  expect(calls.every((options) => options.signal?.aborted)).toBe(true);
  expect(first.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(first.pi.sendMessage).not.toHaveBeenCalled();
  expect(
    (await first.invoke("get_subagent_result", { id, wait: true })).structuredContent,
  ).toMatchObject({ id, status: "stopped" });
});

test.each([
  false,
  true,
])("WHEN a background waiter is cancelled (already aborted: %s), the child SHALL remain retrievable", async (alreadyAborted) => {
  const ctx = setup();
  const child = Promise.withResolvers<DelegatedSessionResult>();
  runner = () => child.promise;
  const controller = new AbortController();
  const removed = spyOn(controller.signal, "removeEventListener");
  try {
    if (alreadyAborted) controller.abort(new Error("wait cancelled"));
    const started = await ctx.invoke(
      "spawn_subagent",
      { prompt: "task", background: true },
      controller.signal,
    );
    const id = (started.details as { id: string }).id;
    const waiting = ctx.invoke("get_subagent_result", { id, wait: true }, controller.signal);
    if (!alreadyAborted) controller.abort(new Error("wait cancelled"));
    await expect(withTimeout(waiting, "Waiter remained blocked")).rejects.toThrow("wait cancelled");
    if (!alreadyAborted) expect(removed).toHaveBeenCalledTimes(1);
    expect(calls[0].signal?.aborted).toBe(false);
    expect((await ctx.invoke("get_subagent_result", { id })).details).toMatchObject({
      id,
      status: "running",
    });
    expect((await ctx.invoke("list_subagents")).details).toMatchObject({ count: 1 });
    child.resolve(outcome());
    const result = await ctx.invoke("get_subagent_result", { id, wait: true });
    expect(result.details).toMatchObject({ id, status: "completed" });
    expect(result.usage?.totalTokens).toBe(3);
    expect((await ctx.invoke("get_subagent_result", { id })).usage).toBeUndefined();
  } finally {
    child.resolve(outcome());
    removed.mockRestore();
  }
});

test("WHEN a background waiter completes, it SHALL clean up its listener, charge once and retire on shutdown", async () => {
  const ctx = setup();
  const child = Promise.withResolvers<DelegatedSessionResult>();
  runner = () => child.promise;
  const controller = new AbortController();
  const removed = spyOn(controller.signal, "removeEventListener");
  try {
    const started = await ctx.invoke("spawn_subagent", { prompt: "task", background: true });
    const id = (started.details as { id: string }).id;
    const waiting = ctx.invoke("get_subagent_result", { id, wait: true }, controller.signal);
    child.resolve(outcome());
    const result = await withTimeout(waiting, "Waiter did not finish");
    expect(result.details).toMatchObject({ status: "completed" });
    expect(result.usage?.totalTokens).toBe(3);
    expect((await ctx.invoke("get_subagent_result", { id })).usage).toBeUndefined();
    expect(removed).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(calls[0].signal?.aborted).toBe(false);
    await ctx.shutdown();
    expect((await ctx.invoke("list_subagents")).details).toMatchObject({ count: 0 });
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  } finally {
    child.resolve(outcome());
    removed.mockRestore();
  }
});

test("foreground abort and shutdown cancel owned work and late delegation is rejected", async () => {
  const ctx = setup();
  runner = blockedRunner;
  const controller = new AbortController();
  const pending = ctx.invoke("spawn_subagent", { prompt: "task" }, controller.signal);
  await waitForCalls(1);
  controller.abort();
  expect((await pending).details).toMatchObject({ status: "stopped" });
  expect(
    (
      await nested(calls[0]).execute(
        "late",
        { prompt: "late" },
        undefined,
        undefined,
        ctx.ctx as any,
      )
    ).details,
  ).toMatchObject({ status: "error" });
  const started = await ctx.invoke("spawn_subagent", { prompt: "other", background: true });
  await ctx.shutdown();
  expect(calls[1].signal?.aborted).toBe(true);
  expect(
    (await ctx.invoke("get_subagent_result", { id: (started.details as any).id })).details,
  ).toMatchObject({ status: "not_found" });
});

// WHEN an owner leaves, descendants SHALL settle before its investigation resources close.
test.each([
  "session_before_switch",
  "session_before_fork",
  "session_before_tree",
  "session_shutdown",
])("%s waits for deferred descendant cancellation and blocks late spawn/progress", async (event) => {
  const ctx = setup();
  const settlement = Promise.withResolvers<DelegatedSessionResult>();
  const updates = mock();
  runner = async (options) => {
    if (options.prompt === "parent") {
      await nested(options).execute(
        "child",
        { prompt: "child" },
        undefined,
        undefined,
        ctx.ctx as any,
      );
      return outcome("cancelled");
    }
    return settlement.promise;
  };
  const pending = ctx.invoke("spawn_subagent", { prompt: "parent" }, undefined, updates);
  await waitForCalls(2);
  let finished = false;
  const closing = ctx.emit(event).then(() => {
    finished = true;
  });
  await Promise.resolve();
  try {
    expect(calls.every((options) => options.signal?.aborted)).toBe(true);
    expect(cleanups[0]).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    expect(
      (await ctx.invoke("spawn_subagent", { prompt: "late", background: true })).details,
    ).toMatchObject({ status: "error" });
    expect(
      (
        await nested(calls[0]).execute(
          "late",
          { prompt: "late" },
          undefined,
          undefined,
          ctx.ctx as any,
        )
      ).details,
    ).toMatchObject({ status: "error" });
    calls[0].onText?.("late progress");
    expect(updates).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(cleanups[0]).not.toHaveBeenCalled();
  } finally {
    settlement.resolve(outcome("cancelled"));
    await Promise.all([pending, closing]);
  }
  expect(finished).toBe(true);
  expect(cleanups[0]).toHaveBeenCalledTimes(1);
  expect((await ctx.invoke("list_subagents")).details).toMatchObject({ count: 0 });
  expect(ctx.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(ctx.pi.sendMessage).not.toHaveBeenCalled();
});

// WHEN navigation succeeds or is cancelled by another handler, the live owner SHALL get
// fresh resources; closures from the previous owner SHALL remain unusable.
test.each([
  ["session_before_switch", "session_start"],
  ["session_before_fork", "session_start"],
  ["session_before_tree", "session_tree"],
  ["session_before_switch", undefined],
  ["session_before_fork", undefined],
  ["session_before_tree", undefined],
])("%s followed by %s restores usable tools without reviving old closures", async (before, after) => {
  const ctx = setup();
  await ctx.invoke("spawn_subagent", { prompt: "old" });
  const old = calls[0];
  const oldTool = old.customTools!.find((tool) => tool.name === "github_clone_workspace")!;
  await ctx.emit(before!);
  if (after) await ctx.emit(after);
  runner = async (options) => {
    const tool = options.customTools!.find((entry) => entry.name === "github_clone_workspace")!;
    expect(tool).not.toBe(oldTool);
    expect((await tool.execute("probe", {}, undefined, undefined, ctx.ctx as any)).details).toEqual(
      { usable: true },
    );
    return outcome();
  };
  expect((await ctx.invoke("spawn_subagent", { prompt: "fresh" })).details).toMatchObject({
    status: "completed",
  });
  expect(cleanups).toHaveLength(2);
  expect(cleanups[0]).toHaveBeenCalledTimes(1);
  expect(cleanups[1]).not.toHaveBeenCalled();
  await expect(oldTool.execute("old", {}, undefined, undefined, ctx.ctx as any)).rejects.toThrow(
    "Toolset closed",
  );
  expect(
    (await nested(old).execute("late", { prompt: "late" }, undefined, undefined, ctx.ctx as any))
      .details,
  ).toMatchObject({ status: "error" });
  expect(calls).toHaveLength(2);
});

test("shutdown is idempotent, denies top-level spawn and only session_start can reopen it", async () => {
  const ctx = setup();
  let reentered: Promise<void> | undefined;
  runner = (options) =>
    new Promise((resolve) => {
      options.signal!.addEventListener(
        "abort",
        () => {
          reentered = ctx.shutdown();
          resolve(outcome("cancelled"));
        },
        { once: true },
      );
    });
  await ctx.invoke("spawn_subagent", { prompt: "task", background: true });
  await Promise.all([ctx.shutdown(), ctx.shutdown()]);
  expect(reentered).toBeDefined();
  await reentered;
  await ctx.shutdown();
  await ctx.emit("session_tree");
  expect(cleanups[0]).toHaveBeenCalledTimes(1);
  expect((await ctx.invoke("spawn_subagent", { prompt: "late" })).details).toMatchObject({
    status: "error",
  });
  expect(calls).toHaveLength(1);
  await ctx.emit("session_start");
  runner = async () => outcome();
  expect((await ctx.invoke("spawn_subagent", { prompt: "fresh" })).details).toMatchObject({
    status: "completed",
  });
  expect(cleanups).toHaveLength(2);
});

test("transition cleanup does not close another live runtime's records or toolset", async () => {
  const first = setup();
  const second = setup();
  runner = blockedRunner;
  await first.invoke("spawn_subagent", { prompt: "first", background: true });
  const other = await second.invoke("spawn_subagent", { prompt: "second", background: true });
  await first.emit("session_before_tree");
  await first.emit("session_tree");
  await first.shutdown();
  expect(calls[1].signal?.aborted).toBe(false);
  expect(
    (await second.invoke("get_subagent_result", { id: (other.details as any).id })).details,
  ).toMatchObject({ status: "running" });
  expect(cleanups[1]).not.toHaveBeenCalled();
  const tool = calls[1].customTools!.find((entry) => entry.name === "github_clone_workspace")!;
  expect(
    (await tool.execute("probe", {}, undefined, undefined, second.ctx as any)).details,
  ).toEqual({ usable: true });
  await second.shutdown();
  expect(cleanups[1]).toHaveBeenCalledTimes(1);
});
