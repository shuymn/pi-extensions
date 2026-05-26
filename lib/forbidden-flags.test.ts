import { describe, expect, test } from "bun:test";

import { checkForbiddenFlags } from "./forbidden-flags";

describe("checkForbiddenFlags", () => {
  describe("input validation", () => {
    test.each([
      ["", "non-empty command"],
      ["   ", "non-empty command"],
      ["git status\ngit add file", "newlines are not allowed"],
    ])("rejects %p", (command, expected) => {
      const result = checkForbiddenFlags("commit", command);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain(expected);
    });

    test.each([
      "git diff HEAD | head -20",
      "cd /path && git show HEAD:file | tail -50",
      "echo ok; git status",
      "git add file && git status || echo done",
    ])("allows read-only inspection with shell operators in %p", (command) => {
      expect(checkForbiddenFlags("commit", command)).toEqual({ ok: true });
    });
  });

  describe("universal destructive subcommands", () => {
    test.each([
      "git restore .",
      "git reset --hard",
      "git clean -fd",
      "git checkout -- src/app.ts",
      "echo ok && git reset --hard",
    ])("blocks %p", (command) => {
      const result = checkForbiddenFlags("commit", command);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("destructive git cleanup/reset");
    });

    test("blocks git switch --discard-changes (caught via flag denylist)", () => {
      expect(checkForbiddenFlags("commit", "git switch feature --discard-changes")).toMatchObject({
        ok: false,
      });
    });
  });

  describe("git add forbidden flags", () => {
    test.each([
      "git add .",
      "git add -A",
      "git add --all",
      "git add -u",
      "git add --update",
      "git add --pathspec-from-file foo",
      "git add -Av path",
      "git add -uv path",
    ])("blocks %p", (command) => {
      const result = checkForbiddenFlags("commit", command);
      expect(result).toMatchObject({ ok: false });
    });

    test.each([
      "git add path/to/file",
      "git add path && git status",
      "git add -- -Av",
    ])("allows %p", (command) => {
      expect(checkForbiddenFlags("commit", command)).toEqual({ ok: true });
    });
  });

  describe("git commit forbidden flags", () => {
    test.each([
      "git commit --amend",
      "git commit --no-verify -m msg",
      "git commit -a -m msg",
      "git commit --all -m msg",
      "git commit --allow-empty",
      "git commit -i file -m msg",
      "git commit --include file -m msg",
      "git commit -o file -m msg",
      "git commit --only file -m msg",
    ])("blocks %p", (command) => {
      expect(checkForbiddenFlags("commit", command)).toMatchObject({ ok: false });
    });

    test.each([
      "git commit -m 'fix: x'",
      "git commit -m 'test: update commit extension'",
      'git commit -m "feat: add thing"',
    ])("allows %p", (command) => {
      expect(checkForbiddenFlags("commit", command)).toEqual({ ok: true });
    });
  });

  describe("git checkout forbidden flags", () => {
    test.each([
      "git checkout -f main",
      "git checkout -fb new-branch",
      "git checkout -bf new-branch",
      "git checkout --force main",
    ])("blocks %p", (command) => {
      const result = checkForbiddenFlags("commit", command);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("is forbidden for git checkout");
    });

    test.each(["git checkout -b new-branch", "git checkout main"])("allows %p", (command) => {
      expect(checkForbiddenFlags("commit", command)).toEqual({ ok: true });
    });
  });

  describe("git push forbidden flags", () => {
    test.each([
      "git push --force origin HEAD",
      "git push -f origin HEAD",
      "git push -fv origin HEAD",
      "git push --force-with-lease",
      "git push --all",
      "git push --delete origin main",
      "git push --tags",
      "git push --mirror",
      "git push origin :main",
      "git push origin +HEAD",
    ])("blocks %p", (command) => {
      expect(checkForbiddenFlags("create-pr", command)).toMatchObject({ ok: false });
    });

    test.each([
      "git push origin HEAD",
      "git push -u origin HEAD",
      "git push",
    ])("allows %p", (command) => {
      expect(checkForbiddenFlags("create-pr", command)).toEqual({ ok: true });
    });
  });

  describe("workflow-specific forbidden subcommands", () => {
    test.each([
      "git push origin HEAD",
      "gh pr create --title t",
      "gh pr view 1",
    ])("blocks %p in commit", (command) => {
      const result = checkForbiddenFlags("commit", command);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("/commit");
    });

    test.each([
      "git add path",
      "git commit -m msg",
      "git apply /tmp/p",
      "git switch -c x",
      "git checkout main",
    ])("blocks %p in create-pr", (command) => {
      const result = checkForbiddenFlags("create-pr", command);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("/create-pr");
    });
  });

  describe("chain operators", () => {
    test("checks each segment in && and || chains", () => {
      expect(checkForbiddenFlags("commit", "git add path && git status")).toEqual({ ok: true });
      expect(checkForbiddenFlags("commit", "git status && git add -A")).toMatchObject({
        ok: false,
      });
      expect(checkForbiddenFlags("commit", "git add path || git status")).toEqual({ ok: true });
    });

    test("checks each segment in | and ; chains", () => {
      expect(checkForbiddenFlags("commit", "git diff HEAD | head -20")).toEqual({
        ok: true,
      });
      expect(checkForbiddenFlags("commit", "git diff HEAD | git reset --hard")).toMatchObject({
        ok: false,
      });
      expect(checkForbiddenFlags("commit", "echo ok; git status")).toEqual({ ok: true });
      expect(checkForbiddenFlags("commit", "echo ok; git clean -fd")).toMatchObject({
        ok: false,
      });
    });
  });

  describe("non-git commands", () => {
    test.each([
      "ls",
      "rg foo",
      "cat file",
      "bun run test",
      "npm run lint",
      "curl example.com",
    ])("allows %p (defense-in-depth scope is git/gh flags only)", (command) => {
      expect(checkForbiddenFlags("commit", command)).toEqual({ ok: true });
    });
  });

  describe("quoted strings", () => {
    test("does not false-positive on quoted flag-like text", () => {
      expect(
        checkForbiddenFlags("commit", "git commit -m 'fix: regression in --amend handler'"),
      ).toEqual({ ok: true });
    });

    test("allows metacharacters inside single quotes", () => {
      expect(checkForbiddenFlags("commit", "git commit -m 'cost: $5' && git status")).toEqual({
        ok: true,
      });
      expect(checkForbiddenFlags("commit", "git add 'path/with/&/name'")).toEqual({ ok: true });
      expect(checkForbiddenFlags("commit", "git commit -m 'fix: a > b'")).toEqual({ ok: true });
      expect(checkForbiddenFlags("commit", "git commit -m 'fix: a | b'")).toEqual({ ok: true });
      expect(checkForbiddenFlags("commit", "git add 'path/with;semi'")).toEqual({ ok: true });
    });

    test("allows metacharacters inside double quotes", () => {
      expect(checkForbiddenFlags("commit", 'git commit -m "cost: $5" && git status')).toEqual({
        ok: true,
      });
      expect(checkForbiddenFlags("commit", 'git commit -m "fix: a > b"')).toEqual({ ok: true });
      expect(checkForbiddenFlags("commit", 'git commit -m "fix: a; b"')).toEqual({ ok: true });
    });

    test.each([
      "echo $(git reset --hard)",
      "echo `git clean -fd`",
      "git status & git reset --hard",
      "git diff <(git reset --hard)",
      "git status > out.txt",
      'echo "$(git reset --hard)"',
    ])("rejects unsupported shell execution syntax in %p", (command) => {
      expect(checkForbiddenFlags("commit", command)).toMatchObject({ ok: false });
    });

    test("still blocks destructive git commands chained via shell operators", () => {
      expect(checkForbiddenFlags("commit", "git status | git reset --hard")).toMatchObject({
        ok: false,
      });
      expect(checkForbiddenFlags("commit", "echo ok; git clean -fd")).toMatchObject({
        ok: false,
      });
      expect(checkForbiddenFlags("commit", "git diff HEAD || git restore .")).toMatchObject({
        ok: false,
      });
    });

    test("rejects unbalanced quotes", () => {
      expect(checkForbiddenFlags("commit", "git commit -m 'unterminated")).toMatchObject({
        ok: false,
      });
    });
  });
});
