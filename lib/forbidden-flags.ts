export type Workflow = "commit" | "create-pr";

export type ForbiddenFlagsResult = { ok: true } | { ok: false; reason: string };

const SUBCOMMAND_DENIED_FLAGS: Record<string, ReadonlySet<string>> = {
  "git add": new Set([".", "-A", "--all", "-u", "--update", "--pathspec-from-file"]),
  "git commit": new Set([
    "--amend",
    "--no-verify",
    "-a",
    "--all",
    "--allow-empty",
    "-i",
    "--include",
    "-o",
    "--only",
    "--pathspec-from-file",
  ]),
  "git push": new Set([
    "--all",
    "--delete",
    "--force",
    "-f",
    "--force-with-lease",
    "--mirror",
    "--tags",
  ]),
  "git switch": new Set(["--discard-changes"]),
  "git checkout": new Set(["-f", "--force"]),
};

type SubcommandPrefix = readonly [string, ...string[]];

// Subcommand-level blocks. Per-flag denials for git checkout/switch are in SUBCOMMAND_DENIED_FLAGS below.
const UNIVERSAL_DENIED_SUBCOMMANDS: readonly SubcommandPrefix[] = [
  ["git", "restore"],
  ["git", "reset"],
  ["git", "clean"],
  ["git", "checkout", "--"],
];

const WORKFLOW_FORBIDDEN_SUBCOMMANDS: Record<Workflow, readonly SubcommandPrefix[]> = {
  commit: [["git", "push"], ["gh"]],
  "create-pr": [
    ["git", "add"],
    ["git", "commit"],
    ["git", "apply"],
    ["git", "switch"],
    ["git", "checkout"],
  ],
};

export function checkForbiddenFlags(workflow: Workflow, command: string): ForbiddenFlagsResult {
  if (typeof command !== "string" || !command.trim()) {
    return deny("shell command input must include a non-empty command string.");
  }
  if (/[\r\n]/.test(command)) {
    return deny("shell command newlines are not allowed.");
  }
  const unsupportedSyntax = findUnsupportedShellSyntax(command);
  if (unsupportedSyntax) {
    return deny(`unsupported shell syntax is not allowed: ${unsupportedSyntax}.`);
  }

  const segments = splitChainSegments(command);
  if (segments.length === 0) return deny("no executable command was found.");

  for (const segment of segments) {
    const argv = splitCommandWords(segment);
    if (argv.length === 0) return deny("failed to parse shell command segment.");
    const result = checkSegment(workflow, argv);
    if (!result.ok) return result;
  }
  return { ok: true };
}

function checkSegment(workflow: Workflow, argv: string[]): ForbiddenFlagsResult {
  if (matchesSubcommand(argv, UNIVERSAL_DENIED_SUBCOMMANDS)) {
    return deny("destructive git cleanup/reset commands are not allowed.");
  }
  if (matchesSubcommand(argv, WORKFLOW_FORBIDDEN_SUBCOMMANDS[workflow])) {
    return deny(`shell command is not allowed in /${workflow}: ${argv.slice(0, 2).join(" ")}.`);
  }

  if (argv[0] !== "git") return { ok: true };

  const subcommand = argv[1];
  if (!subcommand) return { ok: true };
  const key = `git ${subcommand}`;
  const denied = SUBCOMMAND_DENIED_FLAGS[key];
  if (!denied) return { ok: true };

  const args = argv.slice(2);
  let parsingFlags = true;
  for (const arg of args) {
    if (parsingFlags && arg === "--") {
      parsingFlags = false;
      continue;
    }
    if (!parsingFlags) continue;

    if (denied.has(arg)) {
      return deny(`shell command is not allowed: ${arg} is forbidden for ${key}.`);
    }
    if (arg.includes("=")) {
      const optionName = arg.slice(0, arg.indexOf("="));
      if (denied.has(optionName)) {
        return deny(`shell command is not allowed: ${optionName} is forbidden for ${key}.`);
      }
    }

    if (key === "git add" || key === "git commit" || key === "git checkout" || key === "git push") {
      if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          const short = `-${ch}`;
          if (denied.has(short)) {
            return deny(`shell command is not allowed: ${short} is forbidden for ${key}.`);
          }
        }
      }
    }

    if (key === "git push") {
      if (arg.includes(":") || arg.startsWith("+")) {
        return deny(`shell command is not allowed: refspec rewrites are forbidden for ${key}.`);
      }
    }
  }
  return { ok: true };
}

function matchesSubcommand(argv: string[], prefixes: readonly SubcommandPrefix[]): boolean {
  outer: for (const prefix of prefixes) {
    if (argv.length < prefix.length) continue;
    for (let index = 0; index < prefix.length; index += 1) {
      if (argv[index] !== prefix[index]) continue outer;
    }
    return true;
  }
  return false;
}

function findUnsupportedShellSyntax(command: string): string | undefined {
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === "`") return "command substitution";
      else if (quote === '"' && char === "$" && next === "(") return "command substitution";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(")) return "command substitution";
    if (char === "<" || char === ">") return "redirection or process substitution";
    if (char === "&") {
      if (next === "&") {
        index += 1;
        continue;
      }
      return "background operator";
    }
  }
  return undefined;
}

function splitChainSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (quote) {
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function splitCommandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) return [];
  if (current) words.push(current);
  return words;
}

function deny(reason: string): ForbiddenFlagsResult {
  return { ok: false, reason };
}
