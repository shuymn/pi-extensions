export type ShellSafetyDecision = "allow" | "deny" | "unknown";

export type ShellSafetyResult = {
  decision: ShellSafetyDecision;
  rationale: string;
};

export type ShellSafetyOptions = {
  restrictionContext?: string;
};

type ShellSafetyContext = {
  restrictionContext: string;
};

const READ_ONLY_COMMANDS = new Set(["cat", "grep", "head", "ls", "rg", "tail", "wc"]);

const CLEARLY_DESTRUCTIVE_COMMANDS = new Set(["chmod", "chown", "mv", "rm", "xattr"]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

const DESTRUCTIVE_GIT_SUBCOMMANDS = new Set(["clean", "reset", "restore"]);

const PACKAGE_MANAGER_COMMANDS = new Set([
  "bun",
  "cargo",
  "go",
  "npm",
  "pnpm",
  "pip",
  "pip3",
  "uv",
  "yarn",
]);

const INTERPRETER_COMMANDS = new Set(["deno", "node", "python", "python3", "ruby"]);

const CHAIN_OPERATORS = new Set(["&&", "||"]);
const UNSUPPORTED_SHELL_TOKENS = new Set(["|", ";", "&", "(", ")"]);
const DESTRUCTIVE_FIND_ACTIONS = new Set(["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const REVIEW_REQUIRED_FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const GIT_OUTPUT_OPTIONS = new Set(["--output"]);
const REVIEW_REQUIRED_GIT_OPTIONS = new Set([
  "--ext-diff",
  "--external-diff",
  "--open-files-in-pager",
]);

export function classifyShellCommand(
  command: unknown,
  options: ShellSafetyOptions = {},
): ShellSafetyResult {
  const context = shellSafetyContext(options);

  if (typeof command !== "string" || !command.trim()) {
    return deny("shell command input must include a non-empty command string.");
  }

  if (/[\r\n]/.test(command)) {
    return deny(`Shell command newlines are not allowed in ${context.restrictionContext}.`);
  }

  if (hasUnsafeShellExpansion(command)) {
    return unknown(
      "Shell command substitution or process substitution requires reviewer evaluation.",
    );
  }

  const tokens = tokenizeShellCommand(command);
  if (!tokens.ok) return deny(tokens.reason);

  const redirect = tokens.tokens.find(
    (token) => token.kind === "operator" && isRedirect(token.value),
  );
  if (redirect) {
    return isOutputRedirect(redirect.value)
      ? deny(`Shell output redirection is not allowed in ${context.restrictionContext}.`)
      : unknown("Shell input redirection requires reviewer evaluation.");
  }

  if (
    tokens.tokens.some(
      (token) => token.kind === "operator" && UNSUPPORTED_SHELL_TOKENS.has(token.value),
    )
  ) {
    return unknown("Command uses shell operators that require reviewer evaluation.");
  }

  const commands = splitCommands(tokens.tokens);
  if (!commands.ok) return deny(commands.reason);

  let sawCommand = false;
  for (const argv of commands.commands) {
    if (argv.length === 0) continue;
    sawCommand = true;
    const result = classifySimpleCommand(argv, context);
    if (result.decision !== "allow") return result;
  }

  return sawCommand
    ? allow("All command segments match conservative read-only rules.")
    : deny("No executable command was found.");
}

function shellSafetyContext(options: ShellSafetyOptions): ShellSafetyContext {
  return { restrictionContext: options.restrictionContext ?? "/review read-only phases" };
}

function notAllowed(context: ShellSafetyContext, subject: string): string {
  return `${subject} is not allowed in ${context.restrictionContext}.`;
}

type ShellToken = {
  kind: "word" | "operator";
  value: string;
};

type TokenizeResult = { ok: true; tokens: ShellToken[] } | { ok: false; reason: string };

function tokenizeShellCommand(command: string): TokenizeResult {
  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  const pushWord = () => {
    if (!current) return;
    tokens.push({ kind: "word", value: current });
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      pushWord();
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushWord();
      tokens.push({ kind: "operator", value: `${char}${next}` });
      index += 1;
      continue;
    }

    if ((char === ">" && next === ">") || (char === "<" && next === "<")) {
      pushWord();
      tokens.push({ kind: "operator", value: `${char}${next}` });
      index += 1;
      continue;
    }

    if ("|;&()<>".includes(char)) {
      pushWord();
      tokens.push({ kind: "operator", value: char });
      continue;
    }

    current += char;
  }

  if (quote) return { ok: false, reason: "Unterminated shell quote." };
  pushWord();
  return { ok: true, tokens };
}

type SplitResult = { ok: true; commands: string[][] } | { ok: false; reason: string };

function splitCommands(tokens: ShellToken[]): SplitResult {
  const commands: string[][] = [[]];

  for (const token of tokens) {
    if (token.kind === "operator") {
      if (!CHAIN_OPERATORS.has(token.value)) {
        return {
          ok: false,
          reason: `Unsupported shell operator: ${token.value}`,
        };
      }
      if (commands.at(-1)?.length === 0) {
        return {
          ok: false,
          reason: `Shell operator ${token.value} has no left-hand command.`,
        };
      }
      commands.push([]);
      continue;
    }
    commands.at(-1)?.push(token.value);
  }

  if (commands.at(-1)?.length === 0) {
    return { ok: false, reason: "Shell command ends with an operator." };
  }

  return { ok: true, commands };
}

function classifySimpleCommand(argv: string[], context: ShellSafetyContext): ShellSafetyResult {
  const executable = basename(argv[0]);

  if (CLEARLY_DESTRUCTIVE_COMMANDS.has(executable)) {
    return deny(notAllowed(context, executable));
  }

  if (PACKAGE_MANAGER_COMMANDS.has(executable)) {
    return unknown(`${executable} requires reviewer evaluation.`);
  }

  if (INTERPRETER_COMMANDS.has(executable)) {
    return unknown(`${executable} script execution requires reviewer evaluation.`);
  }

  if (executable === "sed") return classifySed(argv, context);
  if (executable === "git") return classifyGit(argv, context);
  if (executable === "find") return classifyFind(argv, context);

  if (READ_ONLY_COMMANDS.has(executable)) {
    return allow(`${executable} is treated as a read-only inspection command.`);
  }

  return unknown(`${executable} is not covered by static read-only shell rules.`);
}

function classifySed(argv: string[], context: ShellSafetyContext): ShellSafetyResult {
  if (argv.some((arg) => arg === "-i" || arg.startsWith("-i"))) {
    return deny(notAllowed(context, "sed in-place editing"));
  }
  if (!argv.some((arg) => arg === "-n" || (arg.startsWith("-") && arg.includes("n")))) {
    return unknown("sed without -n is not covered by static read-only shell rules.");
  }
  if (argv.some((arg) => arg === "-f" || arg === "--file" || arg.startsWith("--file="))) {
    return unknown("sed script files require reviewer evaluation.");
  }
  if (sedScripts(argv).some((script) => hasUnsafeSedScript(script))) {
    return deny(
      `sed scripts that write files or execute commands are not allowed in ${context.restrictionContext}.`,
    );
  }
  return allow("sed -n without in-place editing is read-only.");
}

function classifyGit(argv: string[], context: ShellSafetyContext): ShellSafetyResult {
  const subcommand = argv.find((arg, index) => index > 0 && !arg.startsWith("-"));
  if (!subcommand) return unknown("git command has no subcommand to classify.");

  if (DESTRUCTIVE_GIT_SUBCOMMANDS.has(subcommand)) {
    return deny(notAllowed(context, `git ${subcommand}`));
  }

  if (subcommand === "checkout" && argv.some((arg) => arg === "--" || arg === "-f")) {
    return deny(notAllowed(context, "git checkout destructive mode"));
  }

  if (subcommand === "switch" && argv.includes("--discard-changes")) {
    return deny(notAllowed(context, "git switch --discard-changes"));
  }

  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    const outputOption = argv.find((arg) => isGitOption(arg, GIT_OUTPUT_OPTIONS));
    if (outputOption) {
      return deny(notAllowed(context, `git ${subcommand} option ${outputOption}`));
    }
    const reviewRequiredOption = argv.find((arg) => isGitOption(arg, REVIEW_REQUIRED_GIT_OPTIONS));
    if (reviewRequiredOption) {
      return unknown(
        `git ${subcommand} option ${reviewRequiredOption} requires reviewer evaluation.`,
      );
    }
    return allow(`git ${subcommand} is treated as read-only.`);
  }

  return unknown(`git ${subcommand} is not covered by static read-only shell rules.`);
}

function classifyFind(argv: string[], context: ShellSafetyContext): ShellSafetyResult {
  const destructiveAction = argv.find((arg) => DESTRUCTIVE_FIND_ACTIONS.has(arg));
  if (destructiveAction) {
    return deny(notAllowed(context, `find action ${destructiveAction}`));
  }
  const reviewRequiredAction = argv.find((arg) => REVIEW_REQUIRED_FIND_ACTIONS.has(arg));
  if (reviewRequiredAction) {
    return unknown(`find action ${reviewRequiredAction} requires reviewer evaluation.`);
  }
  return allow("find without mutating actions is treated as read-only.");
}

function hasUnsafeShellExpansion(command: string): boolean {
  return (
    command.includes("$(") ||
    command.includes("`") ||
    command.includes("<(") ||
    command.includes(">(")
  );
}

function isGitOption(arg: string, options: Set<string>): boolean {
  if (options.has(arg)) return true;
  for (const option of options) {
    if (arg.startsWith(`${option}=`)) return true;
  }
  return false;
}

function sedScripts(argv: string[]): string[] {
  const scripts: string[] = [];
  let foundScript = false;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-e" || arg === "--expression") {
      const script = argv[index + 1];
      if (script) scripts.push(script);
      index += 1;
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      scripts.push(arg.slice(2));
      continue;
    }
    if (arg === "-f" || arg === "--file" || arg.startsWith("--file=")) {
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (!foundScript) {
      scripts.push(arg);
      foundScript = true;
    }
  }

  return scripts;
}

function hasUnsafeSedScript(script: string): boolean {
  return (
    script === "f" ||
    /(^|[;\n])\s*(?:[0-9,$]+)?[wWeE](\s|$)/.test(script) ||
    /s(.).*\1[we](\s|$)/.test(script)
  );
}

function basename(command: string): string {
  return command.split("/").filter(Boolean).at(-1) ?? command;
}

function isRedirect(token: string): boolean {
  return token === ">" || token === ">>" || token === "<" || token === "<<";
}

function isOutputRedirect(token: string): boolean {
  return token === ">" || token === ">>";
}

function allow(rationale: string): ShellSafetyResult {
  return { decision: "allow", rationale };
}

function deny(rationale: string): ShellSafetyResult {
  return { decision: "deny", rationale };
}

function unknown(rationale: string): ShellSafetyResult {
  return { decision: "unknown", rationale };
}
