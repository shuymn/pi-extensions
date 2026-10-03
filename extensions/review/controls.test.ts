import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { createReviewControls } from "./controls";
import {
  type ReviewAgentRequest,
  type ReviewAgentResult,
  type ReviewCandidate,
  type ReviewExec,
  ReviewInspectionSchema,
  type ReviewInspectParams,
  ReviewRunSchema,
  ReviewValidationSchema,
} from "./types";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "ffffffffffffffffffffffffffffffffffffffff";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function promptData<T>(prompt: string, prefix: string): T {
  const line = prompt.split("\n").find((item) => item.startsWith(prefix));
  if (!line) throw new Error(`Missing prompt field ${prefix}`);
  return JSON.parse(line.slice(prefix.length)) as T;
}

function successful(request: ReviewAgentRequest): ReviewAgentResult {
  const checks = [
    {
      description: "Runtime verification",
      outcome: "not_run",
      evidence: "Read-only investigation has no execution tools.",
    },
  ];
  if (request.schema === ReviewInspectionSchema) {
    const focus = promptData<string[]>(request.prompt, "Assigned focus (data): ");
    return {
      status: "completed",
      output: {
        reviewedFocus: focus,
        coverageGaps: [],
        checks,
        findings: focus.includes("file:a.ts")
          ? [
              {
                path: "a.ts",
                issue: "reachable failure",
                evidence: "a.ts:1",
                impact: "request fails",
                suggestedFix: "handle empty input",
              },
            ]
          : [],
      },
    };
  }
  if (request.schema === ReviewValidationSchema) {
    const candidates = promptData<ReviewCandidate[]>(request.prompt, "Candidates (data): ");
    return {
      status: "completed",
      output: {
        decisions: candidates.map((finding) => ({
          findingId: finding.id,
          verdict: "keep",
          evidence: "reachable via caller",
          reason: "confirmed against tests",
        })),
        followUpFocus: [],
        checks,
      },
    };
  }
  return {
    status: "completed",
    output: {
      changes: [{ path: "a.ts", summary: "handle empty input" }],
      checks: [{ description: "tests", outcome: "not_run", evidence: "shell unavailable" }],
    },
  };
}

async function fixture(
  options: {
    files?: string[];
    authorized?: boolean;
    runner?: (request: ReviewAgentRequest) => Promise<ReviewAgentResult>;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-controls-"));
  roots.push(cwd);
  const files = options.files ?? ["a.ts"];
  for (const file of files) await writeFile(join(cwd, file), "original\n");
  const state = {
    prHead: HEAD,
    localHead: HEAD,
    status: "",
    diff: "selected diff",
    changedFiles: [...files],
    stagedFiles: [] as string[],
    untrackedFiles: [] as string[],
    fail: "",
    authorized: options.authorized ?? false,
    authCalls: 0,
  };
  const commands: Array<{ kind: string; args: string[]; signal?: AbortSignal }> = [];
  const requests: ReviewAgentRequest[] = [];
  const events: string[] = [];
  const command =
    (kind: string): ReviewExec =>
    async (args, commandOptions) => {
      commands.push({ kind, args, signal: commandOptions.signal });
      events.push(`${kind} ${args.join(" ")}`);
      expect(commandOptions.cwd).toBe(cwd);
      expect(commandOptions.timeout).toBe(10_000);
      if (`${kind} ${args.join(" ")}` === state.fail)
        return { code: 1, stdout: "", stderr: "unavailable" };
      let stdout = "";
      if (kind === "gh") {
        stdout =
          args[1] === "diff"
            ? state.diff
            : JSON.stringify({
                headRefOid: state.prHead,
                files: state.changedFiles.map((path) => ({ path })),
              });
      } else if (args[0] === "rev-parse") {
        stdout = args[1] === "--show-toplevel" ? cwd : state.localHead;
      } else if (args[0] === "status") {
        stdout = state.status;
      } else if (args[0] === "ls-files") {
        stdout = state.untrackedFiles.join("\0");
      } else if (args[0] === "diff") {
        stdout = args.includes("--name-only")
          ? (args.includes("--cached") ? state.stagedFiles : state.changedFiles).join("\0")
          : state.diff;
      } else throw new Error(`Unexpected command ${kind}: ${args.join(" ")}`);
      return { code: 0, stdout, stderr: "" };
    };
  const host = {
    cwd,
    execGit: command("git"),
    execGh: command("gh"),
    runAgent: async (request: ReviewAgentRequest) => {
      requests.push(request);
      events.push(request.readOnly ? "agent readonly" : "agent fix");
      return options.runner ? options.runner(request) : successful(request);
    },
    authorizeFix: async () => {
      state.authCalls++;
      events.push("authorize");
      return state.authorized;
    },
  };
  return { cwd, state, commands, requests, events, host, controls: createReviewControls(host) };
}

async function inspected(f: Awaited<ReturnType<typeof fixture>>, params: ReviewInspectParams = {}) {
  const run = await f.controls.inspect(params);
  expect(run.status).toBe("ready");
  return run;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("host-checked review inspection", () => {
  test("When inspect completes, every file/focus has a deterministic receipt and no mutation runs", async () => {
    const files = Array.from({ length: 8 }, (_, index) => `${String.fromCharCode(97 + index)}.ts`);
    const f = await fixture({ files, authorized: true });
    const run = await inspected(f, { focus: ["security", "failures", "security"] });
    const assigned = run.coverage.map((entry) => entry.focus);
    expect(assigned).toEqual([
      ["file:a.ts", "file:f.ts"],
      ["file:b.ts", "file:g.ts"],
      ["file:c.ts", "file:h.ts"],
      ["file:d.ts", "focus:security"],
      ["file:e.ts", "focus:failures"],
    ]);
    expect(run.findings).toHaveLength(1);
    expect(Check(ReviewRunSchema, run)).toBe(true);
    expect(run.noFix).toBe(false); // Eligibility is not consent or an implicit Fix.
    expect(f.state.authCalls).toBe(0);
    expect(
      f.requests.every(
        (request) => request.readOnly && request.allowedTools.join(",") === "read,grep,find,ls",
      ),
    ).toBe(true);
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe("original\n");
    run.findings.length = 0;
    run.coverage[0]?.focus.push("forged");
    expect(f.controls.status(run.runId).findings).toHaveLength(1);
    expect(f.controls.status(run.runId).coverage[0]?.focus).not.toContain("forged");
  });

  test("When static coverage and validation complete, unrun runtime checks shall remain separate without granting fix consent", async () => {
    const checks = [
      {
        description: "Bun tests and runtime probes",
        outcome: "not_run",
        evidence: "The inspection and validation children have read/search tools only.",
      },
    ];
    const f = await fixture({
      runner: async (request) => {
        const result = successful(request);
        return { ...result, output: { ...(result.output as object), checks } };
      },
    });
    const run = await inspected(f);
    expect(run.noFix).toBe(false);
    expect(run.issues).toEqual([]);
    expect(run.coverage[0]?.receipt.output).toMatchObject({ coverageGaps: [], checks });
    expect(run.validations[0]?.output).toMatchObject({ followUpFocus: [], checks });
    expect(Check(ReviewRunSchema, run)).toBe(true);
    expect(f.controls.status(run.runId)).toEqual(run);
    await expect(f.controls.fix(run.runId)).rejects.toThrow("actual user authorization");
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test.each([
    { scope: { mode: "files", files: ["../outside"] } },
    { scope: { mode: "files", files: ["/absolute"] } },
    { scope: { mode: "files", files: [".git/config"] } },
    { scope: { mode: "files", files: ["a\n.ts"] } },
    { scope: { mode: "files", files: ["a/../b.ts"] } },
    { scope: { mode: "files", files: [] } },
    { scope: { mode: "pr", pr: "-Rother/repo" } },
    { scope: { mode: "base", base: "main...evil" } },
    { scope: { mode: "pr", pr: "42", files: ["a.ts"] } },
    { scope: { mode: "working", base: "main" } },
    { scope: { mode: "base" } },
    { concurrency: 6 },
    { maxFollowups: 3 },
    { noFix: "false" },
    { userAuthorized: true },
  ])("If scope/options are invalid, commands and agents do not run: %j", async (params) => {
    const f = await fixture();
    await expect(f.controls.inspect(params as ReviewInspectParams)).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  test("If a target is a symlink escaping the repository, inspection is rejected", async () => {
    const f = await fixture();
    const outside = await fixture();
    await symlink(join(outside.cwd, "a.ts"), join(f.cwd, "linked.ts"));
    await expect(
      f.controls.inspect({ scope: { mode: "files", files: ["linked.ts"] } }),
    ).rejects.toThrow("escapes");
    expect(f.requests).toHaveLength(0);
  });

  test("When working scope is collected, staged-only and untracked files are retained", async () => {
    const f = await fixture({ files: ["a.ts", "b.ts", "c.ts"] });
    f.state.changedFiles = ["a.ts"];
    f.state.stagedFiles = ["b.ts"];
    f.state.untrackedFiles = ["c.ts"];
    const run = await inspected(f);
    expect(run.targetFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test.each([
    "staged",
    "base",
    "files",
  ] as const)("When %s scope is selected, its host-derived targets are used", async (mode) => {
    const f = await fixture({ files: ["a.ts", "b.ts"] });
    f.state.stagedFiles = ["b.ts"];
    const scope =
      mode === "files"
        ? { mode, files: ["b.ts"] }
        : mode === "base"
          ? { mode, base: "main" }
          : { mode };
    const run = await inspected(f, { scope });
    expect(run.targetFiles).toEqual(mode === "base" ? ["a.ts", "b.ts"] : ["b.ts"]);
    if (mode === "base")
      expect(f.commands.some((call) => call.args.includes("main...HEAD"))).toBe(true);
  });

  test("If target collection fails, it is not represented as an empty successful review", async () => {
    const f = await fixture();
    f.state.fail = "git diff --name-only -z";
    await expect(f.controls.inspect()).rejects.toThrow("unavailable");
    expect(f.requests).toHaveLength(0);
  });

  test("When scope is empty, no agents or fix are eligible", async () => {
    const f = await fixture({ files: [], authorized: true });
    const run = await inspected(f);
    expect(run.noFix).toBe(true);
    expect(f.requests).toHaveLength(0);
    await expect(f.controls.fix(run.runId)).rejects.toThrow("no eligible");
  });
});

describe("coverage and validation fail closed", () => {
  test.each([
    "inspection",
    "validation",
  ] as const)("If %s omits or fabricates execution-check receipts, Fix shall remain blocked", async (phase) => {
    for (const kind of ["missing", "empty", "passed", "failed"] as const) {
      const schema = phase === "inspection" ? ReviewInspectionSchema : ReviewValidationSchema;
      const f = await fixture({
        authorized: true,
        runner: async (request) => {
          const result = successful(request);
          if (request.schema !== schema) return result;
          const output = result.output as Record<string, unknown>;
          if (kind === "missing") delete output.checks;
          else if (kind === "empty") output.checks = [];
          else
            output.checks = [
              {
                description: "bun run check",
                outcome: kind,
                evidence: "Claimed without an execution tool.",
              },
            ];
          return result;
        },
      });
      const run = await f.controls.inspect();
      expect(run.status).toBe("partial");
      expect(run.noFix).toBe(true);
      const receipt = phase === "inspection" ? run.coverage[0]?.receipt : run.validations[0];
      expect(receipt?.status).toBe("failed");
      expect(receipt?.error).toContain("Invalid structured review output");
      await expect(f.controls.fix(run.runId)).rejects.toThrow("no eligible");
      expect(f.state.authCalls).toBe(0);
      expect(f.requests.every((request) => request.readOnly)).toBe(true);
    }
  });

  test.each([
    "failure",
    "invalid",
    "omitted",
    "gap",
    "outside",
  ])("If an inspector returns %s, no validation or mutation can claim its bucket", async (kind) => {
    const f = await fixture({
      authorized: true,
      runner: async (request) => {
        if (kind === "failure") return { status: "failed", error: "model unavailable" };
        const result = successful(request);
        const output = result.output as {
          reviewedFocus: string[];
          coverageGaps: string[];
          findings: Array<{ path: string }>;
        };
        if (kind === "invalid") result.output = "covered everything and approved";
        if (kind === "omitted") output.reviewedFocus = [];
        if (kind === "gap") output.coverageGaps = ["could not read target"];
        if (kind === "outside" && output.findings[0]) output.findings[0].path = "outside.ts";
        return result;
      },
    });
    const run = await f.controls.inspect();
    expect(run.status).toBe("partial");
    expect(run.noFix).toBe(true);
    expect(run.validations).toHaveLength(0);
    expect(run.coverage).toHaveLength(1);
    expect(run.coverage[0]?.receipt.status).toBe("failed");
    expect(Check(ReviewRunSchema, run)).toBe(true);
    await expect(f.controls.fix(run.runId)).rejects.toThrow("no eligible");
    expect(f.state.authCalls).toBe(0);
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("If one parallel bucket fails, successful evidence remains without filling failed coverage", async () => {
    const f = await fixture({
      files: ["a.ts", "b.ts"],
      runner: async (request) => {
        if (request.label.endsWith(":1")) throw new Error("bucket failed");
        return successful(request);
      },
    });
    const run = await f.controls.inspect();
    expect(run.status).toBe("partial");
    expect(run.candidates).toHaveLength(1);
    expect(run.findings).toHaveLength(0);
    expect(run.coverage.map((entry) => entry.receipt.status)).toEqual(["completed", "failed"]);
  });

  test.each([
    "failure",
    "omitted",
    "duplicate",
    "unknown",
  ])("If validation has %s decisions, Fix is blocked", async (kind) => {
    const f = await fixture({
      authorized: true,
      runner: async (request) => {
        const result = successful(request);
        if (request.schema !== ReviewValidationSchema) return result;
        if (kind === "failure") return { status: "failed", error: "validation unavailable" };
        const output = result.output as { decisions: Array<{ findingId: string }> };
        if (kind === "omitted") output.decisions = [];
        if (kind === "duplicate" && output.decisions[0]) output.decisions.push(output.decisions[0]);
        if (kind === "unknown" && output.decisions[0]) output.decisions[0].findingId = "invented";
        return result;
      },
    });
    const run = await f.controls.inspect();
    expect(run.noFix).toBe(true);
    await expect(f.controls.fix(run.runId)).rejects.toThrow();
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("If follow-ups remain at the hard bound, the record stays partial/no-fix", async () => {
    const f = await fixture({
      runner: async (request) => {
        const result = successful(request);
        if (request.schema === ReviewValidationSchema)
          (result.output as { followUpFocus: string[] }).followUpFocus = ["unresolved boundary"];
        return result;
      },
    });
    const run = await f.controls.inspect({ maxFollowups: 2 });
    expect(run.validations).toHaveLength(3);
    expect(run.coverage).toHaveLength(3);
    expect(run.status).toBe("partial");
    expect(run.noFix).toBe(true);
    expect(f.requests).toHaveLength(6);
  });

  test("When a bounded follow-up resolves its gap, final validation can complete", async () => {
    let validations = 0;
    const f = await fixture({
      runner: async (request) => {
        const result = successful(request);
        if (request.schema === ReviewValidationSchema && validations++ === 0)
          (result.output as { followUpFocus: string[] }).followUpFocus = ["error handling"];
        return result;
      },
    });
    const run = await inspected(f);
    expect(run.validations).toHaveLength(2);
    expect(run.coverage[1]?.focus).toEqual(["focus:error handling"]);
  });
});

describe("separate trusted authorization and fresh rechecks", () => {
  test("If no trusted authorization exists, a model request cannot grant mutation", async () => {
    const f = await fixture();
    const withoutAuthorization = createReviewControls({ ...f.host, authorizeFix: undefined });
    const run = await withoutAuthorization.inspect();
    await expect(withoutAuthorization.fix(run.runId)).rejects.toThrow("actual user authorization");
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("If trusted authorization is false, the local contents remain unchanged", async () => {
    const f = await fixture();
    const run = await inspected(f);
    await expect(f.controls.fix(run.runId)).rejects.toThrow("actual user authorization");
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe("original\n");
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("If noFix was requested, later authorization does not override it", async () => {
    const f = await fixture({ authorized: true });
    const run = await inspected(f, { noFix: true });
    await expect(f.controls.fix(run.runId)).rejects.toThrow("no eligible");
    expect(f.state.authCalls).toBe(0);
  });

  test("When PR Fix is authorized, fresh HEAD/clean reads are the last operations before mutation", async () => {
    const f = await fixture({ authorized: true });
    const run = await inspected(f, { scope: { mode: "pr", pr: "owner/repo#42" } });
    expect(f.commands[1]?.args).toEqual([
      "pr",
      "view",
      "https://github.com/owner/repo/pull/42",
      "--json",
      "files,headRefOid",
    ]);
    const result = await f.controls.fix(run.runId);
    expect(result.status).toBe("fixed");
    expect(Check(ReviewRunSchema, result)).toBe(true);
    expect(result.fix?.output?.checks[0]?.outcome).toBe("not_run");
    expect(f.events.slice(-4)).toEqual([
      "gh pr view https://github.com/owner/repo/pull/42 --json headRefOid",
      "git rev-parse HEAD",
      "git status --porcelain",
      "agent fix",
    ]);
    expect(f.requests.at(-1)?.allowedTools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
    ]);
    expect(f.requests.at(-1)?.readOnly).toBe(false);
    await expect(f.controls.fix(run.runId)).rejects.toThrow("no eligible");
  });

  test.each([
    "remote",
    "local",
    "dirty",
    "command",
  ])("If PR %s changes before Fix, mutation is blocked", async (kind) => {
    const f = await fixture({ authorized: true });
    const run = await inspected(f, { scope: { mode: "pr", pr: "42" } });
    if (kind === "remote") f.state.prHead = OTHER_HEAD;
    if (kind === "local") f.state.localHead = OTHER_HEAD;
    if (kind === "dirty") f.state.status = " M unrelated.ts\n";
    if (kind === "command") f.state.fail = "gh pr view 42 --json headRefOid";
    const result = await f.controls.fix(run.runId);
    expect(result.noFix).toBe(true);
    expect(result.status).toBe("partial");
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe("original\n");
  });

  test("If PR inspection started dirty, cleaning later does not authorize the old run", async () => {
    const f = await fixture({ authorized: true });
    f.state.status = " M a.ts";
    const run = await f.controls.inspect({ scope: { mode: "pr", pr: "42" } });
    f.state.status = "";
    expect(run.noFix).toBe(true);
    await expect(f.controls.fix(run.runId)).rejects.toThrow();
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("If an untracked/explicit target changes without path changes, the fingerprint blocks Fix", async () => {
    const f = await fixture({ authorized: true });
    const run = await inspected(f, { scope: { mode: "files", files: ["a.ts"] } });
    await writeFile(join(f.cwd, "a.ts"), "user edit\n");
    const result = await f.controls.fix(run.runId);
    expect(result.noFix).toBe(true);
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe("user edit\n");
  });

  test("If the mutating runner fails, uncertain local edits are recorded and never retried automatically", async () => {
    const f = await fixture({
      authorized: true,
      runner: async (request) =>
        request.readOnly
          ? successful(request)
          : { status: "failed", error: "interrupted after editing" },
    });
    const run = await inspected(f);
    const result = await f.controls.fix(run.runId);
    expect(result.status).toBe("fix_failed");
    expect(result.fix?.error).toContain("after editing");
    await expect(f.controls.fix(run.runId)).rejects.toThrow();
    expect(f.requests.filter((request) => !request.readOnly)).toHaveLength(1);
  });
});

describe("bounded concurrency and cancellation", () => {
  test("While inspectors run, at most five run concurrently and another operation is rejected", async () => {
    const release = deferred<void>();
    const entered = deferred<void>();
    let active = 0;
    let maximum = 0;
    const f = await fixture({
      files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
      runner: async (request) => {
        active++;
        maximum = Math.max(maximum, active);
        if (active === 5) entered.resolve();
        await release.promise;
        active--;
        return successful(request);
      },
    });
    const pending = f.controls.inspect();
    await entered.promise;
    await expect(f.controls.inspect()).rejects.toThrow("already running");
    const id = f.requests[0]?.label.split(":")[0] ?? "";
    expect(f.controls.status(id).status).toBe("inspecting");
    await expect(f.controls.fix(id)).rejects.toThrow("already running");
    release.resolve();
    await pending;
    expect(maximum).toBe(5);
  });

  test("If cancelled during inspection, in-flight runners settle before releasing the repository lock", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const f = await fixture({
      runner: async (request) => {
        entered.resolve();
        await release.promise;
        return successful(request);
      },
    });
    const pending = f.controls.inspect({}, controller.signal);
    await entered.promise;
    controller.abort();
    await expect(f.controls.inspect()).rejects.toThrow("already running");
    release.resolve();
    const run = await pending;
    expect(run.status).toBe("aborted");
    expect(run.noFix).toBe(true);
    expect(run.coverage[0]?.receipt.status).toBe("aborted");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.signal).toBe(controller.signal);
    expect(f.commands.every((command) => command.signal === controller.signal)).toBe(true);
  });

  test("If cancelled before inspection, no host commands or agents start", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.controls.inspect({}, controller.signal)).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  test("If cancelled during Fix, the lock waits for settlement and the record warns of partial edits", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const f = await fixture({
      authorized: true,
      runner: async (request) => {
        if (!request.readOnly) {
          entered.resolve();
          await release.promise;
        }
        return successful(request);
      },
    });
    const run = await inspected(f);
    const pending = f.controls.fix(run.runId, controller.signal);
    await entered.promise;
    controller.abort();
    await expect(f.controls.inspect()).rejects.toThrow("already running");
    expect(f.controls.status(run.runId).status).toBe("fixing");
    release.resolve();
    const result = await pending;
    expect(result.status).toBe("fix_failed");
    expect(result.fix?.status).toBe("aborted");
    expect(result.noFix).toBe(true);
    await expect(f.controls.fix(run.runId)).rejects.toThrow("no eligible");
    expect(f.requests.filter((request) => !request.readOnly)).toHaveLength(1);
  });

  test("If cancellation arrives during trusted authorization, no Fix runner starts", async () => {
    const controller = new AbortController();
    const f = await fixture({ authorized: true });
    const controls = createReviewControls({
      ...f.host,
      authorizeFix: async () => {
        controller.abort();
        return true;
      },
    });
    const run = await controls.inspect();
    await expect(controls.fix(run.runId, controller.signal)).rejects.toThrow();
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });
});
