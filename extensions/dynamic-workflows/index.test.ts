import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeUi } from "../../tests/support/fake-ui";
import { installTypeboxMock } from "../../tests/support/typebox-mock";

mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/agent-dir",
  DefaultResourceLoader: class {},
  SessionManager: { inMemory: (cwd: string) => ({ cwd }) },
  SettingsManager: { create: (cwd: string, agentDir: string) => ({ cwd, agentDir }) },
  createAgentSession: async () => {
    throw new Error("createAgentSession should not run during registration");
  },
}));
mock.module("@earendil-works/pi-tui", () => ({
  Key: { up: "up", down: "down", enter: "enter", escape: "escape" },
  matchesKey: (data: string, key: string) => data === key,
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
  visibleWidth: (text: string) => text.length,
  wrapTextWithAnsi: (text: string, width: number) => {
    const lines: string[] = [];
    for (let index = 0; index < text.length; index += width) {
      lines.push(text.slice(index, index + width));
    }
    return lines.length === 0 ? [""] : lines;
  },
}));
installTypeboxMock();

type ToolDefinition = { name: string; label: string; description: string };
type CommandDefinition = {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => Promise<unknown[] | null> | unknown[] | null;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};
type EventHandler = (event: unknown, ctx: unknown) => unknown;

const tempDirs: string[] = [];

async function loadExtension() {
  return (await import("./index")).default;
}

function createExtensionPi() {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, EventHandler[]>();
  return {
    tools,
    commands,
    events,
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    on(name: string, handler: EventHandler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    sendMessage() {},
    getThinkingLevel: () => "medium",
    getCommands: () => [...commands.keys()].map((name) => ({ name })),
  };
}

function writeWorkflowFile(root: string, fileName: string, script: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, fileName);
  writeFileSync(path, script);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dynamic workflows extension", () => {
  test("registers the workflow LLM Tool, workflow commands, and lifecycle hooks", async () => {
    const extension = await loadExtension();
    const pi = createExtensionPi();

    extension(pi as never);

    expect([...pi.tools.keys()]).toEqual(["workflow"]);
    expect(pi.tools.get("workflow")).toMatchObject({
      label: "Workflow",
      description: expect.stringContaining("deterministic JavaScript workflow"),
    });
    expect([...pi.commands.keys()]).toEqual(["workflows", "workflow", "ultracode"]);
    expect(pi.commands.get("workflows")?.description).toContain("dynamic workflow runs");
    expect(pi.commands.get("workflow")?.description).toContain("saved dynamic workflow");
    expect(pi.events.get("session_start")).toHaveLength(3);
    expect(pi.events.get("before_agent_start")).toHaveLength(2);
  });

  test("injects optional ultracode policy only after /ultracode enables it", async () => {
    const extension = await loadExtension();
    const pi = createExtensionPi();
    const ui = createFakeUi();

    extension(pi as never);

    const disabledResults = await Promise.all(
      (pi.events.get("before_agent_start") ?? []).map((handler) =>
        handler(
          {
            type: "before_agent_start",
            prompt: "audit repo",
            systemPrompt: "base prompt",
            systemPromptOptions: {},
          },
          { cwd: "/repo", ui },
        ),
      ),
    );
    expect(disabledResults).toEqual([undefined, undefined]);

    await pi.commands.get("ultracode")!.handler("on", { ui });
    const enabledResults = await Promise.all(
      (pi.events.get("before_agent_start") ?? []).map((handler) =>
        handler(
          {
            type: "before_agent_start",
            prompt: "audit repo",
            systemPrompt: "base prompt",
            systemPromptOptions: {},
          },
          { cwd: "/repo", ui },
        ),
      ),
    );

    expect(enabledResults).toEqual([
      undefined,
      { systemPrompt: expect.stringContaining("ultracode policy mode is ON") },
    ]);
    expect((enabledResults[1] as { systemPrompt: string }).systemPrompt).toContain(
      "not automatically selected",
    );
  });

  test("exposes loaded skill-packaged workflows to /workflow completions", async () => {
    const extension = await loadExtension();
    const pi = createExtensionPi();
    const cwd = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-entry-"));
    const packageRoot = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-package-"));
    tempDirs.push(cwd, packageRoot);
    const skillBaseDir = join(packageRoot, "skills", "deep-research");
    writeWorkflowFile(
      join(skillBaseDir, "workflows"),
      "deep-research.js",
      `export const meta = { name: "deep-research", description: "Packaged deep research", phases: [{ title: "Research" }] };
return await agent("research");`,
    );

    extension(pi as never);
    await Promise.all(
      (pi.events.get("session_start") ?? []).map((handler) =>
        handler({ type: "session_start", reason: "startup" }, { cwd, ui: createFakeUi() }),
      ),
    );
    await Promise.all(
      (pi.events.get("before_agent_start") ?? []).map((handler) =>
        handler(
          {
            type: "before_agent_start",
            prompt: "run research",
            systemPrompt: "base",
            systemPromptOptions: {
              cwd,
              skills: [
                { name: "deep-research", description: "", filePath: "", baseDir: skillBaseDir },
              ],
            },
          },
          { cwd },
        ),
      ),
    );

    await expect(pi.commands.get("workflow")!.getArgumentCompletions!("deep")).resolves.toEqual([
      {
        value: "deep-research",
        label: "deep-research",
        description: "Packaged deep research",
      },
    ]);
  });
});
