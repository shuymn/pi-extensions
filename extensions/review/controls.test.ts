import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReadTool } from "@earendil-works/pi-coding-agent";
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

function taskPath(request: ReviewAgentRequest): string {
  if (!request.recoveryContext) throw new Error("Missing durable review recovery context");
  return promptData<string>(request.recoveryContext, "Review task artifact (data): ");
}

async function taskData<T>(request: ReviewAgentRequest): Promise<T> {
  return JSON.parse(await readFile(taskPath(request), "utf8")) as T;
}

async function nativeRead(cwd: string, path: string, offset?: number, limit?: number) {
  const result = await createReadTool(cwd).execute("fixture-read", { path, offset, limit });
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

async function successful(request: ReviewAgentRequest): Promise<ReviewAgentResult> {
  const checks = [
    {
      description: "Runtime verification",
      outcome: "not_run",
      evidence: "Read-only investigation has no execution tools.",
    },
  ];
  if (request.schema === ReviewInspectionSchema) {
    const { assignedFocus: focus } = await taskData<{ assignedFocus: string[] }>(request);
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
    const { candidates } = await taskData<{ candidates: ReviewCandidate[] }>(request);
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
      blockers: [],
      checks: [
        { description: "tests", outcome: "passed", evidence: "fixture verification passed" },
      ],
    },
  };
}

async function fixture(
  options: {
    files?: string[];
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
    const f = await fixture({ files });
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
    expect(run.noFix).toBe(true); // Explicit inspection is report-only.
    expect(run.issues).toEqual([]);
    const checks = [
      {
        description: "Runtime verification",
        outcome: "not_run",
        evidence: "Read-only investigation has no execution tools.",
      },
    ];
    expect(run.coverage[0]?.receipt.output).toMatchObject({ coverageGaps: [], checks });
    expect(run.validations[0]?.output).toMatchObject({ followUpFocus: [], checks });
    expect(f.controls.status(run.runId)).toEqual(run);
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

  test("IF untracked targets exceed 500 files, preflight SHALL reject before reading their contents", async () => {
    const f = await fixture({ files: [] });
    f.state.untrackedFiles = Array.from({ length: 501 }, (_, index) => `addition-${index}.ts`);
    const reads = spyOn(fs, "readFile");
    try {
      await expect(f.controls.run()).rejects.toThrow("exceeds 500 files");
      expect(reads).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
    } finally {
      reads.mockRestore();
    }
  });

  test("IF an untracked file exceeds 2 MiB, preflight SHALL reject before allocating its contents", async () => {
    const f = await fixture({ files: [] });
    f.state.untrackedFiles = ["large.bin"];
    const file = await open(join(f.cwd, "large.bin"), "w");
    try {
      await file.truncate(2 * 1024 * 1024 + 1);
    } finally {
      await file.close();
    }
    const reads = spyOn(fs, "readFile");
    try {
      await expect(f.controls.run()).rejects.toThrow("not a bounded regular file: large.bin");
      expect(reads).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
    } finally {
      reads.mockRestore();
    }
  });

  test("IF an untracked target is not a regular file, preflight SHALL reject before reading it", async () => {
    const f = await fixture();
    await symlink(join(f.cwd, "a.ts"), join(f.cwd, "linked.ts"));
    f.state.changedFiles = [];
    f.state.untrackedFiles = ["linked.ts"];
    const reads = spyOn(fs, "readFile");
    try {
      await expect(f.controls.run()).rejects.toThrow("not a bounded regular file: linked.ts");
      expect(reads).not.toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
    } finally {
      reads.mockRestore();
    }
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
    const f = await fixture({ files: [] });
    const run = await inspected(f);
    expect(run.noFix).toBe(true);
    expect(f.requests).toHaveLength(0);
  });
});

describe("recoverable review evidence", () => {
  test("WHEN history loses the task, native read SHALL recover exact focus and pageable deleted-file evidence", async () => {
    const patchLines = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2600 +0,0 @@",
      ...Array.from({ length: 2600 }, (_, index) => `-const removed${index} = ${index};`),
    ];
    const patch = patchLines.join("\n");
    const artifacts: string[] = [];
    const f = await fixture({
      files: ["a.ts", "gone.ts"],
      runner: async (request) => {
        // Only the system recovery reference survives; no original prompt or diff remains.
        const compacted = { ...request, prompt: "Lossy summary without focus or patch." };
        const artifact = taskPath(compacted);
        artifacts.push(artifact);
        const task = JSON.parse(await nativeRead(f.cwd, artifact)) as {
          assignedFocus?: string[];
          candidates?: ReviewCandidate[];
          scopePath: string;
          diffPath: string;
        };
        expect(JSON.parse(await nativeRead(f.cwd, task.scopePath))).toMatchObject({
          scope: { mode: "staged" },
          targetFiles: ["a.ts", "gone.ts"],
        });
        const pages = [];
        for (let offset = 1; offset <= patchLines.length; offset += 1000) {
          const page = await nativeRead(f.cwd, task.diffPath, offset, 1000);
          pages.push(page.split("\n\n[")[0]);
        }
        expect(pages.join("\n")).toBe(patch);
        if (request.schema === ReviewInspectionSchema) {
          expect(task.assignedFocus).toEqual([
            "file:a.ts",
            "file:gone.ts",
            "focus:deletion behavior",
          ]);
          await expect(readFile(join(f.cwd, "gone.ts"))).rejects.toThrow("ENOENT");
          // A newer repository patch cannot silently replace the selected evidence.
          f.state.diff = "different current patch";
        } else {
          expect(task.candidates?.map((candidate) => candidate.path)).toEqual(["a.ts"]);
        }
        return successful(compacted);
      },
    });
    f.state.stagedFiles = ["a.ts", "gone.ts"];
    f.state.diff = patch;
    await rm(join(f.cwd, "gone.ts"));
    const run = await f.controls.inspect({
      scope: { mode: "staged" },
      focus: ["deletion behavior"],
      concurrency: 1,
    });
    expect(run.status).toBe("ready");
    expect(run.coverage[0]?.receipt.output?.reviewedFocus).toEqual(run.coverage[0]?.focus);
    expect(run.coverage[0]?.receipt.output?.coverageGaps).toEqual([]);
    expect(artifacts).toHaveLength(2);
    expect(dirname(artifacts[0] ?? "")).toBe(dirname(artifacts[1] ?? ""));
    for (const artifact of artifacts) await expect(readFile(artifact)).rejects.toThrow("ENOENT");
    await expect(fs.stat(dirname(artifacts[0] ?? ""))).rejects.toThrow("ENOENT");
  });

  test("WHEN bounded additions exceed the command-size limit in aggregate, inspectors SHALL read them without oversized prompts", async () => {
    const files = Array.from({ length: 8 }, (_, index) => `new-${index}.ts`);
    const content = `${"readable addition\n".repeat(20_000)}last line\n`;
    expect(Buffer.byteLength(content) * files.length).toBeGreaterThan(2 * 1024 * 1024);
    const readAdditions = new Set<string>();
    const f = await fixture({
      files,
      runner: async (request) => {
        expect(Buffer.byteLength(request.prompt)).toBeLessThan(20_000);
        if (request.schema === ReviewInspectionSchema) {
          const { assignedFocus } = await taskData<{ assignedFocus: string[] }>(request);
          for (const item of assignedFocus) {
            const file = item.slice("file:".length);
            expect(await nativeRead(f.cwd, file, 20_001, 1)).toContain("last line");
            // The inspector can obtain the complete current evidence independently of a patch.
            expect(await readFile(join(f.cwd, file), "utf8")).toBe(content);
            readAdditions.add(file);
          }
        }
        return successful(request);
      },
    });
    f.state.changedFiles = [];
    f.state.untrackedFiles = files;
    for (const file of files) await writeFile(join(f.cwd, file), content);
    const run = await f.controls.inspect();
    expect(run.status).toBe("ready");
    expect(run.targetFiles).toEqual(files);
    expect([...readAdditions].sort()).toEqual(files);
    expect(run.coverage.every((entry) => entry.receipt.output?.coverageGaps.length === 0)).toBe(
      true,
    );
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
        runner: async (request) => {
          const result = await successful(request);
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
      runner: async (request) => {
        if (kind === "failure") return { status: "failed", error: "model unavailable" };
        const result = await successful(request);
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
      runner: async (request) => {
        const result = await successful(request);
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
    expect(run.status).toBe("partial");
    expect(run.validations[0]?.status).toBe("failed");
    expect(run.findings).toEqual([]);
    expect(run.noFix).toBe(true);
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("If follow-ups remain at the hard bound, the record stays partial/no-fix", async () => {
    const f = await fixture({
      runner: async (request) => {
        const result = await successful(request);
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
        const result = await successful(request);
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

describe("review-with-fix and fresh checks", () => {
  function beforeRepair(f: Awaited<ReturnType<typeof fixture>>, change: () => void) {
    const runner = f.host.runAgent;
    f.host.runAgent = async (request) => {
      const result = await runner(request);
      if (request.schema === ReviewValidationSchema) change();
      return result;
    };
  }

  test("WHEN run completes, it SHALL inspect, repair, and verify without a separate authorization step", async () => {
    const f = await fixture();
    const run = await f.controls.run();
    expect(run.status).toBe("fixed");
    expect(run.fix?.output?.checks[0]?.outcome).toBe("passed");
    expect(f.requests.map((request) => request.readOnly)).toEqual([true, true, false]);
    expect(f.requests.at(-1)?.allowedTools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
    ]);
    expect(Check(ReviewRunSchema, run)).toBe(true);
  });

  test("WHEN noFix is requested, run SHALL remain inspection-only", async () => {
    const f = await fixture();
    const run = await f.controls.run({ noFix: true });
    expect(run).toMatchObject({ status: "ready", noFix: true });
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("WHEN an untracked addition is reviewed, its current contents SHALL remain accessible evidence", async () => {
    let readAddition = false;
    const f = await fixture({
      files: ["a.ts", "new.ts"],
      runner: async (request) => {
        if (request.schema === ReviewInspectionSchema) {
          const task = await taskData<{ assignedFocus: string[] }>(request);
          if (task.assignedFocus.includes("file:new.ts")) {
            expect(await nativeRead(f.cwd, "new.ts")).toBe("untracked implementation\n");
            readAddition = true;
          }
        }
        return successful(request);
      },
    });
    f.state.changedFiles = ["a.ts"];
    f.state.untrackedFiles = ["new.ts"];
    await writeFile(join(f.cwd, "new.ts"), "untracked implementation\n");
    const run = await f.controls.run({ noFix: true });
    expect(run.targetFiles).toEqual(["a.ts", "new.ts"]);
    expect(readAddition).toBe(true);
    expect(run.coverage.every((entry) => entry.receipt.output?.coverageGaps.length === 0)).toBe(
      true,
    );
    expect(f.requests[0]?.prompt).toContain("a missing patch is not a coverage gap");
  });

  test("WHEN PR repair starts, fresh HEAD/clean reads SHALL be the last operations before mutation", async () => {
    const f = await fixture();
    const result = await f.controls.run({ scope: { mode: "pr", pr: "owner/repo#42" } });
    expect(result.status).toBe("fixed");
    expect(f.events.slice(-4)).toEqual([
      "gh pr view https://github.com/owner/repo/pull/42 --json headRefOid",
      "git rev-parse HEAD",
      "git status --porcelain",
      "agent fix",
    ]);
  });

  test.each([
    "remote",
    "local",
    "dirty",
    "command",
  ])("IF PR %s changes during inspection, repair SHALL NOT use a stale snapshot", async (kind) => {
    const f = await fixture();
    beforeRepair(f, () => {
      if (kind === "remote") f.state.prHead = OTHER_HEAD;
      if (kind === "local") f.state.localHead = OTHER_HEAD;
      if (kind === "dirty") f.state.status = " M unrelated.ts\n";
      if (kind === "command") f.state.fail = "gh pr view 42 --json headRefOid";
    });
    const result = await f.controls.run({ scope: { mode: "pr", pr: "42" } });
    expect(result).toMatchObject({ status: "partial", noFix: true });
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe("original\n");
  });

  test("IF PR review starts dirty, it SHALL report partial inspection without repair", async () => {
    const f = await fixture();
    f.state.status = " M a.ts";
    const run = await f.controls.run({ scope: { mode: "pr", pr: "42" } });
    expect(run).toMatchObject({ status: "partial", noFix: true });
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
  });

  test("IF the user edits a reviewed file during inspection, repair SHALL preserve that edit", async () => {
    const f = await fixture();
    const runner = f.host.runAgent;
    f.host.runAgent = async (request) => {
      const result = await runner(request);
      if (request.schema === ReviewValidationSchema)
        await writeFile(join(f.cwd, "a.ts"), "user edit\n");
      return result;
    };
    const result = await f.controls.run({ scope: { mode: "files", files: ["a.ts"] } });
    expect(result.status).toBe("partial");
    expect(f.requests.every((request) => request.readOnly)).toBe(true);
    expect(await readFile(join(f.cwd, "a.ts"), "utf8")).toBe("user edit\n");
  });

  test("IF the runner fails after editing, the receipt SHALL preserve uncertainty rather than claiming completion", async () => {
    const f = await fixture({
      runner: async (request) =>
        request.readOnly
          ? successful(request)
          : { status: "failed", error: "interrupted after editing" },
    });
    const run = await f.controls.run();
    expect(run.status).toBe("fix_failed");
    expect(run.fix?.error).toContain("after editing");
    expect(f.requests.filter((request) => !request.readOnly)).toHaveLength(1);
  });

  test.each([
    "failed",
    "not_run",
  ])("IF required checks remain %s, run SHALL NOT claim fixed", async (outcome) => {
    const f = await fixture({
      runner: async (request) =>
        request.readOnly
          ? successful(request)
          : {
              status: "completed",
              output: {
                changes: [],
                blockers: [],
                checks: [{ description: "tests", outcome, evidence: "Executable missing" }],
              },
            },
    });
    const run = await f.controls.run();
    expect(run.status).toBe("fix_failed");
    expect(run.fix?.output?.checks).toEqual([
      { description: "tests", outcome, evidence: "Executable missing" },
    ]);
  });
});

describe("bounded concurrency and cancellation", () => {
  test("WHILE inspectors run, concurrency SHALL stay bounded and another operation SHALL NOT overlap", async () => {
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
    const pending = f.controls.run();
    await entered.promise;
    await expect(f.controls.inspect()).rejects.toThrow("already running");
    await expect(f.controls.run()).rejects.toThrow("already running");
    const id = f.requests[0]?.label.split(":")[0] ?? "";
    expect(f.controls.status(id).status).toBe("inspecting");
    release.resolve();
    expect((await pending).status).toBe("fixed");
    expect(maximum).toBe(5);
  });

  test("IF cancelled during inspection, in-flight runners SHALL settle before releasing the lock", async () => {
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
    const pending = f.controls.run({}, controller.signal);
    await entered.promise;
    controller.abort();
    await expect(f.controls.run()).rejects.toThrow("already running");
    const artifact = taskPath(f.requests[0]!);
    expect(await taskData(f.requests[0]!)).toMatchObject({ assignedFocus: ["file:a.ts"] });
    release.resolve();
    const run = await pending;
    await expect(fs.stat(dirname(artifact))).rejects.toThrow("ENOENT");
    expect(run).toMatchObject({ status: "aborted", noFix: true });
    expect(run.coverage[0]?.receipt.status).toBe("aborted");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.signal).toBe(controller.signal);
    expect(f.commands.every((command) => command.signal === controller.signal)).toBe(true);
  });

  test("IF one task artifact fails to write, sibling runners SHALL settle before evidence cleanup", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const setupFailed = deferred<void>();
    const f = await fixture({
      files: ["a.ts", "b.ts"],
      runner: async (request) => {
        entered.resolve();
        await release.promise;
        return successful(request);
      },
    });
    const originalWrite = fs.writeFile;
    const writes = spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
      if (String(path).endsWith("-inspect-0-1.json")) {
        setupFailed.resolve();
        throw new Error("fixture evidence write failure");
      }
      return originalWrite(path, data, options);
    });
    const pending = f.controls.inspect();
    try {
      await Promise.all([entered.promise, setupFailed.promise]);
      await expect(f.controls.run()).rejects.toThrow("already running");
      const artifact = taskPath(f.requests[0]!);
      expect(await taskData(f.requests[0]!)).toMatchObject({ assignedFocus: ["file:a.ts"] });
      release.resolve();
      const run = await pending;
      expect(run.status).toBe("partial");
      expect(run.coverage.map((entry) => entry.receipt.status)).toEqual(["completed", "failed"]);
      expect(run.coverage[1]?.receipt.error).toContain("fixture evidence write failure");
      expect(run.validations).toHaveLength(0);
      await expect(fs.stat(dirname(artifact))).rejects.toThrow("ENOENT");
    } finally {
      release.resolve();
      await pending;
      writes.mockRestore();
    }
  });

  test("IF cancelled before review, no host commands or agents SHALL start", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.controls.run({}, controller.signal)).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  });

  test("IF cancelled during repair, the lock SHALL wait for settlement and report partial edits", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const f = await fixture({
      runner: async (request) => {
        if (!request.readOnly) {
          entered.resolve();
          await release.promise;
        }
        return successful(request);
      },
    });
    const pending = f.controls.run({}, controller.signal);
    await entered.promise;
    const id = f.requests[0]?.label.split(":")[0] ?? "";
    controller.abort();
    await expect(f.controls.run()).rejects.toThrow("already running");
    expect(f.controls.status(id).status).toBe("fixing");
    const repair = f.requests.find((request) => !request.readOnly)!;
    const artifact = taskPath(repair);
    expect(await taskData(repair)).toMatchObject({
      validatedFindings: [{ path: "a.ts" }],
    });
    release.resolve();
    const result = await pending;
    await expect(fs.stat(dirname(artifact))).rejects.toThrow("ENOENT");
    expect(result.status).toBe("fix_failed");
    expect(result.fix?.status).toBe("aborted");
    expect(f.requests.filter((request) => !request.readOnly)).toHaveLength(1);
  });
});
