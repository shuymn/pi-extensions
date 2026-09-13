import { describe, expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFakePi } from "../../tests/support/fake-pi";
import { CONTINUATION_LIMIT, GOAL_ENTRY, restoreGoal } from "./goal";
import { createContinuationRuntime } from "./runtime";

function harness(sessionManager = SessionManager.inMemory()) {
  const pi = createFakePi<any, any>();
  const originalAppend = pi.appendEntry;
  pi.appendEntry = (type, data) => {
    originalAppend(type, data);
    sessionManager.appendCustomEntry(type, data);
  };
  const runtime = createContinuationRuntime(pi as never);
  const callbacks: any[] = [];
  const abort = new AbortController();
  let idle = true;
  let queued = false;
  const ctx = {
    hasUI: false,
    cwd: "/tmp",
    sessionManager,
    signal: abort.signal,
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    compact: (options: any) => callbacks.push(options),
    abort: () => abort.abort(),
  };
  async function emit(name: string, event: any = {}) {
    for (const h of pi.getEventHandlers(name)) await h(event, ctx);
  }
  const command = (args: string) => pi.commands.get("goal")!.handler(args, ctx);
  const tool = (action: string, evidence?: string) =>
    pi.tools.get("goal")!.execute("call", { action, evidence }, undefined, undefined, ctx);
  const state = () =>
    sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === GOAL_ENTRY)
      .at(-1) as any;
  const turns = () => pi.sentMessages.filter((m) => (m.options as any).triggerTurn);
  async function end(stopReason = "stop") {
    await emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
    await emit("agent_settled");
  }
  return {
    pi,
    runtime,
    ctx,
    abort,
    emit,
    command,
    tool,
    state,
    turns,
    callbacks,
    end,
    setIdle: (v: boolean) => {
      idle = v;
    },
    setQueued: (v: boolean) => {
      queued = v;
    },
  };
}

describe("Goal and compact continuation", () => {
  test("When a normal request or legacy todo Goal ends, no automatic work starts", async () => {
    const h = harness();
    h.ctx.sessionManager.appendCustomEntry("todo", {
      goal: { objective: "old", status: "active" },
    });
    await h.emit("session_start");
    await h.end();
    expect(h.turns()).toHaveLength(0);
    await expect(h.tool("complete", "done")).rejects.toThrow("No running");
  });
  test("When explicitly started, Goal continues once after settled, never at agent_end", async () => {
    const h = harness();
    await h.command("start Ship fix | Regression passes | Checks pass");
    expect(h.turns()).toHaveLength(1);
    await h.emit("agent_end", { messages: [] });
    expect(h.turns()).toHaveLength(1);
    await h.emit("agent_settled");
    await h.emit("agent_settled");
    expect(h.turns()).toHaveLength(2);
    expect(h.state().data.continuations).toBe(1);
    expect(h.state().data.doneWhen).toEqual(["Regression passes", "Checks pass"]);
  });
  test("While busy or a user message is queued, Goal does not add another turn", async () => {
    const h = harness();
    await h.command("start A | B");
    h.setIdle(false);
    await h.end();
    h.setIdle(true);
    h.setQueued(true);
    await h.emit("agent_settled");
    expect(h.turns()).toHaveLength(1);
    h.setQueued(false);
    await h.emit("agent_settled");
    expect(h.turns()).toHaveLength(2);
  });
  test("When stopped after agent_end, a pending continuation is cancelled", async () => {
    const h = harness();
    await h.command("start A | B");
    await h.emit("agent_end", { messages: [] });
    await h.command("stop");
    await h.emit("agent_settled");
    expect(h.turns()).toHaveLength(1);
    expect(h.state().data.status).toBe("paused");
  });
  test("When Esc aborts a running turn, Goal remains paused, not failed or completed", async () => {
    const h = harness();
    await h.command("start A | B");
    await h.emit("turn_start");
    h.abort.abort();
    await h.end("aborted");
    expect(h.turns()).toHaveLength(1);
    expect(h.state().data.status).toBe("paused");
  });
  test("When waiting for input, only explicit user resume reauthorizes continuation", async () => {
    const h = harness();
    await h.command("start A | B");
    await h.tool("wait", "Need approval");
    await h.end();
    await h.emit("input", { source: "interactive", text: "yes" });
    await h.end();
    expect(h.turns()).toHaveLength(1);
    await h.command("resume");
    expect(h.turns()).toHaveLength(2);
    expect(h.state().data.status).toBe("running");
  });
  test("When UI or unavailable questionnaire needs input, automatic continuation waits", async () => {
    for (const event of ["ui_prompt_start", "tool_result"]) {
      const h = harness();
      await h.command("start A | B");
      await h.emit(event, { toolName: "ask_user_question", details: { status: "cancelled" } });
      await h.end();
      expect(h.state().data.status).toBe("waiting");
      expect(h.turns()).toHaveLength(1);
    }
  });
  test("When completed, evidence is required and no further turn is scheduled", async () => {
    const h = harness();
    await h.command("start A | B");
    await expect(h.tool("complete")).rejects.toThrow("Evidence");
    await h.tool("complete", "B verified by test");
    await h.end();
    expect(h.turns()).toHaveLength(1);
    expect(h.state().data).toMatchObject({ status: "completed", evidence: "B verified by test" });
  });
  test("When the continuation limit is reached, state is limited and resume resets the allowance", async () => {
    const h = harness();
    await h.command("start A | B");
    for (let i = 0; i < CONTINUATION_LIMIT + 2; i++) await h.end();
    expect(h.turns()).toHaveLength(CONTINUATION_LIMIT + 1);
    expect(h.state().data.status).toBe("limited");
    await h.command("resume");
    expect(h.state().data.continuations).toBe(0);
  });
  test("When a compact request and Goal end together, only compact owns the continuation", async () => {
    const h = harness();
    await h.command("start A | B");
    h.runtime.schedule({ customInstructions: "handoff", continuationPrompt: "verify remaining" });
    await h.end();
    await h.emit("agent_settled");
    expect(h.callbacks).toHaveLength(1);
    expect(h.turns()).toHaveLength(1);
    expect(h.callbacks[0].customInstructions).toBe("handoff");
    h.callbacks[0].onComplete();
    h.callbacks[0].onComplete();
    await h.emit("agent_settled");
    expect(h.turns()).toHaveLength(2);
    expect(h.state().data.continuations).toBe(1);
    expect(h.turns()[1].message.content).toBe("verify remaining");
  });
  test("When compact succeeds without a Goal, it continues once; stopAfterCompaction never resumes", async () => {
    for (const stopAfterCompaction of [false, true]) {
      const h = harness();
      h.runtime.schedule({ stopAfterCompaction });
      await h.end();
      h.callbacks[0].onComplete();
      h.callbacks[0].onComplete();
      expect(h.turns()).toHaveLength(stopAfterCompaction ? 0 : 1);
    }
  });
  test("When compact-and-stop is requested during a Goal, Goal also pauses", async () => {
    const h = harness();
    await h.command("start A | B");
    h.runtime.schedule({ stopAfterCompaction: true });
    await h.end();
    h.callbacks[0].onComplete();
    await h.end();
    expect(h.turns()).toHaveLength(1);
    expect(h.state().data.status).toBe("paused");
  });
  test("When stopped, switched, forked or shut down, old compact callbacks cannot mutate or resume", async () => {
    for (const event of [
      "stop",
      "session_before_switch",
      "session_before_fork",
      "session_before_tree",
      "session_shutdown",
    ]) {
      const h = harness();
      await h.command("start A | B");
      h.runtime.schedule({});
      await h.end();
      if (event === "stop") await h.command("stop");
      else await h.emit(event);
      await h.command("start New | New condition");
      const before = h.state().data;
      h.callbacks[0].onComplete();
      h.callbacks[0].onError(new Error("stale"));
      expect(h.turns()).toHaveLength(2);
      expect(h.state().data).toEqual(before);
    }
  });
  test("When compaction fails or an unrecoverable model error settles, stop visibly without retry", async () => {
    const h = harness();
    await h.command("start A | B");
    h.runtime.schedule({});
    await h.end();
    h.callbacks[0].onError(new Error("input too large"));
    h.callbacks[0].onComplete();
    await h.end("error");
    expect(h.turns()).toHaveLength(1);
    expect(h.state().data.status).toBe("failed");
    expect(
      h.pi.sentMessages.some(
        (m) => m.message.display && m.message.content.includes("input too large"),
      ),
    ).toBe(true);
  });
  test("When native overflow recovery retries, it owns the retry until settled", async () => {
    const h = harness();
    await h.command("start A | B");
    await h.emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "overflow" }],
    });
    await h.emit("session_compact", { reason: "overflow", willRetry: true });
    expect(h.turns()).toHaveLength(1);
    await h.emit("agent_start");
    await h.end();
    expect(h.turns()).toHaveLength(2);
    expect(h.state().data.status).toBe("running");
  });
  test("When multiple compactions are saved, structured state survives and reopening never authorizes execution", async () => {
    const h = harness();
    await h.command("start Repair | Tests pass");
    for (let i = 0; i < 3; i++) {
      const kept = h.ctx.sessionManager.appendMessage({
        role: "user",
        content: `work ${i}`,
        timestamp: Date.now(),
      });
      h.runtime.schedule({ customInstructions: `handoff ${i}` });
      await h.end();
      h.ctx.sessionManager.appendCompaction(`summary ${i}`, kept, 10000);
      await h.emit("session_compact", { reason: "manual", willRetry: false });
      h.callbacks[i].onComplete();
    }
    expect(h.state().data).toMatchObject({
      objective: "Repair",
      doneWhen: ["Tests pass"],
      continuations: 3,
      status: "running",
    });
    const fresh = harness(h.ctx.sessionManager);
    await fresh.emit("session_start");
    await fresh.end();
    expect(fresh.turns()).toHaveLength(0);
    expect(fresh.state().data.status).toBe("paused");
    expect(restoreGoal(h.ctx.sessionManager.getBranch())?.doneWhen).toEqual(["Tests pass"]);
  });
});

test("When native compaction fulfills a queued checkpoint, no second compaction runs", async () => {
  const h = harness();
  await h.command("start A | B");
  h.runtime.schedule({ customInstructions: "handoff details", continuationPrompt: "next check" });
  await h.emit("agent_end", { messages: [] });
  await h.emit("session_compact", { reason: "threshold", willRetry: false });
  await h.emit("agent_settled");
  expect(h.callbacks).toHaveLength(0);
  expect(h.turns()).toHaveLength(2);
  expect(h.turns()[1].message.content).toContain("handoff details");
});

test("When native compaction fulfills compact-and-stop, even its retry is interrupted", async () => {
  const h = harness();
  await h.command("start A | B");
  h.runtime.schedule({ stopAfterCompaction: true });
  await h.emit("agent_end", { messages: [] });
  await h.emit("session_compact", { reason: "overflow", willRetry: true });
  await h.emit("agent_start");
  await h.emit("turn_start");
  await h.end("aborted");
  expect(h.ctx.signal.aborted).toBe(true);
  expect(h.callbacks).toHaveLength(0);
  expect(h.turns()).toHaveLength(1);
  expect(h.state().data.status).toBe("paused");
});

test("When a later compaction starts, callbacks from an earlier success cannot resume or fail it", async () => {
  const h = harness();
  await h.command("start A | B");
  h.runtime.schedule({});
  await h.end();
  h.callbacks[0].onComplete();
  h.runtime.schedule({});
  await h.end();
  const before = h.state().data;
  h.callbacks[0].onComplete();
  h.callbacks[0].onError(new Error("late old error"));
  expect(h.turns()).toHaveLength(2);
  expect(h.state().data).toEqual(before);
  h.callbacks[1].onComplete();
  expect(h.turns()).toHaveLength(3);
});

test("When leaving and restoring a session, waiting, limited and failed remain distinct", async () => {
  for (const status of ["waiting", "limited", "failed"] as const) {
    const h = harness();
    h.ctx.sessionManager.appendCustomEntry(GOAL_ENTRY, {
      objective: "A",
      doneWhen: ["B"],
      status,
      continuations: status === "limited" ? CONTINUATION_LIMIT : 0,
      evidence: "reason to retain",
    });
    await h.emit("session_start");
    await h.emit("session_shutdown");
    await h.emit("session_start");
    await h.end();
    expect(h.state().data).toMatchObject({ status, evidence: "reason to retain" });
    expect(h.turns()).toHaveLength(0);
  }
});

test("When later ordinary work compacts after Goal completion, it continues without reviving the Goal", async () => {
  const h = harness();
  await h.command("start A | B");
  await h.tool("complete", "verified B");
  await h.end();
  h.runtime.schedule({});
  await h.end();
  h.callbacks[0].onComplete();
  expect(h.turns()).toHaveLength(2);
  expect(h.state().data.status).toBe("completed");
});

test("When ordinary work requests input, any pending compact continuation is cancelled", async () => {
  const h = harness();
  h.runtime.schedule({});
  await h.emit("ui_prompt_start");
  await h.end();
  expect(h.callbacks).toHaveLength(0);
  expect(h.turns()).toHaveLength(0);
});

for (const status of ["paused", "waiting", "limited", "failed"] as const) {
  test(
    "When later ordinary work compacts after " +
      status +
      ", it continues without rearming the old Goal",
    async () => {
      const h = harness();
      h.ctx.sessionManager.appendCustomEntry(GOAL_ENTRY, {
        objective: "Old task",
        doneWhen: ["Old condition"],
        status,
        continuations: status === "limited" ? CONTINUATION_LIMIT : 0,
        evidence: "old reason",
      });
      await h.emit("session_start");
      const before = h.state().data;
      h.runtime.schedule({});
      await h.end();
      h.callbacks[0].onComplete();
      expect(h.turns()).toHaveLength(1);
      expect(h.state().data).toEqual(before);
      await h.end();
      expect(h.turns()).toHaveLength(1);
    },
  );
}

test("When the focused auto-compaction cannot authenticate, it cancels rather than dropping the focus", async () => {
  const h = harness();
  await h.command("start A | B");
  Object.assign(h.ctx, {
    model: { provider: "test" },
    modelRegistry: {
      getProvider: () => ({}),
      getApiKeyAndHeaders: async () => ({ ok: false, error: "No subscription credentials" }),
    },
  });
  h.runtime.schedule({ customInstructions: "Preserve the decision" });
  const handler = h.pi.getEventHandlers("session_before_compact")[0]!;
  expect(
    await handler({ reason: "overflow", signal: new AbortController().signal }, h.ctx),
  ).toEqual({ cancel: true });
  await h.emit("session_compact_failed", { aborted: true });
  await h.end();
  expect(h.state().data.status).toBe("failed");
  expect(h.turns()).toHaveLength(1);
});

test("When a Goal waits, only a new human request allows ordinary compact continuation", async () => {
  const h = harness();
  await h.command("start A | B");
  await h.tool("wait", "Need input");
  h.runtime.schedule({});
  await h.end();
  h.callbacks[0].onComplete();
  expect(h.turns()).toHaveLength(1);
  await h.emit("input", { source: "interactive", text: "Work on a separate task" });
  h.runtime.schedule({});
  await h.end();
  h.callbacks[1].onComplete();
  expect(h.turns()).toHaveLength(2);
  expect(h.state().data.status).toBe("waiting");
  await h.end();
  expect(h.turns()).toHaveLength(2);
});
