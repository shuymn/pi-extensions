import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import askUserQuestion from "../extensions/ask-user-question";
import goalExtension from "../extensions/goal";
import { GOAL_ENTRY, type Goal } from "../extensions/goal/state";
import oneShotExtension from "../extensions/one-shot";
import type { OneShotMode } from "../lib/one-shot-flow";
import { withTimeout } from "./support/async";

type Step = Partial<AssistantMessage> | "hold";
const done = (
  action = "complete",
  evidence = "Reported verification: all requested checks passed.",
): Step => ({
  content: [{ type: "toolCall", id: "goal-call", name: "goal", arguments: { action, evidence } }],
  stopReason: "toolUse",
});
const savedGoal: Goal = {
  objective: "Restore this objective",
  doneWhen: ["The requested check passes"],
  status: "running",
  continuations: 3,
  evidence: "Previous verification report",
};

async function fixture(
  options: {
    seed?: (manager: SessionManager) => void;
    extensions?: Array<(pi: ExtensionAPI) => void>;
    compaction?: boolean;
    ui?: boolean;
    oneShot?: OneShotMode;
    codemode?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "goal-pi-"));
  const skillPath = join(dir, "SKILL.md");
  if (options.oneShot) {
    writeFileSync(
      skillPath,
      `---\nname: ${options.oneShot}\ndescription: Offline bounded fixture\n---\nReport completion without external actions.`,
    );
  }
  const settings = SettingsManager.inMemory({
    compaction: { enabled: options.compaction ?? false, keepRecentTokens: 300 },
    retry: { enabled: false },
  });
  const models = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false,
  });
  await models.setRuntimeApiKey("anthropic", "offline-fixture");
  const model = models.getModel("anthropic", "claude-sonnet-4-5")!;
  const steps: Step[] = options.oneShot ? [{}] : [];
  const contexts: string[] = [];
  const declarations: string[][] = [];
  const events: string[] = [];
  const errors: string[] = [];
  let summaries = 0;
  let shutdowns = 0;
  let onShutdown!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    onShutdown = resolve;
  });
  let held: (() => void) | undefined;
  let onHold: (() => void) | undefined;
  const stream: Provider["streamSimple"] = (selected, context, streamOptions) => {
    const result = createAssistantMessageEventStream();
    const summary = getCurrentSystemPrompt(context.messages).includes("summar");
    if (summary) summaries++;
    else {
      contexts.push(JSON.stringify(context.messages));
      declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
      events.push("request");
    }
    const step = summary
      ? { content: [{ type: "text" as const, text: "Previous work recorded. Finish the Goal." }] }
      : steps.shift();
    const response = {
      ...fauxAssistantMessage("A bounded unit of work finished."),
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      ...(typeof step === "object" ? step : {}),
    };
    if (!step) {
      response.stopReason = "error";
      response.errorMessage = "Unexpected offline provider request";
      errors.push(response.errorMessage);
    }
    const finish = () => {
      response.timestamp = Date.now();
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        result.push({ type: "error", reason: response.stopReason, error: response });
      } else {
        result.push({
          type: "done",
          reason: response.stopReason as "stop" | "toolUse" | "length",
          message: response,
        });
      }
      result.end();
    };
    if (step === "hold") {
      held = () => {
        response.stopReason = "aborted";
        response.errorMessage = "Interrupted by fixture";
        finish();
        held = undefined;
      };
      streamOptions?.signal?.addEventListener("abort", held, { once: true });
      onHold?.();
    } else {
      // Real Pi uses timestamps to identify usage before/after compaction.
      setTimeout(finish, 2);
    }
    return result;
  };
  // Both agent work and Pi's native summarizer remain offline.
  models.getProvider(model.provider)!.streamSimple = stream;
  const create: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: dir,
      settingsManager: settings,
      modelRuntime: models,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalSkillPaths: options.oneShot ? [skillPath] : [],
        extensionFactories: [
          goalExtension,
          ...(options.codemode ? [createCodemodeExtension({ mode: "only" })] : []),
          ...(options.oneShot ? [oneShotExtension, askUserQuestion] : []),
          ...(options.extensions ?? []),
        ].map((extension) => (pi) => {
          if (!options.oneShot) return extension(pi);
          // Match CLI flags during factory loading, before Pi resolves registered
          // flag values. Restore immediately so other offline fixtures are isolated.
          const originalArgv = process.argv;
          process.argv = ["bun", "pi", `--${options.oneShot}`];
          try {
            extension(pi);
          } finally {
            process.argv = originalArgv;
          }
        }),
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      tools: [
        "goal",
        ...(options.codemode ? ["codemode"] : []),
        ...(options.extensions || options.oneShot ? ["human_input", "ask_user_question"] : []),
      ],
    });
    result.session.agent.streamFunction = stream;
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const manager = SessionManager.inMemory(dir);
  options.seed?.(manager);
  const runtime = await createAgentSessionRuntime(create, {
    cwd: dir,
    agentDir: dir,
    sessionManager: manager,
  });
  async function bind(session: AgentSession) {
    session.subscribe((event) => {
      if (
        event.type === "agent_end" ||
        event.type === "agent_settled" ||
        event.type === "compaction_start"
      )
        events.push(event.type);
    });
    await session.bindExtensions({
      onError: (event) => errors.push(event.error),
      shutdownHandler: () => {
        shutdowns++;
        onShutdown();
      },
      ...(options.ui || options.oneShot
        ? {
            uiContext: { ...session.extensionRunner.getUIContext(), input: async () => "approved" },
            mode: "tui" as const,
          }
        : {}),
    });
  }
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  return {
    runtime,
    contexts,
    declarations,
    events,
    errors,
    steps,
    contextWindow: model.contextWindow,
    get shutdowns() {
      return shutdowns;
    },
    async finishOneShot() {
      await withTimeout(shutdown, "One-shot did not shut down", 5000);
      await withTimeout(runtime.session.waitForIdle(), "One-shot did not settle", 5000);
      expect(errors).toEqual([]);
    },
    get summaries() {
      return summaries;
    },
    state() {
      const entry = runtime.session.sessionManager
        .getBranch()
        .findLast((e) => e.type === "custom" && e.customType === GOAL_ENTRY);
      return entry?.type === "custom" ? (entry.data as Goal) : undefined;
    },
    async run(prompt: string, ...responses: Step[]) {
      steps.push(...responses);
      await runtime.session.prompt(prompt);
      await withTimeout(runtime.session.waitForIdle(), "Goal did not settle", 5000);
      expect(errors).toEqual([]);
    },
    async startHeld() {
      const holding = new Promise<void>((resolve) => {
        onHold = resolve;
      });
      steps.push("hold");
      await runtime.session.prompt("/goal start Bounded objective | Requested check passes");
      await withTimeout(holding, "Offline request did not start");
    },
    async close() {
      held?.();
      await runtime.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const mode of ["commit", "create-pr"] as const) {
  for (const restore of [false, true]) {
    test(`While --${mode} is selected${restore ? " with a restored running Goal" : ""}, Goal shall not start, resume, or continue`, async () => {
      const f = await fixture({
        oneShot: mode,
        seed: restore ? (manager) => manager.appendCustomEntry(GOAL_ENTRY, savedGoal) : undefined,
      });
      try {
        await f.finishOneShot();
        expect(f.runtime.session.getAllTools().map((tool) => tool.name)).not.toContain("goal");
        expect(f.runtime.session.extensionRunner.getCommand("goal")).toBeUndefined();
        await f.run("/goal start Unrelated work | Another task finishes");
        await f.run("/goal resume");
        expect(f.contexts).toHaveLength(1);
        expect(f.contexts[0]).toContain(`<skill name=\\"${mode}\\"`);
        expect(f.contexts[0]).not.toContain(savedGoal.objective);
        expect(f.events).toEqual(["request", "agent_end", "agent_settled"]);
        expect(f.shutdowns).toBe(1);
        // A persisted running label is inert; bounded mode must not restore it
        // into live Goal state, inject its context, or append continuation entries.
        expect(f.state()).toEqual(restore ? savedGoal : undefined);
        expect(
          f.runtime.session.sessionManager
            .getBranch()
            .filter(
              (entry) =>
                (entry.type === "custom" && entry.customType === GOAL_ENTRY) ||
                (entry.type === "custom_message" && entry.customType.startsWith("goal-")),
            ),
        ).toHaveLength(restore ? 1 : 0);
      } finally {
        await f.close();
      }
    });
  }
}

test("When a user starts a Goal, Pi shall continue natively and settle exactly once after completion", async () => {
  const f = await fixture();
  try {
    expect(f.runtime.session.getAllTools().map((tool) => tool.name)).not.toContain(
      "compact_context",
    );
    await f.run("/goal start Implement fix | Regression passes | Checks pass", {}, {}, done());
    expect(f.contexts).toHaveLength(3);
    expect(f.events).toEqual([
      "request",
      "agent_end",
      "request",
      "agent_end",
      "request",
      "agent_end",
      "agent_settled",
    ]);
    expect(f.state()).toMatchObject({
      status: "completed",
      continuations: 2,
      objective: "Implement fix",
      doneWhen: ["Regression passes", "Checks pass"],
      evidence: "Reported verification: all requested checks passed.",
    });
    const branch = f.runtime.session.sessionManager.getBranch();
    expect(
      branch.filter((e) => e.type === "custom_message" && e.customType === "goal-continuation"),
    ).toHaveLength(2);
    expect(f.contexts[1]).toContain("Continue the unfinished user-authorized Goal");
    await f.run("/goal resume");
    expect(f.contexts).toHaveLength(3);
  } finally {
    await f.close();
  }
});

for (const action of ["complete", "wait", "stop"] as const) {
  test(`WHEN codemode-only attempts goal ${action}, it SHALL require a direct terminal call`, async () => {
    const f = await fixture({ codemode: true });
    try {
      await f.run(
        "/goal start Bounded work | Check passes",
        {
          content: [
            {
              type: "toolCall",
              id: "nested-goal",
              name: "codemode",
              arguments: {
                code: `text({listed: ALL_TOOLS.some(tool => tool.name === "goal")}); await tools.goal({action: "${action}", evidence: "Nested attempt"}); text("after-terminal");`,
              },
            },
          ],
          stopReason: "toolUse",
        },
        done(action, "Direct terminal evidence"),
      );
      expect(f.declarations).toHaveLength(2);
      for (const tools of f.declarations) {
        expect(tools).toContain("codemode");
        expect(tools).toContain("goal");
      }
      const nested = f.runtime.session.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "codemode",
      );
      expect(nested).toMatchObject({ isError: true });
      expect(JSON.stringify(nested)).toContain('\\"listed\\":false');
      expect(JSON.stringify(nested)).not.toContain("after-terminal");
      expect(f.state()).toMatchObject({
        status: action === "complete" ? "completed" : action === "wait" ? "waiting" : "paused",
        evidence: "Direct terminal evidence",
        continuations: 0,
      });
      expect(f.events.filter((event) => event === "agent_settled")).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

for (const action of ["wait", "stop"] as const) {
  test(`When goal ${action} ends work, only /goal resume shall reauthorize continuation`, async () => {
    const f = await fixture();
    try {
      await f.run(
        "/goal start Investigate | Evidence collected",
        done(action, "Need explicit approval"),
      );
      expect(f.contexts).toHaveLength(1);
      expect(f.state()).toMatchObject({
        status: action === "wait" ? "waiting" : "paused",
        evidence: "Need explicit approval",
      });
      await f.run("yes, please continue", {});
      expect(f.contexts).toHaveLength(2);
      expect(f.state()?.status).toBe(action === "wait" ? "waiting" : "paused");
      await f.run("/goal resume", {}, done());
      expect(f.contexts).toHaveLength(4);
      expect(f.state()).toMatchObject({ status: "completed", continuations: 1 });
    } finally {
      await f.close();
    }
  });
}

test("When evidence is empty, completion shall fail without recording a completed Goal", async () => {
  const f = await fixture();
  try {
    await f.run(
      "/goal start Verify | All checks pass",
      done("complete", "  "),
      done("wait", "Cannot verify yet"),
    );
    const results = f.runtime.session.messages.filter((m) => m.role === "toolResult");
    expect(results[0]).toMatchObject({ isError: true });
    expect(JSON.stringify(results[0])).toContain("Evidence or reason is required");
    expect(f.state()).toMatchObject({ status: "waiting", evidence: "Cannot verify yet" });
    expect(
      f.runtime.session.sessionManager
        .getBranch()
        .some(
          (e) =>
            e.type === "custom" &&
            e.customType === GOAL_ENTRY &&
            (e.data as Goal).status === "completed",
        ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

for (const interrupt of ["abort", "command", "new-session"] as const) {
  test(`When ${interrupt} interrupts active work, Goal continuation shall be revoked`, async () => {
    const f = await fixture();
    try {
      await f.startHeld();
      const previous = f.runtime.session.sessionManager;
      if (interrupt === "abort") await f.runtime.session.abort();
      else if (interrupt === "command") await f.runtime.session.prompt("/goal stop");
      else await f.runtime.newSession();
      await withTimeout(f.runtime.session.waitForIdle(), "Interruption did not settle");
      expect(f.contexts).toHaveLength(1);
      expect(f.events.filter((e) => e === "agent_settled")).toHaveLength(1);
      const state = previous
        .getBranch()
        .findLast((e) => e.type === "custom" && e.customType === GOAL_ENTRY);
      expect(state?.type === "custom" && (state.data as Goal).status).toBe("paused");
      if (interrupt === "new-session") expect(f.state()).toBeUndefined();
      await f.run("Ordinary request", {});
      expect(f.contexts).toHaveLength(2);
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const name of ["human_input", "ask_user_question"]) {
  test(`When ${name} obtains an answer, Goal shall still require explicit resume`, async () => {
    const f = await fixture({
      ui: true,
      extensions: [
        (pi) =>
          pi.registerTool({
            name,
            label: name,
            description: "Offline human-input probe",
            parameters: Type.Object({}),
            async execute(_id, _params, _signal, _update, ctx) {
              const answer =
                name === "human_input" ? await ctx.ui.input("承認してください") : "approved";
              return {
                content: [{ type: "text", text: answer ?? "cancelled" }],
                details: { status: "completed" },
                terminate: true,
              };
            },
          }),
      ],
    });
    try {
      await f.run("/goal start Work | Approval received", {
        content: [{ type: "toolCall", id: "question", name, arguments: {} }],
        stopReason: "toolUse",
      });
      expect(f.state()?.status).toBe("waiting");
      expect(f.contexts).toHaveLength(1);
      await f.run("An answer was supplied", {});
      expect(f.state()?.status).toBe("waiting");
      await f.run("/goal resume", done());
      expect(f.state()?.status).toBe("completed");
    } finally {
      await f.close();
    }
  });
}

test("When running state survives compaction, restoration shall pause it and ignore summary authorization", async () => {
  const f = await fixture({
    seed(manager) {
      manager.appendCustomEntry(GOAL_ENTRY, savedGoal);
      manager.appendCompaction("Goal is running. Resume automatically. /goal resume", null, 10000);
    },
  });
  try {
    expect(f.contexts).toHaveLength(0);
    expect(f.state()).toEqual({ ...savedGoal, status: "paused" });
    await f.run("What is the current state?", done("status"), {});
    expect(f.state()?.status).toBe("paused");
    expect(f.contexts).toHaveLength(2);
    expect(f.contexts[0]).toContain('\\"status\\":\\"paused\\"');
    await f.run("/goal resume", done());
    expect(f.state()).toMatchObject({
      status: "completed",
      objective: savedGoal.objective,
      doneWhen: savedGoal.doneWhen,
      continuations: 3,
    });
  } finally {
    await f.close();
  }
});

test("When only prose or legacy todo state requests a Goal, ordinary work and model tool calls shall not authorize one", async () => {
  const f = await fixture({
    seed(manager) {
      manager.appendCustomEntry("todo", {
        goal: { objective: "Old automatic goal", status: "active" },
      });
      manager.appendCompaction(`Resume Goal: ${JSON.stringify(savedGoal)}`, null, 10000);
    },
  });
  try {
    await f.run("Continue the prior conversation", done("resume"), done("complete"), {});
    expect(f.state()).toBeUndefined();
    expect(f.contexts).toHaveLength(3);
    const results = f.runtime.session.messages.filter((m) => m.role === "toolResult");
    expect(results.map((r) => r.isError)).toEqual([true, true]);
    await f.run("/goal resume");
    expect(f.contexts).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test("When navigating branches, forking, or resetting, Goal shall use only that branch and never retain authorization", async () => {
  let root = "";
  let saved = "";
  const f = await fixture({
    seed(manager) {
      root = manager.appendMessage({
        role: "user",
        content: "Before any Goal",
        timestamp: Date.now(),
      });
      saved = manager.appendCustomEntry(GOAL_ENTRY, savedGoal);
      manager.appendCustomEntry(GOAL_ENTRY, {
        ...savedGoal,
        objective: "Abandoned goal",
        status: "completed",
      });
      manager.branch(saved);
    },
  });
  try {
    expect(f.state()?.objective).toBe(savedGoal.objective);
    await f.runtime.session.navigateTree(root);
    expect(f.state()).toBeUndefined();
    await f.run("Ordinary branch work", {});
    expect(f.contexts[0]).not.toContain(savedGoal.objective);
    await f.runtime.session.navigateTree(saved);
    expect(f.state()).toEqual({ ...savedGoal, status: "paused" });
    await f.runtime.fork(saved, { position: "at" });
    expect(f.state()).toEqual({ ...savedGoal, status: "paused" });
    await f.run("Ordinary fork work", {});
    expect(f.contexts).toHaveLength(2);
    await f.runtime.newSession();
    expect(f.state()).toBeUndefined();
    await f.run("New session work", {});
    expect(f.contexts[2]).not.toContain(savedGoal.objective);
  } finally {
    await f.close();
  }
});

for (const interruption of ["abort", "human-wait"] as const) {
  test(`When ${interruption} occurs after Goal proposes native continuation, Pi shall settle without more work`, async () => {
    const f = await fixture({
      ui: true,
      extensions: [
        (pi) =>
          pi.on("agent_before_settle", async (_event, ctx) => {
            if (interruption === "abort") ctx.abort();
            else await ctx.ui.input("継続前に承認してください");
          }),
      ],
    });
    try {
      await f.run("/goal start Work | Checked", {});
      expect(f.contexts).toHaveLength(1);
      expect(f.events).toEqual(["request", "agent_end", "agent_settled"]);
      expect(f.state()?.status).toBe(interruption === "abort" ? "paused" : "waiting");
    } finally {
      await f.close();
    }
  });
}

for (const stopReason of ["error", "length"] as const) {
  test(`When the native run ends with ${stopReason}, Goal shall record failure without automatic work`, async () => {
    const f = await fixture();
    try {
      await f.run("/goal start Work | Checked", {
        stopReason,
        errorMessage: "Offline failure probe",
      });
      expect(f.contexts).toHaveLength(1);
      expect(f.state()?.status).toBe("failed");
    } finally {
      await f.close();
    }
  });
}

test("When native Pi compacts a running Goal, the Goal shall continue without owning compaction", async () => {
  const f = await fixture({ compaction: true });
  try {
    await f.run(
      "/goal start Finish after native compaction | Check passes",
      {
        content: [{ type: "text", text: "Progress recorded. ".repeat(200) }],
        usage: {
          ...fauxAssistantMessage("").usage,
          input: f.contextWindow,
          totalTokens: f.contextWindow,
        },
      },
      done(),
    );
    expect(f.summaries).toBeGreaterThan(0);
    expect(f.events.filter((e) => e === "compaction_start")).toEqual(["compaction_start"]);
    expect(f.events.filter((e) => e === "agent_settled")).toHaveLength(1);
    expect(
      f.runtime.session.sessionManager.getBranch().filter((e) => e.type === "compaction"),
    ).toHaveLength(1);
    expect(f.state()).toMatchObject({ status: "completed", continuations: 1 });
  } finally {
    await f.close();
  }
});
