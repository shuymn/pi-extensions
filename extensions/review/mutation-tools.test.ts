import { afterEach, describe, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createReviewMutationTools } from "./mutation-tools";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "review-mutation-")));
  temporaryDirectories.push(dir);
  const cwd = join(dir, "repo");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "reviewed.txt"), "before\n");
  writeFileSync(join(cwd, "sibling.txt"), "before\n");
  writeFileSync(join(dir, "outside.txt"), "before\n");
  return { dir, cwd };
}

function execute(cwd: string, allowed: string[], name: "write" | "edit", path: string) {
  const tool = createReviewMutationTools(cwd, allowed).find((item) => item.name === name)!;
  const params =
    name === "write"
      ? { path, content: "after\n" }
      : { path, edits: [{ oldText: "before", newText: "after" }] };
  return tool.execute("fixture", params, undefined, undefined, {} as ExtensionToolContext);
}

describe("review mutation scope", () => {
  for (const name of ["write", "edit"] as const) {
    test(`WHEN ${name} targets a reviewed regular file, it SHALL apply the native mutation`, async () => {
      const { cwd } = fixture();
      await execute(cwd, ["reviewed.txt"], name, "reviewed.txt");
      expect(readFileSync(join(cwd, "reviewed.txt"), "utf8")).toBe("after\n");
      expect(readFileSync(join(cwd, "sibling.txt"), "utf8")).toBe("before\n");
    });

    test(`WHEN ${name} targets a sibling, outside path or .git, it SHALL reject without mutation`, async () => {
      const { dir, cwd } = fixture();
      mkdirSync(join(cwd, ".git"));
      writeFileSync(join(cwd, ".git", "config"), "before\n");
      for (const path of [
        "sibling.txt",
        "../outside.txt",
        join(dir, "outside.txt"),
        ".git/config",
      ]) {
        await expect(execute(cwd, ["reviewed.txt"], name, path)).rejects.toThrow(
          /unreviewed|safe repository-relative/,
        );
      }
      for (const path of [
        join(cwd, "reviewed.txt"),
        join(cwd, "sibling.txt"),
        join(dir, "outside.txt"),
        join(cwd, ".git", "config"),
      ]) {
        expect(readFileSync(path, "utf8")).toBe("before\n");
      }
    });

    test(`WHEN ${name} rewrites an @ or Unicode-space path, it SHALL guard the native target`, async () => {
      const { dir, cwd } = fixture();
      const aliases = [
        ["@reviewed.txt", join(cwd, "reviewed.txt")],
        ["@../outside.txt", join(dir, "outside.txt")],
        ["reviewed\u00a0file.txt", join(cwd, "reviewed file.txt")],
        ["reviewed\u202ffile.txt", join(cwd, "reviewed file.txt")],
      ] as const;
      for (const [alias, target] of aliases) {
        mkdirSync(dirname(join(cwd, alias)), { recursive: true });
        writeFileSync(join(cwd, alias), "before\n");
        writeFileSync(target, "before\n");
        await expect(execute(cwd, [alias], name, alias)).rejects.toThrow(
          /unreviewed|safe repository-relative/,
        );
        expect(readFileSync(join(cwd, alias), "utf8")).toBe("before\n");
        expect(readFileSync(target, "utf8")).toBe("before\n");
      }
    });

    test(`WHEN a reviewed target is replaced by a symlink, ${name} SHALL not follow it`, async () => {
      const { dir, cwd } = fixture();
      rmSync(join(cwd, "reviewed.txt"));
      symlinkSync(join(dir, "outside.txt"), join(cwd, "reviewed.txt"));
      await expect(execute(cwd, ["reviewed.txt"], name, "reviewed.txt")).rejects.toThrow(
        /regular, unlinked|symlink/,
      );
      expect(readFileSync(join(dir, "outside.txt"), "utf8")).toBe("before\n");
    });

    test(`WHEN a reviewed target has a symlinked ancestor inside the repo, ${name} SHALL reject it`, async () => {
      const { cwd } = fixture();
      mkdirSync(join(cwd, "actual"));
      writeFileSync(join(cwd, "actual", "reviewed.txt"), "before\n");
      symlinkSync(join(cwd, "actual"), join(cwd, "alias"));
      await expect(
        execute(cwd, ["alias/reviewed.txt"], name, "alias/reviewed.txt"),
      ).rejects.toThrow(/symlink/);
      expect(readFileSync(join(cwd, "actual", "reviewed.txt"), "utf8")).toBe("before\n");
    });

    test(`WHEN a reviewed target has another hardlink, ${name} SHALL preserve both names`, async () => {
      const { dir, cwd } = fixture();
      linkSync(join(cwd, "reviewed.txt"), join(dir, "linked.txt"));
      await expect(execute(cwd, ["reviewed.txt"], name, "reviewed.txt")).rejects.toThrow(
        /regular, unlinked/,
      );
      expect(readFileSync(join(cwd, "reviewed.txt"), "utf8")).toBe("before\n");
      expect(readFileSync(join(dir, "linked.txt"), "utf8")).toBe("before\n");
    });
  }

  test("WHEN a reviewed file and its directory were deleted, write SHALL allow scoped recreation", async () => {
    const { cwd } = fixture();
    mkdirSync(join(cwd, "deleted"));
    writeFileSync(join(cwd, "deleted", "reviewed.txt"), "before\n");
    const write = createReviewMutationTools(cwd, ["deleted/reviewed.txt"]).find(
      (tool) => tool.name === "write",
    )!;
    rmSync(join(cwd, "deleted"), { recursive: true });
    await write.execute(
      "recreate",
      { path: "deleted/reviewed.txt", content: "restored\n" },
      undefined,
      undefined,
      {} as ExtensionToolContext,
    );
    expect(readFileSync(join(cwd, "deleted", "reviewed.txt"), "utf8")).toBe("restored\n");
  });

  test("WHEN a deleted target's parent becomes a symlink, recreation SHALL remain denied", async () => {
    const { dir, cwd } = fixture();
    symlinkSync(dir, join(cwd, "deleted"));
    await expect(execute(cwd, ["deleted/new.txt"], "write", "deleted/new.txt")).rejects.toThrow(
      /symlink/,
    );
    expect(() => readFileSync(join(dir, "new.txt"))).toThrow();
  });
});
