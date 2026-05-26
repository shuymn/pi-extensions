import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitResult } from "./git";
import { getCurrentBranch, getDefaultBranch, listBranches } from "./git-branch";

type ExecHandler = (command: string, args: string[]) => GitResult | Promise<GitResult>;

function createFakePi(handler: ExecHandler): ExtensionAPI {
  return {
    async exec(command: string, args: string[]) {
      return handler(command, args);
    },
  } as unknown as ExtensionAPI;
}

const FOR_EACH_REF_ARGS = [
  "for-each-ref",
  "--format=%(refname)%09%(refname:short)",
  "refs/heads",
  "refs/remotes",
];

describe("getDefaultBranch", () => {
  test("returns the upstream HEAD branch when symbolic-ref succeeds", async () => {
    const pi = createFakePi((command, args) => {
      if (command === "git" && args[0] === "symbolic-ref")
        return { code: 0, stdout: "origin/main\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    });

    expect(await getDefaultBranch(pi)).toBe("main");
  });

  test("falls back to main when symbolic-ref fails but main exists", async () => {
    const pi = createFakePi((command, args) => {
      if (command !== "git") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "symbolic-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "show-ref" && args.at(-1) === "refs/heads/main")
        return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });

    expect(await getDefaultBranch(pi)).toBe("main");
  });

  test("falls back to master when neither symbolic-ref nor main resolve", async () => {
    const pi = createFakePi((command, args) => {
      if (command !== "git") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "show-ref" && args.at(-1) === "refs/heads/master")
        return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });

    expect(await getDefaultBranch(pi)).toBe("master");
  });

  test("returns undefined when no candidate matches", async () => {
    const pi = createFakePi(() => ({ code: 1, stdout: "", stderr: "" }));
    expect(await getDefaultBranch(pi)).toBeUndefined();
  });

  test("swallows exec exceptions", async () => {
    const pi = createFakePi(() => {
      throw new Error("git missing");
    });
    expect(await getDefaultBranch(pi)).toBeUndefined();
  });
});

describe("getCurrentBranch", () => {
  test("returns the trimmed branch name", async () => {
    const pi = createFakePi((command, args) => {
      if (command === "git" && args[0] === "branch")
        return { code: 0, stdout: "feature/x\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    });
    expect(await getCurrentBranch(pi)).toBe("feature/x");
  });

  test("returns undefined when exit code is non-zero", async () => {
    const pi = createFakePi(() => ({ code: 128, stdout: "", stderr: "" }));
    expect(await getCurrentBranch(pi)).toBeUndefined();
  });

  test("returns undefined when stdout is blank (detached HEAD)", async () => {
    const pi = createFakePi(() => ({ code: 0, stdout: "\n", stderr: "" }));
    expect(await getCurrentBranch(pi)).toBeUndefined();
  });
});

describe("listBranches", () => {
  const sampleStdout = [
    "refs/heads/feature\tfeature",
    "refs/heads/main\tmain",
    "refs/remotes/origin/main\torigin/main",
    "refs/remotes/origin/HEAD\torigin/HEAD",
    "refs/remotes/origin/feature\torigin/feature",
    "",
  ].join("\n");

  function fakePi(): ExtensionAPI {
    return createFakePi((command, args) => {
      if (command === "git" && args.join(" ") === FOR_EACH_REF_ARGS.join(" "))
        return { code: 0, stdout: sampleStdout, stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    });
  }

  test("dedupes branches and removes HEAD/origin entries", async () => {
    const items = await listBranches(fakePi());
    expect(items.map((item) => item.value)).toEqual(["feature", "main"]);
  });

  test("places currentBranch first and labels it accordingly", async () => {
    const items = await listBranches(fakePi(), { currentBranch: "feature", defaultBranch: "main" });
    expect(items.map((item) => item.value)).toEqual(["feature", "main"]);
    expect(items[0]?.description).toBe("現在のブランチ");
    expect(items[1]?.description).toBe("デフォルトブランチ");
  });

  test("falls back to defaultBranch ordering when currentBranch is absent", async () => {
    const items = await listBranches(fakePi(), { defaultBranch: "main" });
    expect(items.map((item) => item.value)).toEqual(["main", "feature"]);
    expect(items[0]?.description).toBe("デフォルトブランチ");
    expect(items[1]?.description).toBeUndefined();
  });

  test("returns an empty list when exec fails", async () => {
    const pi = createFakePi(() => ({ code: 1, stdout: "", stderr: "no refs" }));
    expect(await listBranches(pi)).toEqual([]);
  });
});
