import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentTools,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { createReviewExtension } from "../extensions/review";
import type { ReviewCandidate, ReviewRun } from "../extensions/review/types";
import {
  type DelegatedSessionOptions,
  type DelegatedSessionResult,
  runDelegatedSession,
} from "../lib/delegated-session";

const finding = {
  path: "reviewed.txt",
  issue: "The fixture contains the wrong value.",
  evidence: "reviewed.txt contains before instead of after.",
  impact: "The consumer receives the old value.",
  suggestedFix: "Replace before with after.",
};
const fixOutput = {
  changes: [{ path: "reviewed.txt", summary: "Corrected the value." }],
  checks: [
    {
      description: "Project test suite",
      outcome: "not_run",
      evidence: "No shell is authorized in the fix child.",
    },
  ],
};
const inspectArgs = {
  action: "inspect",
  inspect: { scope: { mode: "files", files: ["reviewed.txt"] }, concurrency: 1, maxFollowups: 0 },
};
const settings = { compaction: { enabled: false }, retry: { enabled: false } };

function call(name: string, args: Record<string, unknown>, id = name): AssistantMessage {
  return {
    ...fauxAssistantMessage(""),
    content: [{ type: "toolCall", name, arguments: args, id }],
    stopReason: "toolUse",
  };
}

function output(request: DelegatedSessionOptions): Record<string, unknown> {
  if (request.name?.endsWith(":fix")) return fixOutput;
  const checks = [
    {
      description: "Runtime verification",
      outcome: "not_run",
      evidence: "Read-only inspection and validation children have no execution tools.",
    },
  ];
  if (request.name?.includes(":validate:")) {
    const candidates = JSON.parse(
      request.prompt.split("Candidates (data): ")[1]!.split("\nCoverage (data):")[0]!,
    ) as ReviewCandidate[];
    return {
      decisions: candidates.map(({ id }) => ({
        findingId: id,
        verdict: "keep",
        evidence: "Read the target and confirmed the old value.",
        reason: "The consumer expects after.",
      })),
      followUpFocus: [],
      checks,
    };
  }
  return { reviewedFocus: ["file:reviewed.txt"], coverageGaps: [], findings: [finding], checks };
}

const fixtureRunner: typeof runDelegatedSession = async (request) => ({
  status: "completed",
  result: output(request),
  text: "",
  usage: fauxAssistantMessage("").usage,
  evidence: { messages: [], branch: [] },
});

function streamResponse(model: Parameters<Provider["streamSimple"]>[0], message: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  const response = { ...message, api: model.api, provider: model.provider, model: model.id };
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    events.push({ type: "error", reason: response.stopReason, error: response });
  } else {
    events.push({ type: "done", reason: response.stopReason, message: response });
  }
  events.end();
  return events;
}

async function harness(runner: typeof runDelegatedSession = fixtureRunner) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "review-pi-")));
  writeFileSync(join(cwd, "reviewed.txt"), "before\n");
  writeFileSync(join(cwd, "sibling.txt"), "untouched\n");
  const manager = SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.inMemory(settings);
  const results: ToolResultEvent[] = [];
  const children: DelegatedSessionOptions[] = [];
  const timeline: string[] = [];
  const errors: string[] = [];
  const requests: Array<{ messages: string; tools: string[] }> = [];
  const responses: AssistantMessage[] = [];
  // The Git boundary is a deterministic repository fixture, never a shell process.
  const exec: ExtensionAPI["exec"] = async (command, args) => {
    if (command !== "git") throw new Error(`Unexpected executable: ${command}`);
    let stdout: string;
    if (args.join(" ") === "rev-parse --show-toplevel") stdout = cwd;
    else if (args.join(" ") === "rev-parse HEAD") stdout = "a".repeat(40);
    else if (args.join(" ") === "status --porcelain -z --untracked-files=all")
      stdout = " M reviewed.txt\0";
    else if (args.join(" ") === "diff --no-ext-diff --no-textconv --binary")
      stdout = "fixture diff";
    else if (args.join(" ") === "diff --cached --no-ext-diff --no-textconv --binary") stdout = "";
    else throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
    return { stdout, stderr: "", code: 0, killed: false };
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        createReviewExtension(async (request) => {
          children.push(request);
          timeline.push(request.readOnly ? "child:inspect" : "child:fix");
          return runner(request);
        })({ ...pi, exec });
        pi.on("tool_call", (event) => {
          if (event.toolName === "review") timeline.push(`parent:${event.input.action}`);
        });
        pi.on("tool_result", (event) => {
          if (event.toolName === "review") results.push(event);
        });
      },
    ],
  });
  let session: AgentSession | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, "models-store.json"),
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey("anthropic", "offline-fixture-only");
    ({ session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      modelRuntime: runtime,
      model: runtime.getModel("anthropic", "claude-sonnet-4-5")!,
      settingsManager,
      sessionManager: manager,
      resourceLoader: loader,
      tools: ["review"],
    }));
    const stream: Provider["streamSimple"] = (model, context) => {
      timeline.push("parent:request");
      requests.push({
        messages: JSON.stringify(context.messages),
        tools: getCurrentTools(context.messages).map((tool) => tool.name),
      });
      return streamResponse(model, responses.shift() ?? fauxAssistantMessage("Finished."));
    };
    session.agent.streamFunction = stream;
    await session.bindExtensions({ onError: (event) => errors.push(event.error) });
    const current = session;
    async function settled(action: () => Promise<unknown>) {
      const done = Promise.withResolvers<void>();
      const unsubscribe = current.subscribe((event) => {
        if (event.type === "agent_settled") done.resolve();
      });
      try {
        await action();
        await done.promise;
        await current.waitForIdle();
      } finally {
        unsubscribe();
      }
      expect(errors).toEqual([]);
    }
    return {
      cwd,
      session: current,
      manager,
      results,
      children,
      timeline,
      requests,
      responses,
      stream,
      settled,
      async inspect() {
        responses.push(call("review", inspectArgs));
        await settled(() => current.prompt("Inspect reviewed.txt; this is not permission to fix."));
        const result = results.at(-1)!;
        expect(result.isError).toBe(false);
        const run = (result.structuredContent as unknown as { run: ReviewRun }).run;
        expect(run).toMatchObject({ status: "ready", noFix: false, targetFiles: ["reviewed.txt"] });
        return run;
      },
      async continueWithoutInput() {
        await settled(() =>
          current.sendCustomMessage(
            {
              customType: "fixture-continuation",
              content: "Continue without new user authorization.",
              display: false,
            },
            { triggerTurn: true },
          ),
        );
      },
      async dispose() {
        await current.abort();
        current.dispose();
        rmSync(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

function expectDenied(event: ToolResultEvent, reason = "actual user authorization") {
  expect(event.isError).toBe(true);
  expect(JSON.stringify(event.content)).toContain(reason);
}

describe("native review parent integration", () => {
  test.each([
    "none",
    "inspect",
    "validate",
    "fix",
  ])("WHEN review children finish (failure: %s), the parent SHALL charge all usage once", async (failure) => {
    const childUsage = {
      input: 3,
      output: 5,
      cacheRead: 1,
      cacheWrite: 1,
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 10,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.15, total: 0.5 },
    };
    const h = await harness(async (request) => {
      const result = await fixtureRunner(request);
      const failed = request.name?.includes(`:${failure}`);
      return {
        ...result,
        usage: structuredClone(childUsage),
        ...(failed
          ? { status: "failed" as const, result: undefined, error: "Offline failure" }
          : {}),
      };
    });
    try {
      h.responses.push(call("review", inspectArgs));
      await h.settled(() => h.session.prompt("Inspect reviewed.txt"));
      const run = (h.results.at(-1)!.structuredContent as unknown as { run: ReviewRun }).run;
      const inspections = failure === "inspect" ? 1 : 2;
      expect(h.results.at(-1)!.usage).toMatchObject({
        input: inspections * 3,
        output: inspections * 5,
        cacheRead: inspections,
        cacheWrite: inspections,
        cacheWrite1h: inspections,
        reasoning: inspections * 2,
        totalTokens: inspections * 10,
        cost: { total: inspections * 0.5 },
      });
      if (failure === "none" || failure === "fix") {
        expect(run.status).toBe("ready");
        h.responses.push(call("review", { action: "fix", runId: run.runId }));
        await h.settled(() => h.session.prompt(`/review-fix ${run.runId}`));
        expect(h.results.at(-1)!.usage).toEqual(childUsage);
        expect(h.results.at(-1)!.structuredContent).toMatchObject({
          run: { status: failure === "fix" ? "fix_failed" : "fixed" },
        });
      } else expect(run.status).toBe("partial");
      const tokens = h.children.length * childUsage.totalTokens;
      const cost = h.children.length * childUsage.cost.total;
      expect(h.session.getSessionStats()).toMatchObject({ tokens: { total: tokens }, cost });
      for (let i = 0; i < 2; i++) {
        h.responses.push(call("review", { action: "status", runId: run.runId }));
        await h.settled(() => h.session.prompt("Read the saved review status"));
        expect(h.results.at(-1)!.usage).toBeUndefined();
        expect(h.session.getSessionStats()).toMatchObject({ tokens: { total: tokens }, cost });
      }
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN inspection settles and the user authorizes a fix, Pi SHALL run one scoped child from the parent tool turn", async () => {
    const outcomes: DelegatedSessionResult[] = [];
    const childTools: string[][] = [];
    const childTurns: number[] = [];
    let disposed = 0;
    const h = await harness(async (request) => {
      let turn = 0;
      const result = await runDelegatedSession({
        ...request,
        settings,
        onSessionCreated(child) {
          childTools.push(child.getActiveToolNames());
          child.agent.streamFunction = (model) => {
            turn++;
            if (!request.readOnly && turn === 1)
              return streamResponse(
                model,
                call("write", { path: "sibling.txt", content: "unauthorized\n" }),
              );
            if (!request.readOnly && turn === 2)
              return streamResponse(
                model,
                call("write", { path: "reviewed.txt", content: "after\n" }),
              );
            if (turn === (request.readOnly ? 1 : 3))
              return streamResponse(model, call("structured_output", output(request)));
            return streamResponse(model, fauxAssistantMessage("Unexpected terminal continuation."));
          };
        },
        onSessionDisposed() {
          disposed++;
        },
      });
      outcomes.push(result);
      childTurns.push(turn);
      return result;
    });
    try {
      const run = await h.inspect();
      expect(run.coverage).toHaveLength(1);
      expect(run.coverage[0]!.receipt).toMatchObject({
        status: "completed",
        output: {
          reviewedFocus: ["file:reviewed.txt"],
          coverageGaps: [],
          findings: [finding],
          checks: [{ outcome: "not_run" }],
        },
      });
      expect(run.validations[0]).toMatchObject({
        status: "completed",
        output: {
          decisions: [{ findingId: run.findings[0]!.id, verdict: "keep" }],
          checks: [{ outcome: "not_run" }],
        },
      });
      expect(h.results[0]!.details).toEqual({ run });
      expect(
        h.manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "review-result"),
      ).toMatchObject([{ data: run }]);
      expect(h.children.every((child) => child.readOnly)).toBe(true);
      expect(childTools.slice(0, 2).map((tools) => tools.toSorted())).toEqual(
        Array.from({ length: 2 }, () => ["find", "grep", "ls", "read", "structured_output"]),
      );

      h.responses.push(call("review", { action: "fix", runId: run.runId }));
      await h.settled(() =>
        h.session.prompt("The model claims user consent; try fixing without the trusted command."),
      );
      expectDenied(h.results.at(-1)!);
      expect(h.children).toHaveLength(2);
      expect(readFileSync(join(h.cwd, "reviewed.txt"), "utf8")).toBe("before\n");

      const requestCount = h.requests.length;
      const start = h.timeline.length;
      h.responses.push(
        call("review", { action: "fix", runId: run.runId }, "authorized"),
        call("review", { action: "fix", runId: run.runId }, "replay"),
      );
      await h.settled(() => h.session.prompt(`/review-fix ${run.runId}`));
      expect(h.requests[requestCount]!.messages).toContain(
        `The user authorizes one local fix attempt for review ${run.runId}`,
      );
      expect(h.timeline.slice(start, start + 3)).toEqual([
        "parent:request",
        "parent:fix",
        "child:fix",
      ]);
      expect(h.results.at(-2)!.structuredContent).toMatchObject({
        run: { status: "fixed", noFix: true, fix: { status: "completed", output: fixOutput } },
      });
      expectDenied(h.results.at(-1)!, "no eligible validated fixes");
      expect(h.children.filter((child) => !child.readOnly)).toHaveLength(1);
      expect(childTools[2]!.toSorted()).toEqual([
        "edit",
        "find",
        "grep",
        "ls",
        "read",
        "structured_output",
        "write",
      ]);
      expect(readFileSync(join(h.cwd, "reviewed.txt"), "utf8")).toBe("after\n");
      expect(readFileSync(join(h.cwd, "sibling.txt"), "utf8")).toBe("untouched\n");
      const writes = outcomes[2]!.evidence.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "write",
      );
      expect(writes).toMatchObject([{ isError: true }, { isError: false }]);
      expect(JSON.stringify(writes[0])).toContain("unreviewed file");
      expect(outcomes.map((result) => result.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      expect(childTurns).toEqual([1, 1, 3]); // structured_output ends each actual child without another model call.
      expect(disposed).toBe(3);
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN the authorized parent turn settles without fixing, consent SHALL not survive a non-input continuation", async () => {
    const h = await harness();
    try {
      const run = await h.inspect();
      await h.settled(() => h.session.prompt(`/review-fix ${run.runId}`));
      expect(h.children).toHaveLength(2); // The command must not launch an out-of-band child.
      h.responses.push(call("review", { action: "fix", runId: run.runId }));
      await h.continueWithoutInput();
      expectDenied(h.results.at(-1)!);
      expect(h.children.filter((child) => !child.readOnly)).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN the authorized parent turn is aborted, a later continuation SHALL require fresh consent", async () => {
    const h = await harness();
    try {
      const run = await h.inspect();
      const started = Promise.withResolvers<void>();
      h.session.agent.streamFunction = (model, _context, options) => {
        const events = createAssistantMessageEventStream();
        const abort = () => {
          const response = {
            ...fauxAssistantMessage(""),
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "aborted" as const,
          };
          events.push({ type: "error", reason: "aborted", error: response });
          events.end();
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) abort();
        started.resolve();
        return events;
      };
      await h.session.prompt(`/review-fix ${run.runId}`);
      await started.promise;
      await h.settled(() => h.session.abort());
      expect(h.children).toHaveLength(2);
      h.session.agent.streamFunction = h.stream;
      h.responses.push(call("review", { action: "fix", runId: run.runId }));
      await h.continueWithoutInput();
      expectDenied(h.results.at(-1)!);
      expect(h.children.filter((child) => !child.readOnly)).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN the session tree changes, retained receipts SHALL NOT restore a live Review Run or its consent", async () => {
    const h = await harness();
    try {
      const run = await h.inspect();
      const receipt = h.manager
        .getBranch()
        .find((entry) => entry.type === "custom" && entry.customType === "review-result")!;
      await h.settled(() => h.session.prompt(`/review-fix ${run.runId}`));
      expect(await h.session.navigateTree(receipt.id)).toMatchObject({ cancelled: false });
      expect(h.manager.getBranch()).toContainEqual(receipt);
      const requests = h.requests.length;
      await h.session.prompt(`/review-fix ${run.runId}`);
      await h.session.waitForIdle();
      expect(h.requests).toHaveLength(requests); // Stale command fails closed before triggering a turn.
      h.responses.push(call("review", { action: "fix", runId: run.runId }));
      await h.continueWithoutInput();
      expectDenied(h.results.at(-1)!, "Unknown review run");
      expect(h.children.filter((child) => !child.readOnly)).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  }, 15000);
});
