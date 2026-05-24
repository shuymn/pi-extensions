import { describe, expect, test } from "bun:test";

import { classifyShellCommand } from "./shell-safety";

describe("classifyShellCommand", () => {
  test.each([
    "sed -n '1,120p' review/index.ts",
    "git status --short -- review/index.ts",
    "git diff -- review/index.ts",
    "git show HEAD:review/index.ts",
    "git log --oneline -- review/index.ts",
    "git rev-parse --show-toplevel",
    "git ls-files -- review/index.ts",
    "git grep classifyShellCommand",
    "cat review/index.ts",
    "head -40 review/index.ts",
    "tail -20 review/index.ts",
    "wc -l review/index.ts",
    "ls -la review",
    "find review -maxdepth 1 -type f",
    "grep -R review extensions/review",
    "rg review extensions/review",
    "git status --short -- review/index.ts && git diff -- review/index.ts",
  ])("allows statically read-only command: %s", (command) => {
    expect(classifyShellCommand(command)).toMatchObject({
      decision: "allow",
    });
  });

  test.each([
    "sed -i 's/a/b/' review/index.ts",
    "rm -rf review",
    "mv a b",
    "chmod 600 file",
    "chown user file",
    "xattr -d attr file",
    "git restore .",
    "git checkout -- review/index.ts",
    "git checkout -f main",
    "git switch feature --discard-changes",
    "git reset --hard",
    "git clean -fd",
    "cat review/index.ts > out.txt",
    "cat review/index.ts >> out.txt",
    "find review -delete",
    "find review -fprint out.txt",
    "find review -fprintf out.txt '%p\n'",
    "find review -fls out.txt",
    "git diff --output=out.patch",
    "git show --output out.txt HEAD",
    "sed -n '1w out.txt' file",
    "sed -n '1e touch out.txt' file",
    "sed -n 's/foo/bar/w out.txt' file",
    "git status\ngit reset --hard",
    "git status\rgit reset --hard",
  ])("denies clearly destructive or writing command: %s", (command) => {
    expect(classifyShellCommand(command).decision).toBe("deny");
  });

  test.each([
    "awk '{print $1}' file",
    "sed '1,3p' file",
    "sed -n -f script.sed file",
    "git branch",
    "git switch main",
    "git add review/index.ts",
    "git commit -m change",
    "git stash",
    "git rebase main",
    "git merge feature",
    "git cherry-pick abc123",
    "git apply patch.diff",
    "git diff --ext-diff",
    "git log --ext-diff -p",
    "git grep --open-files-in-pager='sh -c touch out' pattern",
    "cp a b",
    "install src dest",
    "mkdir tmp",
    "touch file",
    "npm install",
    "bun install",
    "pip install package",
    "python script.py",
    "node script.js",
    "bun run build",
    "cat file | grep x",
    "cat review/index.ts | tee out.txt",
    "cat $(touch out.txt)",
    'cat "$(touch out.txt)"',
    "cat `touch out.txt`",
    "cat < input.txt",
    "find review -exec rm -f {} ;",
    "find review -execdir sh -c 'rm -f \"$1\"' sh {} +",
    "curl https://example.com",
    "wget https://example.com",
    "ssh host",
    "scp a host:b",
    "nc -l 1234",
    "unknown-tool --flag",
  ])("returns unknown when static rules need reviewer context: %s", (command) => {
    expect(classifyShellCommand(command).decision).toBe("unknown");
  });

  test("denies empty and malformed commands", () => {
    expect(classifyShellCommand("").decision).toBe("deny");
    expect(classifyShellCommand("sed -n '1,3p file").decision).toBe("deny");
  });

  test.each([
    ["git reset --hard", "git reset is not allowed in /commit workflow."],
    ["git status\ngit reset --hard", "Shell command newlines are not allowed in /commit workflow."],
    [
      "cat review/index.ts > out.txt",
      "Shell output redirection is not allowed in /commit workflow.",
    ],
    [
      "sed -n '1w out.txt' file",
      "sed scripts that write files or execute commands are not allowed in /commit workflow.",
    ],
  ])("formats deny rationale with caller-provided context: %s", (command, rationale) => {
    expect(classifyShellCommand(command, { restrictionContext: "/commit workflow" })).toEqual({
      decision: "deny",
      rationale,
    });
  });
});
