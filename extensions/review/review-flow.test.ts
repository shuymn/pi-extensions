import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandResult, ExecGh, ExecGit } from "../../lib/command";
import type { WorkflowLaunchResult } from "../dynamic-workflows/workflow-tool";
import {
  launchReviewFlow,
  prepareReviewFlowArgs,
  prepareReviewFlowLaunch,
  REVIEW_FLOW_HUNT_LENS_COUNT,
  REVIEW_FLOW_WORKFLOW_NAME,
} from "./review-flow";
import type { PreparedTargetScope } from "./target-scope";
import { MAX_GAPFILL_LOOPS } from "./workflow";

function result(stdout = "", code = 0, stderr = ""): CommandResult {
  return { code, stdout, stderr };
}

const FAKE_CTX = { cwd: "/repo" } as unknown as ExtensionContext;

function fakeLaunchResult(): WorkflowLaunchResult {
  return {
    runId: "wf_review_12345678",
    taskId: "task_review_12345678",
    workflowName: REVIEW_FLOW_WORKFLOW_NAME,
    artifactDir: "/repo/.pi/workflows/wf_review_12345678",
    outputPath: "/repo/.pi/workflows/wf_review_12345678/output.json",
    details: { status: "launched" } as WorkflowLaunchResult["details"],
  };
}

describe("review_flow adapter", () => {
  test("passes prepared Target Scope through into workflow args unchanged", async () => {
    const prepared: PreparedTargetScope = {
      scope: { kind: "workingTree" },
      targets: [{ path: "src/a.ts", status: "modified", source: "diff" }],
      diff: "## Combined diff against HEAD\n\n+changed",
    };

    const args = await prepareReviewFlowArgs(prepared, {
      runId: "rev1",
      noFix: false,
      instructions: "focus on error handling",
    });

    // Prepared scope is conveyed without mutation.
    expect(args.targets).toBe(prepared.targets);
    expect(args.diff).toBe(prepared.diff);
    expect(args.scope).toBe(prepared.scope);
    expect(args.noFix).toBe(false);
    expect(args.noFixReason).toBeUndefined();
    expect(args.maxGapfillLoops).toBe(MAX_GAPFILL_LOOPS);
    expect(args.huntLensCount).toBe(REVIEW_FLOW_HUNT_LENS_COUNT);
    // Full pipeline instructions when fixes are allowed.
    expect(Object.keys(args.phaseInstructions).sort()).toEqual([
      "dedupe",
      "fix",
      "gapfill",
      "hunt",
      "recon",
      "summary",
      "trace",
      "validate",
      "verify",
    ]);
    expect(args.globalRules).toContain("Stage 7: Fix");
    expect(args.additionalUserInstructions).toContain("focus on error handling");
  });

  test("forces no-fix mode when the prepared scope carries a no-fix reason", async () => {
    const prepared: PreparedTargetScope = {
      scope: { kind: "pr", selector: "123" },
      targets: [{ path: "src/a.ts", status: "pr", source: "pr" }],
      diff: "## Pull request diff",
      noFixReason: { kind: "pr_head_mismatch", prHeadOid: "aaa", localHeadOid: "bbb" },
    };

    const args = await prepareReviewFlowArgs(prepared, {
      runId: "rev2",
      noFix: false,
      instructions: "",
    });

    expect(args.noFix).toBe(true);
    expect(args.noFixReason).toEqual(prepared.noFixReason);
    // No-fix mode omits mutable Fix/Verify instructions.
    expect(args.phaseInstructions.fix).toBeUndefined();
    expect(args.phaseInstructions.verify).toBeUndefined();
    expect(args.globalRules).toContain("No-fix mode is enabled");
  });

  test("prepareReviewFlowLaunch downgrades a PR head mismatch to no-fix through prepared args", async () => {
    const execGit: ExecGit = async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") return result("localhead999\n");
      return result("", 1, `unexpected git ${key}`);
    };
    const execGh: ExecGh = async (args) => {
      const key = args.join(" ");
      if (key === "pr view 123 --json files,headRefOid") {
        return result(JSON.stringify({ files: [{ path: "src/a.ts" }], headRefOid: "prhead111" }));
      }
      if (key === "pr diff 123 --patch") return result("diff body");
      return result("", 1, `unexpected gh ${key}`);
    };

    const preparation = await prepareReviewFlowLaunch(
      { execGit, execGh, cwd: "/repo" },
      { runId: "rev3", pr: "123", noFix: false },
    );

    expect(preparation.kind).toBe("ready");
    if (preparation.kind !== "ready") throw new Error("expected ready");
    expect(preparation.prepared.noFixReason).toEqual({
      kind: "pr_head_mismatch",
      prHeadOid: "prhead111",
      localHeadOid: "localhead999",
    });
    expect(preparation.args.noFix).toBe(true);
    expect(preparation.args.noFixReason).toEqual({
      kind: "pr_head_mismatch",
      prHeadOid: "prhead111",
      localHeadOid: "localhead999",
    });
    expect(preparation.args.targets).toBe(preparation.prepared.targets);
  });

  test("launchReviewFlow returns empty and never calls the bridge when no targets exist", async () => {
    const execGh: ExecGh = async (args) => {
      if (args.join(" ") === "pr view 123 --json files,headRefOid") {
        return result(JSON.stringify({ files: [], headRefOid: "prhead111" }));
      }
      return result("", 1, "unexpected");
    };
    const execGit: ExecGit = async () => result("", 1, "unexpected");

    let bridgeCalls = 0;
    const launch = await launchReviewFlow(
      async () => {
        bridgeCalls += 1;
        return fakeLaunchResult();
      },
      FAKE_CTX,
      { execGit, execGh, cwd: "/repo" },
      { runId: "rev4", pr: "123" },
    );

    expect(launch.kind).toBe("empty");
    expect(bridgeCalls).toBe(0);
  });

  test("launchReviewFlow launches review_flow through the bridge with prepared args", async () => {
    const execGit: ExecGit = async (args) => {
      const key = args.join(" ");
      if (key === "rev-parse HEAD") return result("samehead\n");
      if (key === "status --porcelain") return result("");
      return result("", 1, `unexpected git ${key}`);
    };
    const execGh: ExecGh = async (args) => {
      const key = args.join(" ");
      if (key === "pr view 55 --json files,headRefOid") {
        return result(JSON.stringify({ files: [{ path: "src/a.ts" }], headRefOid: "samehead" }));
      }
      if (key === "pr diff 55 --patch") return result("patch body");
      return result("", 1, `unexpected gh ${key}`);
    };

    const bridgeInputs: Array<{ name?: string; args?: unknown }> = [];
    const launch = await launchReviewFlow(
      async (input, ctx) => {
        expect(ctx).toBe(FAKE_CTX);
        bridgeInputs.push({ name: input.name, args: input.args });
        return fakeLaunchResult();
      },
      FAKE_CTX,
      { execGit, execGh, cwd: "/repo" },
      { runId: "rev5", pr: "55", noFix: false },
    );

    expect(launch.kind).toBe("launched");
    if (launch.kind !== "launched") throw new Error("expected launched");
    expect(launch.result.workflowName).toBe(REVIEW_FLOW_WORKFLOW_NAME);
    expect(bridgeInputs).toHaveLength(1);
    expect(bridgeInputs[0]!.name).toBe(REVIEW_FLOW_WORKFLOW_NAME);
    // Clean local checkout matching the PR head keeps fixes enabled.
    expect(launch.args.noFix).toBe(false);
    expect(bridgeInputs[0]!.args).toBe(launch.args);
  });
});
