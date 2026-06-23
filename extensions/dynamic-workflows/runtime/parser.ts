export type WorkflowPhaseMeta = {
  title: string;
  description?: string;
};

export type WorkflowMeta = {
  name: string;
  description?: string;
  phases: WorkflowPhaseMeta[];
};

export type ParsedWorkflowScript = {
  meta: WorkflowMeta;
  executableScript: string;
};

const META_EXPORT_RE = /export\s+const\s+meta\s*=/y;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DIAGNOSTIC_PREVIEW_MAX_LENGTH = 80;

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  const metaStart = skipWhitespaceAndComments(source, 0);
  META_EXPORT_RE.lastIndex = metaStart;
  const metaMatch = META_EXPORT_RE.exec(source);
  if (!metaMatch) {
    throw new WorkflowParseError(
      "Workflow script must start with `export const meta = { ... }` after comments and whitespace.",
    );
  }

  const parser = new LiteralParser(source, META_EXPORT_RE.lastIndex);
  const rawMeta = parser.parseRootValue();
  let statementEnd = skipWhitespaceAndComments(source, parser.position);
  if (source[statementEnd] === ";") statementEnd += 1;

  const executableScript = source.slice(statementEnd).trimStart();
  if (containsExportKeyword(executableScript)) {
    throw new WorkflowParseError("Workflow scripts may only export `meta`.");
  }
  rejectNondeterministicWorkflowCode(executableScript);

  return {
    meta: validateWorkflowMeta(rawMeta),
    executableScript,
  };
}

export function executableScriptCallsAgent(source: string): boolean {
  return /\bagent\s*\(/.test(stripStringsAndComments(source));
}

function validateWorkflowMeta(value: unknown): WorkflowMeta {
  if (!isPlainObject(value)) {
    throw new WorkflowParseError("Workflow meta must be an object literal.");
  }

  const name = value.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw new WorkflowParseError("Workflow meta.name must be a non-empty string.");
  }

  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    throw new WorkflowParseError("Workflow meta.description must be a string when present.");
  }

  const phases = value.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new WorkflowParseError("Workflow meta.phases must be a non-empty array.");
  }

  return {
    name,
    ...(description === undefined ? {} : { description }),
    phases: phases.map((phase, index) => validateWorkflowPhase(phase, index)),
  };
}

function validateWorkflowPhase(value: unknown, index: number): WorkflowPhaseMeta {
  if (!isPlainObject(value)) {
    throw new WorkflowParseError(
      `Workflow meta.phases[${index}] must be an object literal with a non-empty title, for example ${phaseRepairExample(value)}; phases: [${formatDiagnosticValue(value)}] is not accepted.`,
    );
  }

  const title = value.title;
  if (typeof title !== "string" || title.trim() === "") {
    throw new WorkflowParseError(missingPhaseTitleMessage(value, index));
  }

  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    throw new WorkflowParseError(
      `Workflow meta.phases[${index}].description must be a string when present.`,
    );
  }

  return {
    title,
    ...(description === undefined ? {} : { description }),
  };
}

function missingPhaseTitleMessage(value: Record<string, unknown>, index: number): string {
  if (typeof value.name === "string" && value.name.trim() !== "") {
    return `Workflow meta.phases[${index}].title must be a non-empty string. Use ${phaseRepairExample(value.name)}; { name: ${formatDiagnosticValue(value.name)} } is not accepted.`;
  }

  return `Workflow meta.phases[${index}].title must be a non-empty string. Use ${phaseRepairExample()}.`;
}

function phaseRepairExample(value: unknown = "Run"): string {
  const title =
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= DIAGNOSTIC_PREVIEW_MAX_LENGTH
      ? value
      : "Run";
  return `{ title: ${JSON.stringify(title)} }`;
}

function formatDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(truncateDiagnosticText(value));
  const text = JSON.stringify(value) ?? String(value);
  return truncateDiagnosticText(text);
}

function truncateDiagnosticText(text: string): string {
  return text.length <= DIAGNOSTIC_PREVIEW_MAX_LENGTH
    ? text
    : `${text.slice(0, DIAGNOSTIC_PREVIEW_MAX_LENGTH - 1)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function skipWhitespaceAndComments(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }

    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new WorkflowParseError("Unterminated block comment.");
      index = end + 2;
      continue;
    }

    return index;
  }
  return index;
}

function containsExportKeyword(source: string): boolean {
  return /\bexport\b/.test(stripStringsAndComments(source));
}

function rejectNondeterministicWorkflowCode(source: string): void {
  const stripped = stripStringsAndComments(source);
  const checks: Array<{ pattern: RegExp; message: string }> = [
    {
      pattern: /\bDate\s*\.\s*now\s*\(/,
      message: "Workflow scripts may not call Date.now().",
    },
    {
      pattern: /\bMath\s*\.\s*random\s*\(/,
      message: "Workflow scripts may not call Math.random().",
    },
    {
      pattern: /\bnew\s+Date\s*\(\s*\)/,
      message: "Workflow scripts may not construct argument-less new Date().",
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(stripped)) throw new WorkflowParseError(check.message);
  }
}

function stripStringsAndComments(source: string): string {
  let index = 0;
  let stripped = "";

  while (index < source.length) {
    const char = source[index];

    if (char === "`") {
      const template = stripTemplateLiteral(source, index);
      stripped += template.text;
      index = template.end;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = skipStringLiteral(source, index, char);
      stripped += " ".repeat(end - index);
      index = end;
      continue;
    }

    const commentEnd = skipComment(source, index);
    if (commentEnd !== undefined) {
      stripped += " ".repeat(commentEnd - index);
      index = commentEnd;
      continue;
    }

    stripped += char;
    index += 1;
  }

  return stripped;
}

function skipStringLiteral(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index += 1;
  }
  throw new WorkflowParseError("Unterminated string literal.");
}

function stripTemplateLiteral(source: string, start: number): { text: string; end: number } {
  let index = start + 1;
  let text = " ";

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      text += "  ";
      index += 2;
      continue;
    }
    if (char === "`") return { text: `${text} `, end: index + 1 };
    if (source.startsWith("${", index)) {
      const expression = readTemplateExpression(source, index + 2);
      text += `  ${stripStringsAndComments(expression.source)} `;
      index = expression.end;
      continue;
    }
    text += " ";
    index += 1;
  }

  throw new WorkflowParseError("Unterminated template literal.");
}

function readTemplateExpression(source: string, start: number): { source: string; end: number } {
  let index = start;
  let depth = 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "`") {
      index = stripTemplateLiteral(source, index).end;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipStringLiteral(source, index, char);
      continue;
    }
    const commentEnd = skipComment(source, index);
    if (commentEnd !== undefined) {
      index = commentEnd;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { source: source.slice(start, index), end: index + 1 };
    }
    index += 1;
  }
  throw new WorkflowParseError("Unterminated template expression.");
}

function skipComment(source: string, start: number): number | undefined {
  if (source.startsWith("//", start)) {
    const newline = source.indexOf("\n", start + 2);
    return newline === -1 ? source.length : newline + 1;
  }

  if (source.startsWith("/*", start)) {
    const end = source.indexOf("*/", start + 2);
    if (end === -1) throw new WorkflowParseError("Unterminated block comment.");
    return end + 2;
  }

  return undefined;
}

class LiteralParser {
  #source: string;
  #index: number;

  constructor(source: string, start: number) {
    this.#source = source;
    this.#index = start;
  }

  get position(): number {
    return this.#index;
  }

  parseRootValue(): unknown {
    const value = this.parseValue();
    this.#index = skipWhitespaceAndComments(this.#source, this.#index);
    return value;
  }

  private parseValue(): unknown {
    this.#index = skipWhitespaceAndComments(this.#source, this.#index);
    const char = this.#source[this.#index];

    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"' || char === "'") return this.parseString(char);
    if (char === "-" || isDigit(char)) return this.parseNumber();
    if (this.consumeKeyword("true")) return true;
    if (this.consumeKeyword("false")) return false;
    if (this.consumeKeyword("null")) return null;
    if (char === "`") throw new WorkflowParseError("Template literals are not allowed in meta.");

    throw new WorkflowParseError(
      `Meta must be a pure literal; unexpected token ${describeChar(char)}.`,
    );
  }

  private parseObject(): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    this.expect("{");
    this.#index = skipWhitespaceAndComments(this.#source, this.#index);

    while (!this.consume("}")) {
      if (this.#source.startsWith("...", this.#index)) {
        throw new WorkflowParseError("Object spreads are not allowed in meta.");
      }
      if (this.#source[this.#index] === "[") {
        throw new WorkflowParseError("Computed object keys are not allowed in meta.");
      }

      const key = this.parseObjectKey();
      if (UNSAFE_OBJECT_KEYS.has(key)) {
        throw new WorkflowParseError(`Unsafe object key is not allowed in meta: ${key}.`);
      }

      this.#index = skipWhitespaceAndComments(this.#source, this.#index);
      if (this.#source[this.#index] === "(") {
        throw new WorkflowParseError("Method properties are not allowed in meta.");
      }
      this.expect(":");
      object[key] = this.parseValue();
      this.#index = skipWhitespaceAndComments(this.#source, this.#index);

      if (this.consume("}")) break;
      this.expect(",");
      this.#index = skipWhitespaceAndComments(this.#source, this.#index);
    }

    return object;
  }

  private parseObjectKey(): string {
    const char = this.#source[this.#index];
    if (char === '"' || char === "'") return this.parseString(char);
    if (startsIdentifier(this.#source, this.#index)) {
      const end = readIdentifierEnd(this.#source, this.#index);
      const key = this.#source.slice(this.#index, end);
      this.#index = end;
      return key;
    }
    throw new WorkflowParseError(`Invalid object key in meta: ${describeChar(char)}.`);
  }

  private parseArray(): unknown[] {
    const array: unknown[] = [];
    this.expect("[");
    this.#index = skipWhitespaceAndComments(this.#source, this.#index);

    while (!this.consume("]")) {
      if (this.#source.startsWith("...", this.#index)) {
        throw new WorkflowParseError("Array spreads are not allowed in meta.");
      }
      array.push(this.parseValue());
      this.#index = skipWhitespaceAndComments(this.#source, this.#index);

      if (this.consume("]")) break;
      this.expect(",");
      this.#index = skipWhitespaceAndComments(this.#source, this.#index);
    }

    return array;
  }

  private parseString(quote: string): string {
    this.expect(quote);
    let result = "";

    while (this.#index < this.#source.length) {
      const char = this.#source[this.#index];
      if (char === quote) {
        this.#index += 1;
        return result;
      }
      if (char === "\\") {
        result += this.parseEscapeSequence();
        continue;
      }
      if (char === "\n" || char === "\r") {
        throw new WorkflowParseError("String literals in meta may not contain raw newlines.");
      }
      result += char;
      this.#index += 1;
    }

    throw new WorkflowParseError("Unterminated string literal.");
  }

  private parseEscapeSequence(): string {
    this.expect("\\");
    const char = this.#source[this.#index];
    this.#index += 1;
    switch (char) {
      case "'":
      case '"':
      case "\\":
        return char;
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "u":
        return this.parseUnicodeEscape();
      default:
        if (!char) throw new WorkflowParseError("Unterminated escape sequence.");
        return char;
    }
  }

  private parseUnicodeEscape(): string {
    if (this.#source[this.#index] === "{") {
      const end = this.#source.indexOf("}", this.#index + 1);
      if (end === -1) throw new WorkflowParseError("Unterminated unicode escape.");
      const codePointText = this.#source.slice(this.#index + 1, end);
      if (!/^[\da-fA-F]+$/.test(codePointText)) {
        throw new WorkflowParseError("Invalid unicode escape.");
      }
      this.#index = end + 1;
      return String.fromCodePoint(Number.parseInt(codePointText, 16));
    }

    const hex = this.#source.slice(this.#index, this.#index + 4);
    if (!/^[\da-fA-F]{4}$/.test(hex)) throw new WorkflowParseError("Invalid unicode escape.");
    this.#index += 4;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  private parseNumber(): number {
    const start = this.#index;
    if (this.#source[this.#index] === "-") this.#index += 1;
    while (isDigit(this.#source[this.#index])) this.#index += 1;
    if (this.#source[this.#index] === ".") {
      this.#index += 1;
      while (isDigit(this.#source[this.#index])) this.#index += 1;
    }
    if (this.#source[this.#index] === "e" || this.#source[this.#index] === "E") {
      this.#index += 1;
      if (this.#source[this.#index] === "+" || this.#source[this.#index] === "-") {
        this.#index += 1;
      }
      while (isDigit(this.#source[this.#index])) this.#index += 1;
    }

    const number = Number(this.#source.slice(start, this.#index));
    if (!Number.isFinite(number)) throw new WorkflowParseError("Invalid number literal in meta.");
    return number;
  }

  private consumeKeyword(keyword: string): boolean {
    if (!this.#source.startsWith(keyword, this.#index)) return false;
    const next = this.#source[this.#index + keyword.length];
    if (isIdentifierPart(next)) return false;
    this.#index += keyword.length;
    return true;
  }

  private consume(char: string): boolean {
    if (this.#source[this.#index] !== char) return false;
    this.#index += 1;
    return true;
  }

  private expect(char: string): void {
    if (!this.consume(char)) {
      throw new WorkflowParseError(
        `Expected ${char} in meta, got ${describeChar(this.#source[this.#index])}.`,
      );
    }
  }
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function startsIdentifier(source: string, index: number): boolean {
  const char = source[index];
  return char !== undefined && /[$A-Z_a-z]/.test(char);
}

function readIdentifierEnd(source: string, start: number): number {
  let index = start + 1;
  while (isIdentifierPart(source[index])) index += 1;
  return index;
}

function isIdentifierPart(char: string | undefined): boolean {
  return char !== undefined && /[$\w]/.test(char);
}

function describeChar(char: string | undefined): string {
  if (char === undefined) return "end of input";
  return JSON.stringify(char);
}
