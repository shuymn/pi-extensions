import { afterEach, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTypeboxMock } from "../../tests/support/typebox-mock";

type Subscriber = (event: any) => void;

export const createAgentSessionCalls: any[] = [];
export const loaderInstances: any[] = [];
export const createdSessions: any[] = [];
let nextResultText = "workflow subagent result";

export function setNextWorkflowAgentResultText(text: string): void {
  nextResultText = text;
}

function createSession() {
  const subscribers: Subscriber[] = [];
  let name = "";
  let disposed = false;
  let aborted = false;
  const session = {
    messages: [] as any[],
    lastPrompt: "",
    get name() {
      return name;
    },
    get disposed() {
      return disposed;
    },
    get aborted() {
      return aborted;
    },
    setSessionName(value: string) {
      name = value;
    },
    subscribe(subscriber: Subscriber) {
      subscribers.push(subscriber);
      return () => {
        const index = subscribers.indexOf(subscriber);
        if (index >= 0) subscribers.splice(index, 1);
      };
    },
    async prompt(prompt: string) {
      session.lastPrompt = prompt;
      for (const subscriber of subscribers) subscriber({ type: "message_start" });
      for (const subscriber of subscribers) {
        subscriber({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: nextResultText },
        });
      }
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: nextResultText }],
      });
    },
    async abort() {
      aborted = true;
    },
    dispose() {
      disposed = true;
    },
  };
  createdSessions.push(session);
  return session;
}

mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/agent-dir",
  DefaultResourceLoader: class {
    options: any;
    reloaded = false;
    constructor(options: any) {
      this.options = options;
      loaderInstances.push(this);
    }
    async reload() {
      this.reloaded = true;
    }
  },
  SessionManager: {
    inMemory: (cwd: string) => ({ kind: "in-memory", cwd }),
  },
  SettingsManager: {
    create: (cwd: string, agentDir: string) => ({ cwd, agentDir }),
  },
  createAgentSession: async (options: any) => {
    createAgentSessionCalls.push(options);
    return { session: createSession() };
  },
  // The default subagent runner transitively imports lib/protected-bash, which
  // value-imports createLocalBashOperations from this module.
  createBashToolDefinition: (_cwd: string, options: any) => ({
    name: "bash",
    label: "bash",
    operations: options?.operations,
    execute: async () => ({ content: [{ type: "text", text: "bash result" }], details: undefined }),
  }),
  createLocalBashOperations: () => ({ exec: async () => ({ exitCode: 0, output: "" }) }),
}));
mock.module("@earendil-works/pi-tui", () => ({
  Key: { enter: { name: "enter" }, escape: { name: "escape" } },
  Text: class {
    constructor(public value: string) {}
  },
  matchesKey: (data: string, key: string | { name?: string }) =>
    typeof key === "string" ? data === key : data === key.name,
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
  visibleWidth: (text: string) => text.length,
  wrapTextWithAnsi: (text: string, width: number) => {
    if (text.length <= width) return [text];
    const lines: string[] = [];
    for (let index = 0; index < text.length; index += width) {
      lines.push(text.slice(index, index + width));
    }
    return lines;
  },
}));
installTypeboxMock();

export async function loadWorkflowToolModule() {
  return await import("./workflow-tool");
}

const tempDirs: string[] = [];

export function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-tool-"));
  tempDirs.push(dir);
  return dir;
}

export function tempWorkflowRoot(): string {
  return join(tempCwd(), ".pi", "workflows");
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function writeWorkflowFile(root: string, fileName: string, script: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, fileName);
  writeFileSync(path, script);
  return path;
}

export function readJournalLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

afterEach(() => {
  createAgentSessionCalls.splice(0);
  loaderInstances.splice(0);
  createdSessions.splice(0);
  nextResultText = "workflow subagent result";
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
