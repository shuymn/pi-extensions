import { describe, expect, test } from "bun:test";
import { createWorkflowAgentJournalKey } from "../journal/key";
import { buildWorkflowReplayCache } from "../journal/replay";
import { runWorkflow } from "./runtime";

describe("dynamic workflow runtime", () => {
  test("runs a workflow script with basic globals and a fake agent hook", async () => {
    const agentCalls: Array<{ prompt: string; options: unknown }> = [];

    const result = await runWorkflow(
      `
        export const meta = {
          name: "basic_globals",
          description: "Exercise runtime globals",
          phases: [{ title: "Inspect" }],
        };

        phase("Inspect");
        log("cwd=" + cwd);
        const answer = await agent(
          "cwd:" + process.cwd() + "; arg:" + args.target,
          { label: "inspect target" },
        );
        return { answer, currentCwd: cwd };
      `,
      {
        cwd: "/repo",
        args: { target: "src" },
        agent: async (prompt, options) => {
          agentCalls.push({ prompt, options });
          return `agent saw ${prompt}`;
        },
      },
    );

    expect(agentCalls).toEqual([
      {
        prompt: "cwd:/repo; arg:src",
        options: { label: "inspect target", phase: "Inspect" },
      },
    ]);
    expect(result.meta.name).toBe("basic_globals");
    expect(result.phases).toEqual(["Inspect"]);
    expect(result.logs).toEqual(["cwd=/repo"]);
    expect(result.agentCount).toBe(1);
    expect(result.result).toEqual({
      answer: "agent saw cwd:/repo; arg:src",
      currentCwd: "/repo",
    });
  });

  test("blocks dynamic code generation in the VM context", async () => {
    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "code_generation_blocked",
            description: "Probe string code generation",
            phases: [{ title: "Probe" }],
          };

          await agent("satisfy required agent call");
          return new Function("return 1")();
        `,
        { cwd: "/repo", agent: () => "ok" },
      ),
    ).rejects.toThrow("Code generation from strings disallowed");
  });

  test("does not expose thread-blocking Atomics globals", async () => {
    const result = await runWorkflow(
      `
        export const meta = {
          name: "thread_blocking_globals",
          description: "Probe Atomics exposure",
          phases: [{ title: "Probe" }],
        };

        await agent("satisfy required agent call");
        return {
          atomics: typeof Atomics,
          sharedArrayBuffer: typeof SharedArrayBuffer,
        };
      `,
      { cwd: "/repo", agent: () => "ok" },
    );

    expect(result.result).toEqual({ atomics: "undefined", sharedArrayBuffer: "undefined" });
  });

  test("does not expose the host process through runtime globals or JSON values", async () => {
    const result = await runWorkflow(
      `
        export const meta = {
          name: "sandbox_boundary",
          description: "Probe exposed globals",
          phases: [{ title: "Probe" }],
        };

        async function probe(fn) {
          try {
            const value = await fn();
            return value && typeof value.version === "string" ? "escaped" : "blocked";
          } catch (_error) {
            return "blocked";
          }
        }

        const agentValue = await agent("return a JSON object", { label: "json value" });
        async function hostErrorEscape() {
          try {
            phase({});
            return "unexpected";
          } catch (error) {
            return error.constructor?.constructor?.("return process")?.();
          }
        }

        return {
          phase: await probe(() => phase.constructor?.constructor?.("return process")?.()),
          process: await probe(() => process.constructor?.constructor?.("return process")?.()),
          args: await probe(() => args.constructor?.constructor?.("return process")?.()),
          agentValue: await probe(() => agentValue.constructor?.constructor?.("return process")?.()),
          hostError: await probe(hostErrorEscape),
        };
      `,
      {
        cwd: "/repo",
        args: { target: "src" },
        agent: () => ({ ok: true }),
      },
    );

    expect(result.result).toEqual({
      phase: "blocked",
      process: "blocked",
      args: "blocked",
      agentValue: "blocked",
      hostError: "blocked",
    });
  });

  test("passes agent schema options through and returns structured fake-agent output", async () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const agentOptions: unknown[] = [];

    const result = await runWorkflow(
      `
        export const meta = {
          name: "schema_agent",
          description: "Exercise schema-backed agent calls",
          phases: [{ title: "Assess" }],
        };

        phase("Assess");
        return await agent("Return a verdict", {
          label: "verdict",
          schema: args.schema,
        });
      `,
      {
        cwd: "/repo",
        args: { schema },
        agent: (_prompt, options) => {
          agentOptions.push(options);
          return { verdict: "pass" };
        },
      },
    );

    expect(agentOptions).toEqual([{ label: "verdict", phase: "Assess", schema }]);
    expect(result.result).toEqual({ verdict: "pass" });
  });

  test.each([
    { option: "model", source: `{ model: "anthropic/claude" }` },
    { option: "thinkingLevel", source: `{ thinkingLevel: "high" }` },
    { option: "isolation", source: `{ isolation: "worktree" }` },
  ])("rejects unsupported agent execution selector $option", async ({ option, source }) => {
    const calls: string[] = [];

    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "unsupported_agent_selector",
            description: "Reject unsupported execution selectors",
            phases: [{ title: "Run" }],
          };

          return await agent("bad", ${source});
        `,
        {
          cwd: "/repo",
          agent: (prompt) => {
            calls.push(prompt);
            return "unexpected";
          },
        },
      ),
    ).rejects.toThrow(`agent option \`${option}\` is unsupported`);
    expect(calls).toEqual([]);
  });

  test("unsupported agent execution selectors hard-stop parallel branches", async () => {
    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "parallel_unsupported_agent_selector",
            description: "Reject unsupported execution selectors in parallel",
            phases: [{ title: "Run" }],
          };

          return await parallel([() => agent("bad", { model: "anthropic/claude" })]);
        `,
        { cwd: "/repo", agent: () => "unexpected" },
      ),
    ).rejects.toThrow("agent option `model` is unsupported");
  });

  test("emits stable journal keys for effective agent calls", async () => {
    const schema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const events: Array<{
      kind: "queued" | "start" | "end";
      runAgentId: string;
      label: string;
      phase?: string;
      prompt: string;
      journalKey: string;
      journalAgentId: string;
      result?: unknown;
    }> = [];
    let nextJournalAgentId = 0;

    await runWorkflow(
      `
        export const meta = {
          name: "journal_keys",
          description: "Exercise stable agent key events",
          phases: [{ title: "Review" }, { title: "Verify" }],
        };

        phase("Review");
        await agent("Review auth", {
          label: "security",
          schema: args.schema,
          agentType: "reviewer",
        });
        await agent("Verify auth", {
          label: "verify",
          phase: "Verify",
          agentType: "verifier",
        });
        return "done";
      `,
      {
        cwd: "/repo",
        args: { schema },
        journalAgentIdFactory: () => {
          nextJournalAgentId += 1;
          return `journal-agent-${nextJournalAgentId}`;
        },
        agent: () => ({ ok: true }),
        onAgentQueued: (event) => events.push({ kind: "queued", ...event }),
        onAgentStart: (event) => events.push({ kind: "start", ...event }),
        onAgentEnd: (event) => events.push({ kind: "end", ...event }),
      },
    );

    const reviewKey = createWorkflowAgentJournalKey({
      prompt: "Review auth",
      schema,
      label: "security",
      phase: "Review",
      agentType: "reviewer",
      cwd: "/repo",
    });
    const verifyKey = createWorkflowAgentJournalKey({
      prompt: "Verify auth",
      label: "verify",
      phase: "Verify",
      agentType: "verifier",
      cwd: "/repo",
    });

    expect(events).toEqual([
      {
        kind: "queued",
        runAgentId: "agent_1",
        label: "security",
        phase: "Review",
        prompt: "Review auth",
        journalKey: reviewKey,
        journalAgentId: "journal-agent-1",
      },
      {
        kind: "start",
        runAgentId: "agent_1",
        label: "security",
        phase: "Review",
        prompt: "Review auth",
        journalKey: reviewKey,
        journalAgentId: "journal-agent-1",
      },
      {
        kind: "end",
        runAgentId: "agent_1",
        label: "security",
        phase: "Review",
        prompt: "Review auth",
        journalKey: reviewKey,
        journalAgentId: "journal-agent-1",
        result: { ok: true },
      },
      {
        kind: "queued",
        runAgentId: "agent_2",
        label: "verify",
        phase: "Verify",
        prompt: "Verify auth",
        journalKey: verifyKey,
        journalAgentId: "journal-agent-2",
      },
      {
        kind: "start",
        runAgentId: "agent_2",
        label: "verify",
        phase: "Verify",
        prompt: "Verify auth",
        journalKey: verifyKey,
        journalAgentId: "journal-agent-2",
      },
      {
        kind: "end",
        runAgentId: "agent_2",
        label: "verify",
        phase: "Verify",
        prompt: "Verify auth",
        journalKey: verifyKey,
        journalAgentId: "journal-agent-2",
        result: { ok: true },
      },
    ]);
  });

  test("serves replay cache hits without spawning agents and spawns cache misses", async () => {
    const cachedKey = createWorkflowAgentJournalKey({
      prompt: "cached prompt",
      label: "cached",
      phase: "Run",
      cwd: "/repo",
    });
    const replayCache = buildWorkflowReplayCache([
      { type: "started", key: cachedKey, agentId: "previous-agent-1" },
      {
        type: "result",
        key: cachedKey,
        agentId: "previous-agent-1",
        result: { fromCache: true },
      },
    ]);
    const transcriptTarget = {
      transcriptId: "0002-fresh",
      runId: "wf_runtime_12345678",
      taskId: "task_runtime_12345678",
      workflowName: "replay_cache",
      transcriptsDir: "/repo/.pi/workflows/wf_runtime_12345678/transcripts",
    };
    const transcriptTargetEvents: unknown[] = [];
    const agentCalls: Array<{ prompt: string; options: unknown }> = [];

    const result = await runWorkflow(
      `
        export const meta = {
          name: "replay_cache",
          description: "Exercise cached agent replay",
          phases: [{ title: "Run" }],
        };

        phase("Run");
        const cached = await agent("cached prompt", { label: "cached" });
        const fresh = await agent("fresh prompt", { label: "fresh" });
        return { cached, fresh };
      `,
      {
        cwd: "/repo",
        replayCache,
        transcriptTargetFactory: (event) => {
          transcriptTargetEvents.push(event);
          return transcriptTarget;
        },
        agent: (prompt, options) => {
          agentCalls.push({ prompt, options });
          return { prompt, spawned: true };
        },
      },
    );

    expect(transcriptTargetEvents).toEqual([
      expect.objectContaining({ agentIndex: 2, label: "fresh", phase: "Run" }),
    ]);
    expect(agentCalls).toEqual([
      {
        prompt: "fresh prompt",
        options: expect.objectContaining({
          label: "fresh",
          phase: "Run",
          transcript: transcriptTarget,
        }),
      },
    ]);
    expect(result.result).toEqual({
      cached: { fromCache: true },
      fresh: { prompt: "fresh prompt", spawned: true },
    });
    expect(result.agentCount).toBe(2);
  });

  test("cleans up combined abort listeners after agent completion", async () => {
    const controller = new AbortController();
    let abortListenerAdds = 0;
    let abortListenerRemoves = 0;
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    const removeEventListener = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: unknown,
    ) => {
      if (type === "abort") abortListenerAdds += 1;
      return addEventListener(type, listener, options as never);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: unknown,
    ) => {
      if (type === "abort") abortListenerRemoves += 1;
      return removeEventListener(type, listener, options as never);
    }) as typeof controller.signal.removeEventListener;

    await runWorkflow(
      `
        export const meta = {
          name: "abort_listener_cleanup",
          description: "Exercise combined abort listener cleanup",
          phases: [{ title: "Run" }],
        };

        return await agent("done", { label: "done" });
      `,
      {
        cwd: "/repo",
        signal: controller.signal,
        agentControlFactory: () => {
          const agentController = new AbortController();
          return {
            signal: agentController.signal,
            unregister() {},
            get stopReason() {
              return undefined;
            },
          };
        },
        agent: () => "ok",
      },
    );

    expect(abortListenerAdds).toBe(1);
    expect(abortListenerRemoves).toBe(1);
  });

  test("stops a queued agent before invoking the agent hook", async () => {
    const calls: string[] = [];
    const stopped: string[] = [];
    const controls = new Map<string, { controller: AbortController; stop(reason: string): void }>();
    let releaseSlow: () => void = () => {};

    const running = runWorkflow(
      `
        export const meta = {
          name: "queued_agent_stop",
          description: "Exercise queued agent cancellation",
          phases: [{ title: "Fan out" }],
        };

        phase("Fan out");
        return await parallel([
          () => agent("slow", { label: "slow" }),
          () => agent("queued", { label: "queued" }),
        ]);
      `,
      {
        cwd: "/repo",
        maxConcurrentAgents: 1,
        agentControlFactory(event) {
          const controller = new AbortController();
          let stopReason: string | undefined;
          controls.set(event.label, {
            controller,
            stop(reason: string) {
              stopReason = reason;
              controller.abort(reason);
            },
          });
          return {
            signal: controller.signal,
            get stopReason() {
              return stopReason;
            },
            unregister() {},
          };
        },
        onAgentStop(event, reason) {
          stopped.push(`${event.label}:${reason}`);
        },
        agent: async (prompt) => {
          calls.push(prompt);
          if (prompt === "slow") await new Promise<void>((resolve) => (releaseSlow = resolve));
          return `${prompt} result`;
        },
      },
    );

    await waitUntil(() => controls.has("queued"));
    controls.get("queued")!.stop("skip queued");
    releaseSlow();

    const result = await running;

    expect(calls).toEqual(["slow"]);
    expect(stopped).toEqual(["queued:skip queued"]);
    expect(result.result).toEqual(["slow result", null]);
  });

  test("parallel preserves input order and converts branch failures to null", async () => {
    const result = await runWorkflow(
      `
        export const meta = {
          name: "parallel_order",
          description: "Exercise parallel branch behavior",
          phases: [{ title: "Fan out" }],
        };

        phase("Fan out");
        return await parallel([
          () => agent("slow", { label: "slow branch" }),
          () => { throw new Error("boom"); },
          () => agent("fast", { label: "fast branch" }),
        ]);
      `,
      {
        cwd: "/repo",
        agent: async (prompt) => {
          if (prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 5));
          return `${prompt} result`;
        },
      },
    );

    expect(result.result).toEqual(["slow result", null, "fast result"]);
    expect(result.logs).toEqual(["parallel[1] failed: boom"]);
  });

  test("parallel rejects non-thunk items and more than 4096 branches", async () => {
    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "parallel_non_thunk",
            description: "Reject accidental promises",
            phases: [{ title: "Fan out" }],
          };

          return await parallel([Promise.resolve("not a thunk")]);
        `,
        { cwd: "/repo", agent: () => "unused" },
      ),
    ).rejects.toThrow("functions, not promises");

    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "parallel_cap",
            description: "Reject too much fan out",
            phases: [{ title: "Fan out" }],
          };

          const thunks = Array.from({ length: 4097 }, () => () => agent("x"));
          return await parallel(thunks);
        `,
        { cwd: "/repo", agent: () => "unused" },
      ),
    ).rejects.toThrow("4096");
  });

  test("pipeline rejects more than 4096 items", async () => {
    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "pipeline_cap",
            description: "Reject too much pipeline fan out",
            phases: [{ title: "Pipeline" }],
          };

          const items = Array.from({ length: 4097 }, (_, index) => index);
          return await pipeline(items, (item) => item);
        `,
        { cwd: "/repo", agent: () => "unused" },
      ),
    ).rejects.toThrow("4096");
  });

  test("pipeline moves each item through all stages without a global stage barrier", async () => {
    const result = await runWorkflow(
      `
        export const meta = {
          name: "pipeline_non_barrier",
          description: "Exercise per-item pipeline flow",
          phases: [{ title: "Pipeline" }],
        };

        const events = [];
        const outputs = await pipeline(
          ["slow", "fast"],
          async (item) => {
            events.push(item + ":stage1:start");
            await agent(item, { label: item + " stage1" });
            events.push(item + ":stage1:end");
            return item + ":one";
          },
          async (previous, original) => {
            events.push(original + ":stage2:start");
            return previous + ":two";
          },
        );

        return { events, outputs };
      `,
      {
        cwd: "/repo",
        agent: async (prompt) => {
          if (prompt === "slow") await new Promise((resolve) => setTimeout(resolve, 10));
          return `${prompt} done`;
        },
      },
    );

    const value = result.result as { events: string[]; outputs: string[] };
    expect(value.outputs).toEqual(["slow:one:two", "fast:one:two"]);
    expect(value.events.indexOf("fast:stage2:start")).toBeLessThan(
      value.events.indexOf("slow:stage1:end"),
    );
  });

  test("runtime limits cap concurrent agents without changing result order", async () => {
    let active = 0;
    let maxObserved = 0;

    const result = await runWorkflow(
      `
        export const meta = {
          name: "concurrency_limit",
          description: "Exercise max concurrent agents",
          phases: [{ title: "Fan out" }],
        };

        return await parallel([
          () => agent("one", { label: "one" }),
          () => agent("two", { label: "two" }),
          () => agent("three", { label: "three" }),
        ]);
      `,
      {
        cwd: "/repo",
        maxConcurrentAgents: 2,
        agent: async (prompt) => {
          active += 1;
          maxObserved = Math.max(maxObserved, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return `${prompt} done`;
        },
      },
    );

    expect(maxObserved).toBe(2);
    expect(result.result).toEqual(["one done", "two done", "three done"]);
  });

  test("default concurrency allows more than four agents to run at once", async () => {
    let active = 0;
    let maxObserved = 0;

    const result = await runWorkflow(
      `
        export const meta = {
          name: "default_concurrency",
          description: "Exercise default max concurrent agents",
          phases: [{ title: "Fan out" }],
        };

        return await parallel(
          Array.from({ length: 6 }, (_unused, index) => () =>
            agent(String(index), { label: "a" + index }),
          ),
        );
      `,
      {
        cwd: "/repo",
        agent: async (prompt) => {
          active += 1;
          maxObserved = Math.max(maxObserved, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return `${prompt} done`;
        },
      },
    );

    expect(maxObserved).toBe(6);
    expect(result.agentCount).toBe(6);
  });

  test("runtime limits enforce max total agents and token budget hard stops", async () => {
    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "total_agent_limit",
            description: "Exercise total agent limit",
            phases: [{ title: "Run" }],
          };

          await agent("first");
          await agent("second");
          return "unreachable";
        `,
        { cwd: "/repo", maxTotalAgents: 1, agent: () => "ok" },
      ),
    ).rejects.toThrow("max total agents");

    const prompts: string[] = [];
    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "token_budget",
            description: "Exercise token budget",
            phases: [{ title: "Run" }],
          };

          await agent("first");
          await agent("second");
          return "unreachable";
        `,
        {
          cwd: "/repo",
          tokenBudget: 2,
          agent: (prompt) => {
            prompts.push(prompt);
            return "abcd";
          },
        },
      ),
    ).rejects.toThrow("token budget");
    expect(prompts).toEqual(["first"]);
  });

  test("runtime limits do not start queued parallel agents after token budget is exhausted", async () => {
    const prompts: string[] = [];

    await expect(
      runWorkflow(
        `
          export const meta = {
            name: "parallel_token_budget_queue",
            description: "Do not start queued agents after budget exhaustion",
            phases: [{ title: "Run" }],
          };

          return await parallel([
            () => agent("one", { label: "one" }),
            () => agent("two", { label: "two" }),
          ]);
        `,
        {
          cwd: "/repo",
          maxConcurrentAgents: 1,
          tokenBudget: 1,
          agent: async (prompt) => {
            prompts.push(prompt);
            return "abcd";
          },
        },
      ),
    ).rejects.toThrow("token budget");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prompts).toEqual(["one"]);
  });

  test.each([
    {
      name: "parallel total-agent limit",
      script: `
        export const meta = {
          name: "parallel_total_agent_limit",
          description: "Exercise parallel total agent limit",
          phases: [{ title: "Run" }],
        };

        return await parallel([
          () => agent("one"),
          () => agent("two"),
          () => agent("three"),
        ]);
      `,
      options: { cwd: "/repo", maxTotalAgents: 2, agent: (prompt: string) => prompt },
      expectedMessage: "max total agents",
    },
    {
      name: "pipeline total-agent limit",
      script: `
        export const meta = {
          name: "pipeline_total_agent_limit",
          description: "Exercise pipeline total agent limit",
          phases: [{ title: "Run" }],
        };

        return await pipeline(["one", "two", "three"], (item) => agent(item));
      `,
      options: { cwd: "/repo", maxTotalAgents: 2, agent: (prompt: string) => prompt },
      expectedMessage: "max total agents",
    },
    {
      name: "parallel token budget",
      script: `
        export const meta = {
          name: "parallel_token_budget",
          description: "Exercise parallel token budget",
          phases: [{ title: "Run" }],
        };

        return await parallel([() => agent("one"), () => agent("two")]);
      `,
      options: { cwd: "/repo", tokenBudget: 1, agent: () => "abcd" },
      expectedMessage: "token budget",
    },
    {
      name: "pipeline token budget",
      script: `
        export const meta = {
          name: "pipeline_token_budget",
          description: "Exercise pipeline token budget",
          phases: [{ title: "Run" }],
        };

        return await pipeline(["one", "two"], (item) => agent(item));
      `,
      options: { cwd: "/repo", tokenBudget: 1, agent: () => "abcd" },
      expectedMessage: "token budget",
    },
  ])("runtime limits hard-stop $name failures", async ({ script, options, expectedMessage }) => {
    await expect(runWorkflow(script, options)).rejects.toThrow(expectedMessage);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}
