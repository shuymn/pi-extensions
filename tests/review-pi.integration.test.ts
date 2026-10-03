import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { createReviewExtension, parseReviewArgs } from "../extensions/review";
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
  blockers: [],
  changes: [{ path: "reviewed.txt", summary: "Corrected the value." }],
  checks: [
    {
      description: "Project test suite",
      outcome: "passed",
      evidence: "Offline fixture verification passed.",
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
    const locator = request.systemPrompt
      .split("\n")
      .find((line) => line.startsWith("Review task artifact (data): "));
    if (!locator) throw new Error("Missing review recovery locator in child system prompt");
    const task = JSON.parse(
      readFileSync(JSON.parse(locator.slice("Review task artifact (data): ".length)), "utf8"),
    ) as { candidates: ReviewCandidate[] };
    const candidates = task.candidates;
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

async function harness(
  runner: typeof runDelegatedSession = fixtureRunner,
  projectShellPrefix?: string,
) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "review-pi-")));
  writeFileSync(join(cwd, "reviewed.txt"), "before\n");
  writeFileSync(join(cwd, "sibling.txt"), "untouched\n");
  if (projectShellPrefix) {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ shellCommandPrefix: projectShellPrefix }),
    );
  }
  const manager = SessionManager.inMemory(cwd);
  const settingsManager = SettingsManager.inMemory(settings, {
    projectTrusted: projectShellPrefix === undefined,
  });
  const results: ToolResultEvent[] = [];
  const children: DelegatedSessionOptions[] = [];
  const timeline: string[] = [];
  const errors: string[] = [];
  const requests: Array<{ messages: string; tools: string[] }> = [];
  const responses: AssistantMessage[] = [];
  // The Git boundary is a deterministic repository fixture, never a shell process.
  const exec: ExtensionAPI["exec"] = async (command, args) => {
    if (command !== "git") throw new Error(`Unexpected executable: ${command}`);
    if (args[0] === "-C") args = args.slice(2);
    let stdout: string;
    if (args.join(" ") === "rev-parse --show-toplevel") stdout = cwd;
    else if (["rev-parse --git-dir", "rev-parse --git-common-dir"].includes(args.join(" ")))
      stdout = join(cwd, ".git");
    else if (args.join(" ") === "rev-parse HEAD") stdout = "a".repeat(40);
    else if (args.join(" ") === "diff --name-only -z") stdout = "reviewed.txt\0";
    else if (
      ["diff --cached --name-only -z", "ls-files --others --exclude-standard -z"].includes(
        args.join(" "),
      )
    )
      stdout = "";
    else if (
      [
        "status --porcelain -z --untracked-files=all",
        "status --porcelain=v1 -z --untracked-files=all",
      ].includes(args.join(" "))
    )
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
        expect(run).toMatchObject({ status: "ready", noFix: true, targetFiles: ["reviewed.txt"] });
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

function expectDenied(event: ToolResultEvent, reason: string) {
  expect(event.isError).toBe(true);
  expect(JSON.stringify(event.content)).toContain(reason);
}

describe("native review task integration", () => {
  test.each([
    "none",
    "inspect",
    "validate",
    "fix",
  ])("WHEN review children settle (failure: %s), all usage SHALL be charged once", async (failure) => {
    const usage = {
      input: 3,
      output: 5,
      cacheRead: 1,
      cacheWrite: 1,
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 10,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.15, total: 0.5 },
    };
    const h = await harness(async (request) => ({
      ...(await fixtureRunner(request)),
      usage: structuredClone(usage),
      ...(request.name?.includes(`:${failure}`)
        ? { status: "failed" as const, result: undefined, error: "Offline failure" }
        : {}),
    }));
    try {
      h.responses.push(call("review", { ...inspectArgs, action: "run" }));
      await h.settled(() => h.session.prompt("Review reviewed.txt"));
      const run = (h.results.at(-1)!.structuredContent as unknown as { run: ReviewRun }).run;
      expect(run.status).toBe(
        failure === "none" ? "fixed" : failure === "fix" ? "fix_failed" : "partial",
      );
      const count = h.children.length;
      expect(h.results.at(-1)!.usage).toMatchObject({
        input: count * 3,
        output: count * 5,
        cacheRead: count,
        cacheWrite: count,
        cacheWrite1h: count,
        reasoning: count * 2,
        totalTokens: count * 10,
        cost: { total: count * 0.5 },
      });
      for (let i = 0; i < 2; i++) {
        h.responses.push(call("review", { action: "status", runId: run.runId }));
        await h.settled(() => h.session.prompt("Read the saved review status"));
        expect(h.results.at(-1)!.usage).toBeUndefined();
        expect(h.session.getSessionStats()).toMatchObject({
          tokens: { total: count * 10 },
          cost: count * 0.5,
        });
      }
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN /review encounters a failed check, it SHALL repair and reverify in the same native child without a human handoff", async () => {
    const outcomes: DelegatedSessionResult[] = [];
    const childTools: string[][] = [];
    let disposed = 0;
    const h = await harness(async (request) => {
      let turn = 0;
      const finalOutput = {
        ...fixOutput,
        changes: [
          ...fixOutput.changes,
          { path: "regression.txt", summary: "Related regression evidence" },
        ],
        checks: [
          {
            description: "test reviewed.txt = verified",
            outcome: "passed",
            evidence: "bash exited 0 after correcting the verification failure",
          },
        ],
      };
      const result = await runDelegatedSession({
        ...request,
        onSessionCreated(child) {
          childTools.push(child.getActiveToolNames());
          child.agent.streamFunction = (model, context) => {
            turn++;
            if (request.readOnly)
              return streamResponse(model, call("structured_output", output(request)));
            const steps = [
              call("write", { path: "reviewed.txt", content: "after\n" }),
              call("bash", { command: 'test "$(head -n1 reviewed.txt)" = verified' }),
              call("read", { path: "reviewed.txt" }),
              call("write", { path: "reviewed.txt", content: "verified\n" }),
              call("write", { path: "regression.txt", content: "related regression\n" }),
              call("bash", { command: 'test "$(head -n1 reviewed.txt)" = verified' }),
              call("structured_output", finalOutput),
            ];
            if (turn === 3) expect(JSON.stringify(context.messages)).toContain("code 1");
            return streamResponse(
              model,
              steps[turn - 1] ?? fauxAssistantMessage("Unexpected continuation"),
            );
          };
        },
        onSessionDisposed() {
          disposed++;
        },
      });
      outcomes.push(result);
      return result;
    }, "printf 'untrusted prefix ran\\n' > sibling.txt");
    try {
      h.responses.push(
        call("review", {
          inspect: { scope: { mode: "files", files: ["sibling.txt"] } },
        }),
      );
      await h.settled(() => h.session.prompt("/review reviewed.txt"));
      const run = (h.results.at(-1)!.structuredContent as unknown as { run: ReviewRun }).run;
      expect(run).toMatchObject({
        status: "fixed",
        targetFiles: ["reviewed.txt"],
        fix: { status: "completed" },
      });
      expect(h.requests[0]!.messages).toContain("No separate fix approval is needed");
      expect(h.children.filter((child) => !child.readOnly)).toHaveLength(1);
      expect(childTools[2]!.toSorted()).toEqual([
        "bash",
        "edit",
        "find",
        "grep",
        "ls",
        "read",
        "structured_output",
        "write",
      ]);
      expect(readFileSync(join(h.cwd, "reviewed.txt"), "utf8")).toBe("verified\n");
      expect(readFileSync(join(h.cwd, "regression.txt"), "utf8")).toBe("related regression\n");
      expect(readFileSync(join(h.cwd, "sibling.txt"), "utf8")).toBe("untouched\n");
      const checks = outcomes[2]!.evidence.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "bash",
      );
      expect(checks).toMatchObject([{ isError: true }, { isError: false }]);
      expect(outcomes.map((result) => result.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      expect(disposed).toBe(3);
      expect(
        h.manager
          .getBranch()
          .filter((entry) => entry.type === "custom" && entry.customType === "review-result"),
      ).toMatchObject([{ data: run }]);
    } finally {
      await h.dispose();
    }
  }, 20000);

  test("WHEN review is requested via the tool without an action, it SHALL include repair by default", async () => {
    const h = await harness();
    try {
      h.responses.push(call("review", { inspect: inspectArgs.inspect }));
      await h.settled(() => h.session.prompt("Review reviewed.txt"));
      expect(h.results.at(-1)!.structuredContent).toMatchObject({ run: { status: "fixed" } });
      expect(h.children).toHaveLength(3);
    } finally {
      await h.dispose();
    }
  }, 15000);

  test.each([
    "inspect",
    "noFix",
    "command",
  ])("WHEN report-only is requested via %s, it SHALL never launch a mutable child", async (entry) => {
    const h = await harness();
    try {
      h.responses.push(
        call("review", {
          action: entry === "inspect" ? "inspect" : "run",
          inspect: { ...inspectArgs.inspect, noFix: entry === "noFix" },
        }),
      );
      await h.settled(() =>
        h.session.prompt(
          entry === "command" ? "/review --no-fix reviewed.txt" : "Review reviewed.txt, no fix",
        ),
      );
      expect(h.results.at(-1)!.structuredContent).toMatchObject({
        run: { status: "ready", noFix: true },
      });
      expect(h.children.every((child) => child.readOnly)).toBe(true);
      expect(readFileSync(join(h.cwd, "reviewed.txt"), "utf8")).toBe("before\n");
    } finally {
      await h.dispose();
    }
  }, 15000);

  test.each([
    "failed",
    "not_run",
  ])("WHEN verification is %s with a concrete blocker, the task SHALL NOT claim fixed", async (outcome) => {
    const h = await harness(async (request) => ({
      ...(await fixtureRunner(request)),
      ...(request.readOnly
        ? {}
        : {
            result: {
              ...fixOutput,
              checks: [
                {
                  description: "PTY verification",
                  outcome,
                  evidence: "Required executable is unavailable",
                },
              ],
              blockers: [
                {
                  kind: "environment",
                  reason: "PTY executable unavailable",
                  nextAction: "Install the required executable and rerun review",
                },
              ],
            },
          }),
    }));
    try {
      h.responses.push(call("review", { action: "run", inspect: inspectArgs.inspect }));
      await h.settled(() => h.session.prompt("Review reviewed.txt"));
      expect(h.results.at(-1)!.structuredContent).toMatchObject({
        run: {
          status: "fix_failed",
          fix: { output: { checks: [{ outcome }], blockers: [{ kind: "environment" }] } },
        },
      });
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN a command turn settles unused, a continuation SHALL NOT inherit its scope or no-fix mode", async () => {
    const h = await harness();
    try {
      await h.settled(() => h.session.prompt("/review --no-fix sibling.txt"));
      h.responses.push(call("review", { ...inspectArgs, action: "run" }));
      await h.continueWithoutInput();
      expect(h.results.at(-1)!.structuredContent).toMatchObject({
        run: { status: "fixed", targetFiles: ["reviewed.txt"], noFix: false },
      });
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN repair is aborted, the child SHALL settle with partial edits without an automatic replay", async () => {
    const started = Promise.withResolvers<void>();
    const h = await harness(async (request) => {
      if (request.readOnly) return fixtureRunner(request);
      writeFileSync(join(request.cwd, "reviewed.txt"), "partial\n");
      started.resolve();
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
        if (request.signal?.aborted) resolve();
      });
      return { ...(await fixtureRunner(request)), status: "cancelled", result: undefined };
    });
    try {
      h.responses.push(call("review", { action: "run", inspect: inspectArgs.inspect }));
      const pending = h.session.prompt("Review reviewed.txt");
      await started.promise;
      await h.session.abort();
      await pending;
      expect(h.children.filter((child) => !child.readOnly)).toHaveLength(1);
      expect(readFileSync(join(h.cwd, "reviewed.txt"), "utf8")).toBe("partial\n");
      expect(h.results.at(-1)!.structuredContent).toMatchObject({
        run: { status: "fix_failed", fix: { status: "aborted" } },
      });
    } finally {
      await h.dispose();
    }
  }, 15000);

  test("WHEN the session tree changes, receipts SHALL NOT restore a live Review Run", async () => {
    const h = await harness();
    try {
      const run = await h.inspect();
      const receipt = h.manager
        .getBranch()
        .find((entry) => entry.type === "custom" && entry.customType === "review-result")!;
      expect(await h.session.navigateTree(receipt.id)).toMatchObject({ cancelled: false });
      expect(h.manager.getBranch()).toContainEqual(receipt);
      h.responses.push(call("review", { action: "status", runId: run.runId }));
      await h.continueWithoutInput();
      expectDenied(h.results.at(-1)!, "Unknown review run");
    } finally {
      await h.dispose();
    }
  }, 15000);
});

test("WHEN /review options select scope, parsing SHALL retain no-fix and reject ambiguous choices", () => {
  expect(parseReviewArgs("")).toEqual({ scope: { mode: "working" }, noFix: false });
  expect(parseReviewArgs("--cached --no-fix")).toEqual({ scope: { mode: "staged" }, noFix: true });
  expect(parseReviewArgs("--base main")).toEqual({
    scope: { mode: "base", base: "main" },
    noFix: false,
  });
  expect(parseReviewArgs("--pr=42 -- security")).toEqual({
    scope: { mode: "pr", pr: "42" },
    noFix: false,
    focus: ["security"],
  });
  for (const args of [
    "--base",
    "--pr=",
    "--staged reviewed.txt",
    "--pr 42 --base main",
    "../outside.txt",
    "--unknown",
  ])
    expect(() => parseReviewArgs(args)).toThrow();
});
