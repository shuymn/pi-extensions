import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePi as createSharedFakePi,
  type ExecCall,
  type ExecResult,
  type FakePi,
  shutdownFakePis,
} from "../../tests/support/fake-pi";
import { createFakeUi, type FakeUi } from "../../tests/support/fake-ui";
import { installTypeboxMock } from "../../tests/support/typebox-mock";
import type { ReviewWorkflowLifecycleEvent, ReviewWorkflowLifecycleStatus } from "./index";

installTypeboxMock();

type CommandHandler = (args: string, ctx: FakeCommandContext) => Promise<void> | void;
type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptGuidelines: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: {
      files?: string[];
      staged?: boolean;
      noFix?: boolean;
      base?: string;
      pr?: string;
      instructions?: string;
    } & Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: FakeRunContext,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: any;
  }>;
};
type FakeRunContext = { cwd: string; ui: FakeUi };
type FakeCommandContext = FakeRunContext & { waitForIdle: () => Promise<void> };
const tempDirs: string[] = [];
const createdPis: FakePi[] = [];

function defaultExec(call: ExecCall): ExecResult {
  const args = call.args.join(" ");
  if (call.command === "git" && args === "diff --name-status -z") {
    return {
      code: 0,
      stdout: "M\0src/app.ts\0R100\0old.ts\0new.ts\0",
      stderr: "",
    };
  }
  if (call.command === "git" && args === "diff --cached --name-status -z") {
    return { code: 0, stdout: "A\0src/staged.ts\0", stderr: "" };
  }
  if (call.command === "git" && args === "ls-files --others --exclude-standard -z") {
    return { code: 0, stdout: "notes.txt\0", stderr: "" };
  }
  if (call.command === "git" && args.startsWith("-c core.quotepath=false diff HEAD --")) {
    return {
      code: 0,
      stdout: "diff --git a/src/app.ts b/src/app.ts\n+changed\n",
      stderr: "",
    };
  }
  if (call.command === "git" && args.startsWith("-c core.quotepath=false diff --cached --")) {
    return {
      code: 0,
      stdout: "diff --git a/src/staged.ts b/src/staged.ts\n+staged\n",
      stderr: "",
    };
  }
  return { code: 1, stdout: "", stderr: `unexpected git ${args}` };
}

function createFakePi(
  execHandler: (call: ExecCall) => ExecResult | Promise<ExecResult> = defaultExec,
) {
  const pi = createSharedFakePi<ToolDefinition, { description: string; handler: CommandHandler }>({
    exec: (call) => {
      if (call.command === "git" || call.command === "gh") {
        expect(call.options).toMatchObject({
          cwd: expect.any(String),
          timeout: 10_000,
        });
      }
      return execHandler(call);
    },
  });
  createdPis.push(pi);
  return pi;
}

function createUi(): FakeUi {
  return createFakeUi();
}

function createRunContext(cwd = "/repo"): FakeRunContext {
  return { cwd, ui: createUi() };
}

function createCommandContext(cwd = "/repo"): FakeCommandContext & { waited: { value: boolean } } {
  const waited = { value: false };
  return {
    ...createRunContext(cwd),
    waited,
    async waitForIdle() {
      waited.value = true;
    },
  };
}

async function loadExtensionModule() {
  return import("./index");
}

async function loadExtension() {
  const { createReviewExtension } = await loadExtensionModule();
  return createReviewExtension();
}

async function setupReviewTest(execHandler?: (call: ExecCall) => ExecResult | Promise<ExecResult>) {
  const extension = await loadExtension();
  const pi = createFakePi(execHandler);
  extension(pi as never);
  return pi;
}

async function advancePhase(
  pi: FakePi,
  ctx: FakeRunContext,
  content: unknown = "done",
  stopReason?: string,
) {
  await pi.getEventHandlers("agent_end")?.[0](
    { messages: [{ role: "assistant", content, stopReason }] },
    ctx,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "review-extension-test-"));
  tempDirs.push(dir);
  return dir;
}

async function shutdownAllRuns() {
  await shutdownFakePis(createdPis, createRunContext());
}

afterEach(async () => {
  await shutdownAllRuns();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("review extension", () => {
  test("registers command and tool with schema and guidance", async () => {
    const pi = await setupReviewTest();

    expect([...pi.commands.keys()]).toEqual(["review"]);
    expect(pi.commands.get("review")?.description).toContain("multi-stage code review workflow");
    expect(pi.getEventHandlers("agent_end")).toHaveLength(1);
    expect(pi.getEventHandlers("session_shutdown")).toHaveLength(1);
    expect(pi.getEventHandlers("tool_call")).toHaveLength(1);
    const tool = pi.tools.get("review")!;
    expect(tool.label).toBe("Review");
    expect(tool.promptGuidelines.join("\n")).toContain(
      "Use noFix when the user asks to report findings without fixing",
    );
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        files: { type: "array", optional: true },
        staged: { type: "boolean", optional: true },
        base: { type: "string", optional: true },
        pr: { type: "string", optional: true },
        noFix: { type: "boolean", optional: true },
        instructions: { type: "string", optional: true },
      },
    });
    expect(pi.tools.has("review_phase_artifact")).toBe(false);
    expect(pi.tools.has("review_phase_artifact_patch")).toBe(false);
  });

  test("exports workflow lifecycle event contract", async () => {
    const module = await loadExtensionModule();
    const status: ReviewWorkflowLifecycleStatus = "started";
    const payload = {
      name: module.REVIEW_WORKFLOW_EVENT_NAME,
      status,
      runId: "run-1",
      cwd: "/repo",
      targets: [{ path: "src/app.ts", status: "explicit", source: "explicit" }],
      phaseCount: 9,
      noFix: false,
      scope: { kind: "explicit", files: ["src/app.ts"] },
    } satisfies ReviewWorkflowLifecycleEvent;

    expect(module.REVIEW_WORKFLOW_EVENT_NAME).toBe("review");
    expect(module.WORKFLOW_STARTED_EVENT).toBe("workflow:started");
    expect(module.WORKFLOW_COMPLETED_EVENT).toBe("workflow:completed");
    expect(module.WORKFLOW_FAILED_EVENT).toBe("workflow:failed");
    expect(module.WORKFLOW_CANCELLED_EVENT).toBe("workflow:cancelled");
    expect(payload).toMatchObject({ name: "review", status: "started" });
  });

  test("tool explicit-file mode queues the first phase without inspecting git status", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();

    const result = await pi.tools
      .get("review")!
      .execute("call", { files: ["@src/app.ts", "docs/readme.md"] }, undefined, undefined, ctx);

    expect(pi.execCalls).toEqual([]);
    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.sentMessages[0].message).toMatchObject({
      customType: "review-command",
      display: false,
      details: { phase: "01-recon.md", phaseIndex: 1, phaseCount: 9 },
    });
    expect(pi.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(pi.sentMessages[0].message.content).toContain(
      "Explicit file mode: git diff is intentionally ignored",
    );
    expect(pi.sentMessages[0].message.content).toContain('- "src/app.ts" (explicit)');
    expect(result.content[0].text).toContain("Queued review workflow");
    expect(result.details.targets).toEqual([
      { path: "src/app.ts", status: "explicit", source: "explicit" },
      { path: "docs/readme.md", status: "explicit", source: "explicit" },
    ]);
    expect(pi.emittedEvents).toEqual([
      {
        name: "workflow:started",
        data: expect.objectContaining({
          name: "review",
          status: "started",
          runId: result.details.runId,
          cwd: "/repo",
          targets: result.details.targets,
          phaseCount: 9,
          noFix: false,
        }),
      },
    ]);
    expect(ctx.ui.widgets[0]).toMatchObject({
      key: "review-workflow",
      lines: ["● Review 1/9 running", "└─ ◐ Recon running"],
      options: { placement: "aboveEditor" },
    });
  });

  test("tool collects unstaged, staged, renamed, and untracked targets with diff context", async () => {
    const cwd = await createTempDir();
    await writeFile(join(cwd, "notes.txt"), "untracked notes");
    const pi = await setupReviewTest();
    const ctx = createRunContext(cwd);

    const result = await pi.tools.get("review")!.execute("call", {}, undefined, undefined, ctx);

    expect(result.details.targets).toEqual([
      { path: "src/app.ts", status: "M", source: "diff" },
      { path: "new.ts", oldPath: "old.ts", status: "R100", source: "diff" },
      { path: "src/staged.ts", status: "A", source: "diff" },
      { path: "notes.txt", status: "untracked", source: "diff" },
    ]);
    const prompt = pi.sentMessages[0].message.content;
    expect(prompt).toContain('"old.ts" -> "new.ts" (R100; diff)');
    expect(prompt).toContain("## Combined diff against HEAD");
    expect(prompt).toContain('## Untracked file: "notes.txt"');
    expect(prompt).toContain("untracked notes");
  });

  test("base mode reviews branch diff against the selected base", async () => {
    const pi = await setupReviewTest((call) => {
      const args = call.args.join(" ");
      if (call.command === "git" && args === "diff --name-status -z main...HEAD") {
        return { code: 0, stdout: "M\0src/app.ts\0A\0src/new.ts\0", stderr: "" };
      }
      if (
        call.command === "git" &&
        args === "-c core.quotepath=false diff main...HEAD -- src/app.ts src/new.ts"
      ) {
        return { code: 0, stdout: "branch diff", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected git ${args}` };
    });

    const result = await pi.tools
      .get("review")!
      .execute("call", { base: " main " }, undefined, undefined, createRunContext());

    expect(pi.execCalls.map((call) => call.args.join(" "))).toEqual([
      "diff --name-status -z main...HEAD",
      "-c core.quotepath=false diff main...HEAD -- src/app.ts src/new.ts",
    ]);
    expect(result.details.targets).toEqual([
      { path: "src/app.ts", status: "M", source: "diff" },
      { path: "src/new.ts", status: "A", source: "diff" },
    ]);
    const prompt = pi.sentMessages[0].message.content;
    expect(prompt).toContain('Review the branch diff from "main...HEAD"');
    expect(prompt).toContain('## Diff against "main"\n\nbranch diff');
    expect(prompt).not.toContain("Combined diff against HEAD");
    expect(pi.emittedEvents[0].data).toMatchObject({ scope: { kind: "base", base: "main" } });
  });

  test("pr mode reviews the selected pull request when local HEAD matches a clean worktree", async () => {
    const pi = await setupReviewTest((call) => {
      const args = call.args.join(" ");
      if (call.command === "gh" && args === "pr view 123 --json files,headRefOid") {
        return {
          code: 0,
          stdout: JSON.stringify({ files: [{ path: "src/app.ts" }], headRefOid: "abc123" }),
          stderr: "",
        };
      }
      if (call.command === "git" && args === "rev-parse HEAD") {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      if (call.command === "gh" && args === "pr diff 123 --patch") {
        return { code: 0, stdout: "pr diff", stderr: "" };
      }
      if (call.command === "git" && args === "status --porcelain") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${call.command} ${args}` };
    });

    const result = await pi.tools
      .get("review")!
      .execute("call", { pr: " 123 " }, undefined, undefined, createRunContext());

    expect(pi.execCalls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "gh pr view 123 --json files,headRefOid",
      "git rev-parse HEAD",
      "gh pr diff 123 --patch",
      "git status --porcelain",
    ]);
    expect(result.details).toMatchObject({
      targets: [{ path: "src/app.ts", status: "pr", source: "pr" }],
      noFix: false,
    });
    expect(result.details).toMatchObject({ scope: { kind: "pr", selector: "123" }, phaseCount: 9 });
    expect(result.details.noFixReason).toBeUndefined();
    expect("noFixReason" in pi.sentMessages[0].message.details).toBe(false);
    const prompt = pi.sentMessages[0].message.content;
    expect(prompt).toContain('Review pull request "123"');
    expect(prompt).toContain("The local checkout matches the PR head");
    expect(prompt).toContain('## Pull request diff for "123"\n\npr diff');
    expect(pi.sentMessages[0].message.details).toMatchObject({ noFix: false });
    expect(pi.emittedEvents[0].data).toMatchObject({
      scope: { kind: "pr", selector: "123" },
      noFix: false,
    });
  });

  test("pr mode downgrades to no-fix when local HEAD does not match", async () => {
    const pi = await setupReviewTest((call) => {
      const args = call.args.join(" ");
      if (call.command === "gh" && args === "pr view 123 --json files,headRefOid") {
        return {
          code: 0,
          stdout: JSON.stringify({ files: [{ path: "src/app.ts" }], headRefOid: "pr123" }),
          stderr: "",
        };
      }
      if (call.command === "git" && args === "rev-parse HEAD") {
        return { code: 0, stdout: "local456\n", stderr: "" };
      }
      if (call.command === "gh" && args === "pr diff 123 --patch") {
        return { code: 0, stdout: "pr diff", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${call.command} ${args}` };
    });

    const result = await pi.tools
      .get("review")!
      .execute("call", { pr: "123" }, undefined, undefined, createRunContext());

    const noFixReason = {
      kind: "pr_head_mismatch",
      prHeadOid: "pr123",
      localHeadOid: "local456",
    };
    expect(result.details).toMatchObject({
      noFix: true,
      noFixReason,
      targets: [{ path: "src/app.ts", status: "pr", source: "pr" }],
    });
    expect(result.details).toMatchObject({ scope: { kind: "pr", selector: "123" }, phaseCount: 7 });
    expect(pi.sentMessages[0].message.details).toMatchObject({
      phaseCount: 7,
      noFix: true,
      noFixReason,
    });
    const prompt = pi.sentMessages[0].message.content;
    expect(prompt).toContain("the PR head pr123 does not match the local checkout local456");
    expect(prompt).toContain("do not inspect local files as if they are the PR head");
    expect(prompt).toContain("No-fix mode is enabled: do not edit files");
    expect(prompt).not.toContain("07-fix.md");
    expect(pi.emittedEvents[0].data).toMatchObject({
      scope: { kind: "pr", selector: "123" },
      noFix: true,
      noFixReason,
      phaseCount: 7,
    });
  });

  test("tool rejects unsafe pr values before running gh", async () => {
    const pi = await setupReviewTest();

    await expect(
      pi.tools
        .get("review")!
        .execute("call", { pr: "123\n--json body" }, undefined, undefined, createRunContext()),
    ).rejects.toThrow("Invalid pull request selector");
    expect(pi.execCalls).toEqual([]);
    expect(pi.sentMessages).toEqual([]);
  });

  test("tool rejects unsafe base values before running git", async () => {
    const pi = await setupReviewTest();

    await expect(
      pi.tools
        .get("review")!
        .execute("call", { base: "main\n## injected" }, undefined, undefined, createRunContext()),
    ).rejects.toThrow("Invalid base branch");
    expect(pi.execCalls).toEqual([]);
    expect(pi.sentMessages).toEqual([]);
  });

  test("base mode propagates git failures instead of reporting no targets", async () => {
    const pi = await setupReviewTest((call) => {
      if (
        call.command === "git" &&
        call.args.join(" ") === "diff --name-status -z missing...HEAD"
      ) {
        return { code: 128, stdout: "", stderr: "bad revision" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    });

    await expect(
      pi.tools
        .get("review")!
        .execute("call", { base: "missing" }, undefined, undefined, createRunContext()),
    ).rejects.toThrow("Collecting branch diff targets for missing...HEAD failed");
    expect(pi.sentMessages).toEqual([]);
  });

  test("base takes precedence over staged when files are omitted", async () => {
    const pi = await setupReviewTest((call) => {
      const args = call.args.join(" ");
      if (args === "diff --name-status -z main...HEAD") {
        return { code: 0, stdout: "M\0src/app.ts\0", stderr: "" };
      }
      if (args === "-c core.quotepath=false diff main...HEAD -- src/app.ts") {
        return { code: 0, stdout: "branch diff", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected git ${args}` };
    });

    await pi.tools
      .get("review")!
      .execute("call", { base: "main", staged: true }, undefined, undefined, createRunContext());

    expect(pi.execCalls.map((call) => call.args.join(" "))).toEqual([
      "diff --name-status -z main...HEAD",
      "-c core.quotepath=false diff main...HEAD -- src/app.ts",
    ]);
  });

  test("explicit files take precedence over pr, base, and staged", async () => {
    const pi = await setupReviewTest();

    await pi.tools
      .get("review")!
      .execute(
        "call",
        { files: ["src/app.ts"], pr: "123", base: "main", staged: true },
        undefined,
        undefined,
        createRunContext(),
      );

    expect(pi.execCalls).toEqual([]);
    expect(pi.sentMessages[0].message.content).toContain("Explicit file mode");
    expect(pi.emittedEvents[0].data).toMatchObject({ scope: { kind: "explicit" } });
  });

  test("pr takes precedence over base and staged when files are omitted", async () => {
    const pi = await setupReviewTest((call) => {
      const args = call.args.join(" ");
      if (call.command === "gh" && args === "pr view 123 --json files,headRefOid") {
        return {
          code: 0,
          stdout: JSON.stringify({ files: [{ path: "src/app.ts" }], headRefOid: "abc123" }),
          stderr: "",
        };
      }
      if (call.command === "git" && args === "rev-parse HEAD") {
        return { code: 0, stdout: "abc123\n", stderr: "" };
      }
      if (call.command === "gh" && args === "pr diff 123 --patch") {
        return { code: 0, stdout: "pr diff", stderr: "" };
      }
      if (call.command === "git" && args === "status --porcelain") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${call.command} ${args}` };
    });

    await pi.tools
      .get("review")!
      .execute(
        "call",
        { pr: "123", base: "main", staged: true },
        undefined,
        undefined,
        createRunContext(),
      );

    expect(pi.execCalls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "gh pr view 123 --json files,headRefOid",
      "git rev-parse HEAD",
      "gh pr diff 123 --patch",
      "git status --porcelain",
    ]);
    expect(pi.emittedEvents[0].data).toMatchObject({ scope: { kind: "pr", selector: "123" } });
  });

  test("keeps non-ASCII paths readable in review diff context", async () => {
    const pi = await setupReviewTest((call) => {
      const args = call.args.join(" ");
      if (call.command === "git" && args === "diff --name-status -z")
        return { code: 0, stdout: "M\0src/日本語ファイル.ts\0", stderr: "" };
      if (call.command === "git" && args === "diff --cached --name-status -z")
        return { code: 0, stdout: "", stderr: "" };
      if (call.command === "git" && args === "ls-files --others --exclude-standard -z")
        return { code: 0, stdout: "", stderr: "" };
      if (
        call.command === "git" &&
        args === "-c core.quotepath=false diff HEAD -- src/日本語ファイル.ts"
      ) {
        return {
          code: 0,
          stdout: "diff --git a/src/日本語ファイル.ts b/src/日本語ファイル.ts\n+changed\n",
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected git ${args}` };
    });

    await pi.tools.get("review")!.execute("call", {}, undefined, undefined, createRunContext());

    const prompt = pi.sentMessages[0].message.content;
    expect(prompt).toContain("src/日本語ファイル.ts");
    expect(prompt).not.toContain("\\351");
    expect(prompt).not.toContain("\\344");
  });

  test("staged mode reviews only cached changes and reports no-target cases", async () => {
    const pi = await setupReviewTest((call) => {
      if (call.command === "git" && call.args.join(" ") === "diff --cached --name-status -z")
        return { code: 0, stdout: "A\0staged.ts\0", stderr: "" };
      if (
        call.command === "git" &&
        call.args.join(" ").startsWith("-c core.quotepath=false diff --cached --")
      )
        return { code: 0, stdout: "+cached", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });

    await pi.tools
      .get("review")
      ?.execute("call", { staged: true }, undefined, undefined, createRunContext());

    expect(pi.execCalls.map((call) => call.args.join(" "))).toEqual([
      "diff --cached --name-status -z",
      "-c core.quotepath=false diff --cached -- staged.ts",
    ]);
    await shutdownAllRuns();

    const emptyPi = await setupReviewTest(() => ({ code: 0, stdout: "", stderr: "" }));
    const result = await emptyPi.tools
      .get("review")
      ?.execute("call", {}, undefined, undefined, createRunContext());

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "No changed files found for review. Pass explicit files to review whole files.",
        },
      ],
      details: { targets: [] },
    });
    expect(emptyPi.sentMessages).toEqual([]);
  });

  test("read-only phases block mutating tools and force subagents to read-only", async () => {
    const pi = await setupReviewTest();
    await pi.tools
      .get("review")
      ?.execute("call", { files: ["src/app.ts"] }, undefined, undefined, createRunContext());

    const { INVESTIGATION_ALLOWED_TOOL_NAMES } = await loadExtensionModule();
    for (const toolName of INVESTIGATION_ALLOWED_TOOL_NAMES) {
      await expect(
        pi.getEventHandlers("tool_call")?.[0]({
          toolName,
          input: {},
        }),
      ).resolves.toBeUndefined();
    }
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "review_phase_artifact",
        input: {},
      }),
    ).resolves.toEqual({
      block: true,
      reason:
        "/review investigation phases are read-only. This tool is allowed only in Fix and Verify phases.",
    });
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "review_phase_artifact_patch",
        input: {},
      }),
    ).resolves.toEqual({
      block: true,
      reason:
        "/review investigation phases are read-only. This tool is allowed only in Fix and Verify phases.",
    });
    const subagentEvent: { toolName: string; input: Record<string, unknown> } = {
      toolName: "spawn_subagent",
      input: { prompt: "inspect" },
    };
    await expect(pi.getEventHandlers("tool_call")?.[0](subagentEvent)).resolves.toBeUndefined();
    expect(subagentEvent.input).toEqual({ prompt: "inspect", readOnly: true });
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "bash",
        input: { command: "sed -n '1,120p' review/index.ts" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "edit",
        input: {},
      }),
    ).resolves.toEqual({
      block: true,
      reason:
        "/review investigation phases are read-only. This tool is allowed only in Fix and Verify phases.",
    });
  });

  test("input during active workflow is handled with cancellation guidance", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();

    await pi.tools
      .get("review")!
      .execute("call", { files: ["src/app.ts"] }, undefined, undefined, ctx);

    const inputCtx = createRunContext();
    const result = await pi.getEventHandlers("input")[0]?.(
      { text: "add this after review", source: "interactive" },
      inputCtx,
    );

    expect(result).toEqual({ action: "handled" });
    expect(inputCtx.ui.notifications).toEqual([
      {
        message:
          "/review: ワークフロー実行中の追加入力は保留できません。中止する場合は /review cancel を実行してください。",
        level: "warning",
      },
    ]);
  });

  test("agent abort cancels active workflow instead of advancing phase", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();

    await pi.tools
      .get("review")!
      .execute("call", { files: ["src/app.ts"] }, undefined, undefined, ctx);

    await advancePhase(pi, ctx, [], "aborted");

    expect(pi.sentMessages).toHaveLength(1);
    expect(pi.emittedEvents.at(-1)).toMatchObject({
      name: "workflow:cancelled",
      data: { name: "review", status: "cancelled", reason: "user_cancelled" },
    });
    expect(ctx.ui.notifications.at(-1)?.message).toMatch(
      /^\/review: ワークフロー \d+ をキャンセルしました。$/,
    );

    const retry = await pi.tools
      .get("review")!
      .execute("call", { files: ["src/app.ts"] }, undefined, undefined, createRunContext());
    expect(retry.content[0].text).toContain("Queued review workflow");
  });

  test("agent_end stores phase notes, advances phases, and completes workflow", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();
    await pi.tools
      .get("review")
      ?.execute("call", { files: ["src/app.ts"] }, undefined, undefined, ctx);

    await advancePhase(pi, ctx, [{ type: "text", text: "recon notes" }]);

    expect(pi.sentMessages).toHaveLength(2);
    expect(pi.sentMessages[1].message.details.phase).toBe("02-hunt.md");
    expect(pi.sentMessages[1].message.content).toContain("Completed phase 1: 01-recon.md");
    expect(pi.sentMessages[1].message.content).toContain("recon notes");
    expect(ctx.ui.widgets.at(-2)).toMatchObject({
      lines: ["● Review 2/9 queued", "├─ ✓ Recon", "└─ ○ Hunt queued"],
      options: { placement: "aboveEditor" },
    });
    expect(ctx.ui.widgets.at(-1)).toMatchObject({
      lines: ["● Review 2/9 running", "├─ ✓ Recon", "└─ ◐ Hunt running"],
      options: { placement: "aboveEditor" },
    });

    for (let index = 2; index <= 9; index += 1) {
      await advancePhase(pi, ctx, `phase ${index} done`);
    }

    expect(ctx.ui.notifications.at(-1)?.message).toMatch(
      /^\/review: ワークフロー \d+ が完了しました。$/,
    );
    expect(pi.emittedEvents.map((event) => event.name)).toEqual([
      "workflow:started",
      "workflow:completed",
    ]);
    expect(pi.emittedEvents.at(-1)?.data).toMatchObject({
      name: "review",
      status: "completed",
      cwd: "/repo",
      targets: [{ path: "src/app.ts", status: "explicit", source: "explicit" }],
      phaseCount: 9,
      noFix: false,
    });
    expect(ctx.ui.widgets.at(-1)).toEqual({
      key: "review-workflow",
      lines: undefined,
      options: undefined,
    });
  });

  test("gapfill control can loop back to hunt but is capped", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();
    await pi.tools
      .get("review")
      ?.execute("call", { files: ["src/app.ts"] }, undefined, undefined, ctx);

    // Finish Recon, Hunt, Validate, then Gapfill with continue_hunt.
    for (const text of ["recon", "hunt", "validate"]) {
      await advancePhase(pi, ctx, text);
    }
    await advancePhase(
      pi,
      ctx,
      '## Follow-up Hunt focus\n\nCheck q.\n\n<review_control>{"continue_hunt":true}</review_control>',
    );

    expect(pi.sentMessages.at(-1)?.message.details.phase).toBe("02-hunt.md");

    // Second gapfill loop is still allowed; third one advances to Dedupe.
    for (const expected of ["02-hunt.md", "05-dedupe.md"]) {
      await advancePhase(pi, ctx, "hunt again");
      await advancePhase(pi, ctx, "validate again");
      await advancePhase(
        pi,
        ctx,
        '## Follow-up Hunt focus\n\nCheck q.\n\n<review_control>{"continue_hunt":true}</review_control>',
      );
      expect(pi.sentMessages.at(-1)?.message.details.phase).toBe(expected);
    }
  });

  test("normal-mode verify phase permits mutating tools and summary phase is read-only", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();
    await pi.tools
      .get("review")
      ?.execute("call", { files: ["src/app.ts"] }, undefined, undefined, ctx);

    for (let index = 1; index <= 7; index += 1) {
      await advancePhase(pi, ctx, `phase ${index}`);
    }

    expect(pi.sentMessages.at(-1)?.message.details.phase).toBe("08-verify.md");
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "bash",
        input: { command: "echo hi" },
      }),
    ).resolves.toBeUndefined();

    await advancePhase(pi, ctx, "phase 8");

    expect(pi.sentMessages.at(-1)?.message.details.phase).toBe("09-summary.md");
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "bash",
        input: { command: "echo hi" },
      }),
    ).resolves.toBeUndefined();
  });

  test("sendMessage failure clears active run during initial dispatch", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();
    pi.sendMessage = () => {
      throw new Error("send failed");
    };

    await expect(
      pi.tools.get("review")?.execute("call", { files: ["src/app.ts"] }, undefined, undefined, ctx),
    ).rejects.toThrow("send failed");

    expect(ctx.ui.notifications).toContainEqual({
      message: "/review: ワークフローの phase をキューに追加できませんでした。",
      level: "error",
    });
    expect(ctx.ui.widgets.at(-1)).toEqual({
      key: "review-workflow",
      lines: undefined,
      options: undefined,
    });
    expect(pi.emittedEvents.map((event) => event.name)).toEqual([
      "workflow:started",
      "workflow:failed",
    ]);
    expect(pi.emittedEvents.at(-1)?.data).toMatchObject({
      name: "review",
      status: "failed",
      cwd: "/repo",
      targets: [{ path: "src/app.ts", status: "explicit", source: "explicit" }],
      phaseCount: 9,
      noFix: false,
      error: "send failed",
    });
  });

  test("command handles initial sendMessage failure without rethrowing", async () => {
    const pi = await setupReviewTest();
    const ctx = createCommandContext();
    pi.sendMessage = () => {
      throw new Error("send failed");
    };

    await expect(pi.commands.get("review")?.handler("@src/app.ts", ctx)).resolves.toBeUndefined();

    expect(ctx.ui.notifications).toContainEqual({
      message: "/review: ワークフローの phase をキューに追加できませんでした。",
      level: "error",
    });
    expect(ctx.ui.notifications).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("phase 1/"),
          level: "info",
        }),
      ]),
    );
    expect(ctx.ui.widgets.at(-1)).toEqual({
      key: "review-workflow",
      lines: undefined,
      options: undefined,
    });
    expect(pi.emittedEvents.map((event) => event.name)).toEqual([
      "workflow:started",
      "workflow:failed",
    ]);
  });

  test("sendMessage failure clears active run during next phase dispatch and allows retry", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();
    await pi.tools
      .get("review")
      ?.execute("call", { files: ["src/app.ts"] }, undefined, undefined, ctx);

    const originalSendMessage = pi.sendMessage;
    pi.sendMessage = () => {
      throw new Error("send failed");
    };
    await advancePhase(pi, ctx, "recon");

    expect(ctx.ui.notifications).toContainEqual({
      message: "/review: 次の phase をキューに追加できませんでした。",
      level: "error",
    });
    expect(ctx.ui.widgets.at(-1)).toEqual({
      key: "review-workflow",
      lines: undefined,
      options: undefined,
    });
    expect(pi.emittedEvents.map((event) => event.name)).toEqual([
      "workflow:started",
      "workflow:failed",
    ]);
    expect(pi.emittedEvents.at(-1)?.data).toMatchObject({
      name: "review",
      status: "failed",
      cwd: "/repo",
      targets: [{ path: "src/app.ts", status: "explicit", source: "explicit" }],
      phaseCount: 9,
      noFix: false,
      error: "send failed",
    });

    pi.sendMessage = originalSendMessage;
    const retry = await pi.tools
      .get("review")
      ?.execute("call", { files: ["src/retry.ts"] }, undefined, undefined, createRunContext());
    expect(retry?.content[0].text).toContain("Queued review workflow");
  });

  test("no-fix mode skips fix phases and keeps every phase read-only", async () => {
    const pi = await setupReviewTest();
    const ctx = createRunContext();

    await pi.tools
      .get("review")
      ?.execute("call", { files: ["src/app.ts"], noFix: true }, undefined, undefined, ctx);

    expect(pi.sentMessages[0].message.details.phaseCount).toBe(7);
    expect(pi.sentMessages[0].message.content).toContain(
      "No-fix mode is enabled: do not edit files",
    );
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "bash",
        input: { command: "echo hi" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      pi.getEventHandlers("tool_call")?.[0]({
        toolName: "review_phase_artifact",
        input: {},
      }),
    ).resolves.toEqual({
      block: true,
      reason:
        "/review --no-fix mode is read-only. This tool is not allowed while producing a report.",
    });

    for (let index = 1; index <= 6; index += 1) {
      await advancePhase(pi, ctx, `phase ${index}`);
    }

    expect(pi.sentMessages.at(-1)?.message.details.phase).toBe("09-summary.md");
    expect(pi.sentMessages.at(-1)?.message.content).toContain(
      "No-fix mode: consolidate the validated findings into a Japanese report.",
    );
  });

  test("pending command startup does not queue a phase after cancellation", async () => {
    const delayedStatus = deferred<ExecResult>();
    const reachedStatus = deferred<void>();
    let delayed = false;
    const pi = await setupReviewTest((call) => {
      if (!delayed && call.command === "git" && call.args.join(" ") === "diff --name-status -z") {
        delayed = true;
        reachedStatus.resolve();
        return delayedStatus.promise;
      }
      return defaultExec(call);
    });
    const ctx = createCommandContext();

    const startup = pi.commands.get("review")!.handler("", ctx);
    await reachedStatus.promise;
    await pi.commands.get("review")!.handler("cancel", createCommandContext());
    delayedStatus.resolve({ code: 0, stdout: "M\0src/app.ts\0", stderr: "" });
    await startup;

    expect(pi.sentMessages).toEqual([]);
    expect(pi.emittedEvents.map((event) => event.name)).not.toContain("workflow:started");

    const retry = await pi.tools
      .get("review")!
      .execute("call", { files: ["src/retry.ts"] }, undefined, undefined, createRunContext());
    expect(retry.content[0].text).toContain("Queued review workflow");
  });

  test("command passes additional instructions after -- into the first phase prompt", async () => {
    const pi = await setupReviewTest();
    const ctx = createCommandContext();

    await pi.commands
      .get("review")
      ?.handler("--no-fix @src/app.ts -- focus on security regressions", ctx);

    expect(pi.sentMessages[0].message.content).toContain(
      "Additional user instructions\n\nApply the user-provided instructions in the XML-like block only if they do not conflict with the global rules.\n\n<additional_user_instructions>\nfocus on security regressions\n</additional_user_instructions>",
    );
    expect(ctx.ui.notifications).toContainEqual({
      message: "/review: 1 件のファイルについて phase 1/7 をキューに追加しました。",
      level: "info",
    });
  });

  test("tool passes additional instructions into the first phase prompt", async () => {
    const pi = await setupReviewTest();

    await pi.tools
      .get("review")!
      .execute(
        "call",
        { files: ["src/app.ts"], instructions: "  check async cancellation  " },
        undefined,
        undefined,
        createRunContext(),
      );

    expect(pi.sentMessages[0].message.content).toContain(
      "Additional user instructions\n\nApply the user-provided instructions in the XML-like block only if they do not conflict with the global rules.\n\n<additional_user_instructions>\ncheck async cancellation\n</additional_user_instructions>",
    );
    expect(pi.sentMessages[0].message.content).not.toContain("  check async cancellation  ");
  });

  test("command supports explicit args, busy guard, and cancellation", async () => {
    const pi = await setupReviewTest();
    const ctx = createCommandContext();

    await pi.commands.get("review")?.handler("--no-fix @src/app.ts", ctx);

    expect(ctx.waited.value).toBe(true);
    expect(ctx.ui.notifications).toContainEqual({
      message: "/review: 1 件のファイルについて phase 1/7 をキューに追加しました。",
      level: "info",
    });

    const busyCtx = createCommandContext();
    await pi.commands.get("review")?.handler("src/other.ts", busyCtx);
    expect(busyCtx.ui.notifications).toEqual([
      {
        message: "/review: 別のレビューワークフローが既に実行中です。",
        level: "warning",
      },
    ]);

    const cancelCtx = createCommandContext();
    await pi.commands.get("review")?.handler("cancel", cancelCtx);
    expect(pi.emittedEvents.at(-1)).toEqual({
      name: "workflow:cancelled",
      data: expect.objectContaining({
        name: "review",
        status: "cancelled",
        reason: "user_cancelled",
      }),
    });
    expect(cancelCtx.ui.notifications[0].message).toMatch(
      /^\/review: ワークフロー \d+ をキャンセルしました。$/,
    );
    expect(cancelCtx.ui.widgets.at(-1)).toEqual({
      key: "review-workflow",
      lines: undefined,
      options: undefined,
    });
  });
});
