import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitResult } from "./git";
import { buildGitSnapshot, type GitSnapshotEntry } from "./git-snapshot";

type ExecCall = { command: string; args: string[]; options: Record<string, unknown> };
type ExecHandler = (call: ExecCall) => GitResult | Promise<GitResult>;

function createFakePi(handler: ExecHandler): {
  pi: ExtensionAPI;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const pi = {
    async exec(command: string, args: string[], options: Record<string, unknown> = {}) {
      const call = { command, args, options };
      calls.push(call);
      return handler(call);
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

describe("buildGitSnapshot", () => {
  test("preserves entry order and formats each block", async () => {
    const { pi } = createFakePi(({ args }) => ({
      code: 0,
      stdout: `out:${args.join(" ")}`,
      stderr: "",
    }));

    const entries: GitSnapshotEntry[] = [
      { label: "Status", args: ["status", "--short"] },
      { label: "Branch", args: ["branch", "--show-current"] },
    ];
    const blocks = await buildGitSnapshot(pi, entries);

    expect(blocks).toEqual([
      "### Status\nout:status --short",
      "### Branch\nout:branch --show-current",
    ]);
  });

  test("applies transform on the trimmed output", async () => {
    const { pi } = createFakePi(() => ({ code: 0, stdout: "origin/main\n", stderr: "" }));
    const [block] = await buildGitSnapshot(pi, [
      {
        label: "Default branch",
        args: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        transform: (output) => output.replace(/^origin\//, "") || "No default branch",
      },
    ]);
    expect(block).toBe("### Default branch\nmain");
  });

  test("uses transform fallback when raw output is empty", async () => {
    const { pi } = createFakePi(() => ({ code: 1, stdout: "", stderr: "" }));
    const [block] = await buildGitSnapshot(pi, [
      {
        label: "Default branch",
        args: ["symbolic-ref"],
        transform: (output) => output.replace(/^origin\//, "") || "No default branch",
      },
    ]);
    expect(block).toBe("### Default branch\nNo default branch");
  });

  test("includes stderr alongside stdout when both are present", async () => {
    const { pi } = createFakePi(() => ({ code: 0, stdout: "ok", stderr: "warn" }));
    const [block] = await buildGitSnapshot(pi, [{ label: "Status", args: ["status"] }]);
    expect(block).toBe("### Status\nok\nwarn");
  });

  test("falls back to (empty) when both streams are blank", async () => {
    const { pi } = createFakePi(() => ({ code: 0, stdout: "", stderr: "" }));
    const [block] = await buildGitSnapshot(pi, [{ label: "Status", args: ["status"] }]);
    expect(block).toBe("### Status\n(empty)");
  });

  test("captures thrown errors into stderr", async () => {
    const { pi } = createFakePi(() => {
      throw new Error("git missing");
    });
    const [block] = await buildGitSnapshot(pi, [{ label: "Status", args: ["status"] }]);
    expect(block).toBe("### Status\ngit missing");
  });

  test("forwards timeoutMs option, defaulting to 5000", async () => {
    const { pi, calls } = createFakePi(() => ({ code: 0, stdout: "x", stderr: "" }));
    await buildGitSnapshot(pi, [{ label: "A", args: ["a"] }]);
    expect(calls[0]?.options).toEqual({ timeout: 5000 });

    await buildGitSnapshot(pi, [{ label: "B", args: ["b"] }], { timeoutMs: 1234 });
    expect(calls[1]?.options).toEqual({ timeout: 1234 });
  });
});
