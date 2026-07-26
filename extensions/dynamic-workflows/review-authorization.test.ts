import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CliExec } from "../../lib/cli";
import { prepareReviewFlowLaunch, reauthorizeReviewFlowMutation } from "./review-authorization";
import { extensionPackagedWorkflowRoot } from "./saved/packaged";
import type { SavedWorkflow } from "./saved/resolver";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function canonicalReviewWorkflow(overrides: Partial<SavedWorkflow> = {}): SavedWorkflow {
  return {
    name: "review_flow",
    phases: [{ title: "Recon" }],
    path: join(extensionPackagedWorkflowRoot(), "review-flow.js"),
    fileName: "review-flow.js",
    script: "export const meta = {};",
    source: "extension",
    ...overrides,
  };
}

function execFixture(
  options: {
    prHead?: string;
    localHead?: string;
    status?: string;
    failCommand?: "gh" | "rev-parse" | "status";
    malformedPrJson?: boolean;
  } = {},
) {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const exec: CliExec = async (command, args, commandOptions) => {
    calls.push({ command, args, options: commandOptions });
    const key = command === "gh" ? "gh" : args[0] === "rev-parse" ? "rev-parse" : "status";
    if (options.failCommand === key) return { code: 1, stdout: "", stderr: "failed" };
    if (key === "gh") {
      return {
        code: 0,
        stdout: options.malformedPrJson
          ? "not-json"
          : JSON.stringify({
              headRefOid: options.prHead ?? HEAD,
              files: [{ path: "src/a.ts" }],
            }),
        stderr: "",
      };
    }
    if (key === "rev-parse") {
      return { code: 0, stdout: `${options.localHead ?? HEAD}\n`, stderr: "" };
    }
    return { code: 0, stdout: options.status ?? "", stderr: "" };
  };
  return { exec, calls };
}

function prepare(
  exec: CliExec | undefined,
  workflow: SavedWorkflow | undefined,
  args: unknown = { pr: "42" },
) {
  const signal = new AbortController().signal;
  return {
    signal,
    result: prepareReviewFlowLaunch({ workflow, args, exec, cwd: "/repo", signal }),
  };
}

describe("review_flow host mutation authorization", () => {
  test("authorizes only a clean checkout whose HEAD matches the PR head", async () => {
    const fixture = execFixture();
    const { result, signal } = prepare(fixture.exec, canonicalReviewWorkflow());

    await expect(result).resolves.toEqual({
      args: { pr: "42" },
      trustedRuntimeContext: {
        reviewFlow: {
          canonicalTargetFiles: ["src/a.ts"],
          prMutationAuthorized: true,
          prSelector: "42",
          authorizedHeadOid: HEAD,
        },
      },
    });
    expect(fixture.calls).toEqual([
      {
        command: "gh",
        args: ["pr", "view", "42", "--json", "files,headRefOid"],
        options: { cwd: "/repo", signal, timeout: 10_000 },
      },
      {
        command: "git",
        args: ["rev-parse", "HEAD"],
        options: { cwd: "/repo", signal, timeout: 10_000 },
      },
      {
        command: "git",
        args: ["status", "--porcelain"],
        options: { cwd: "/repo", signal, timeout: 10_000 },
      },
    ]);
  });

  test.each([
    ["head mismatch", { localHead: "ffffffffffffffffffffffffffffffffffffffff" }],
    ["dirty checkout", { status: " M src/a.ts\n" }],
  ])("does not authorize on %s", async (_case, fixtureOptions) => {
    const fixture = execFixture(fixtureOptions);
    await expect(
      prepare(fixture.exec, canonicalReviewWorkflow()).result.then(
        (value) => value.trustedRuntimeContext?.reviewFlow.prMutationAuthorized,
      ),
    ).resolves.toBeUndefined();
  });

  test.each([
    ["gh failure", { failCommand: "gh" as const }],
    ["git failure", { failCommand: "rev-parse" as const }],
    ["status failure", { failCommand: "status" as const }],
    ["malformed PR JSON", { malformedPrJson: true }],
  ])("rejects on %s", async (_case, fixtureOptions) => {
    const fixture = execFixture(fixtureOptions);
    await expect(prepare(fixture.exec, canonicalReviewWorkflow()).result).rejects.toThrow();
  });

  test("rejects when CliExec throws", async () => {
    const exec: CliExec = async () => {
      throw new Error("spawn failed");
    };
    await expect(prepare(exec, canonicalReviewWorkflow()).result).rejects.toThrow("spawn failed");
  });

  test("normalizes documented cross-repository selectors before gh invocation", async () => {
    const fixture = execFixture();
    const prepared = await prepareReviewFlowLaunch({
      workflow: canonicalReviewWorkflow(),
      args: { pr: "owner/repo#42" },
      exec: fixture.exec,
      cwd: "/repo",
    });
    expect(prepared.args).toEqual({ pr: "https://github.com/owner/repo/pull/42" });
    expect(fixture.calls[0]?.args).toEqual([
      "pr",
      "view",
      "https://github.com/owner/repo/pull/42",
      "--json",
      "files,headRefOid",
    ]);
  });

  test.each([
    "-Rother/repo",
    "owner/repo#42 --json files",
    "@{upstream}",
  ])("rejects unsafe PR selector %s before command execution", async (selector) => {
    const fixture = execFixture();
    await expect(
      prepareReviewFlowLaunch({
        workflow: canonicalReviewWorkflow(),
        args: { pr: selector },
        exec: fixture.exec,
        cwd: "/repo",
      }),
    ).rejects.toThrow("Invalid pull request selector");
    expect(fixture.calls).toEqual([]);
  });

  test.each([
    "-main",
    "main...evil",
    "main @{upstream}",
  ])("rejects unsafe base ref %s before command execution", async (base) => {
    const fixture = execFixture();
    await expect(
      prepareReviewFlowLaunch({
        workflow: canonicalReviewWorkflow(),
        args: { base },
        exec: fixture.exec,
        cwd: "/repo",
      }),
    ).rejects.toThrow("Invalid base branch");
    expect(fixture.calls).toEqual([]);
  });

  test("rechecks the original PR head and clean status before mutation", async () => {
    const dirty = execFixture({ status: " M unrelated.ts\n" });
    await expect(
      reauthorizeReviewFlowMutation({
        trustedRuntimeContext: {
          reviewFlow: {
            canonicalTargetFiles: ["src/a.ts"],
            prMutationAuthorized: true,
            prSelector: "42",
            authorizedHeadOid: HEAD,
          },
        },
        exec: dirty.exec,
        cwd: "/repo",
      }),
    ).resolves.toBe(false);
  });

  test.each([
    ["raw workflow", undefined, { pr: "42" }],
    ["project override", canonicalReviewWorkflow({ source: "project" }), { pr: "42" }],
    ["skill workflow", canonicalReviewWorkflow({ source: "skill" }), { pr: "42" }],
    [
      "other extension path",
      canonicalReviewWorkflow({ path: "/tmp/workflows/review-flow.js" }),
      { pr: "42" },
    ],
    ["other name", canonicalReviewWorkflow({ name: "other_flow" }), { pr: "42" }],
    ["files precedence", canonicalReviewWorkflow(), { files: ["src/a.ts"], pr: "42" }],
  ])("does not authorize %s", async (_case, workflow, args) => {
    const fixture = execFixture();
    await expect(
      prepare(fixture.exec, workflow, args).result.then(
        (value) => value.trustedRuntimeContext?.reviewFlow.prMutationAuthorized,
      ),
    ).resolves.toBeUndefined();
    expect(fixture.calls).toEqual([]);
  });
});
