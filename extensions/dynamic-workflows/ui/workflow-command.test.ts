import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeUi } from "../../../tests/support/fake-ui";
import type { SavedWorkflow } from "../saved/resolver";
import {
  createWorkflowToolCommandLauncher,
  isDirectWorkflowCommandNameSafe,
  parseWorkflowCommandArgs,
  registerDirectSavedWorkflowCommands,
  registerDirectSavedWorkflowCommandsForRoot,
  registerWorkflowCommand,
  type WorkflowCommandLaunchInput,
} from "./workflow-command";

type CommandDefinition = {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => Promise<unknown[] | null> | unknown[] | null;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};

type EventHandler = (event: unknown, ctx: unknown) => unknown;

const tempDirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-command-"));
  tempDirs.push(dir);
  return dir;
}

function writeSavedWorkflow(cwd: string, fileName: string, script: string): string {
  return writeWorkflowFile(join(cwd, ".pi", "workflows"), fileName, script);
}

function writeWorkflowFile(root: string, fileName: string, script: string): string {
  mkdirSync(root, { recursive: true });
  const path = join(root, fileName);
  writeFileSync(path, script);
  return path;
}

function createPi(launchWorkflow: (input: WorkflowCommandLaunchInput, ctx: unknown) => unknown) {
  const pi = createCommandPi();
  registerWorkflowCommand(pi as never, { launchWorkflow: launchWorkflow as never });
  return pi;
}

function createCommandPi(existingCommandNames: string[] = []) {
  const commands = new Map<string, CommandDefinition>();
  const events = new Map<string, EventHandler[]>();
  return {
    commands,
    events,
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    on(name: string, handler: EventHandler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    getCommands() {
      return [...existingCommandNames, ...commands.keys()].map((name) => ({ name }));
    },
  };
}

async function emitSessionStart(
  pi: { events: Map<string, EventHandler[]> },
  cwd: string,
  ui = createFakeUi(),
): Promise<void> {
  await Promise.all(
    (pi.events.get("session_start") ?? []).map((handler) =>
      handler({ type: "session_start", reason: "startup" }, { cwd, ui }),
    ),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("/workflow command", () => {
  test("parses the workflow name and optional JSON args", () => {
    expect(parseWorkflowCommandArgs("repo_review")).toEqual({ name: "repo_review" });
    expect(parseWorkflowCommandArgs('repo_review {"target":"src"}')).toEqual({
      name: "repo_review",
      args: { target: "src" },
    });
    expect(parseWorkflowCommandArgs('"Review Repo" {"target":"src"}')).toEqual({
      name: "Review Repo",
      args: { target: "src" },
    });
    expect(parseWorkflowCommandArgs("   ")).toBeUndefined();
    expect(() => parseWorkflowCommandArgs("repo_review {bad")).toThrow("JSON");
    expect(() => parseWorkflowCommandArgs('"Review Repo')).toThrow("unterminated");
  });

  test("launches a saved workflow by name and reports the background run", async () => {
    const cwd = tempCwd();
    const workflowPath = writeSavedWorkflow(
      cwd,
      "repo-review.js",
      `
        export const meta = {
          name: "repo_review",
          description: "Review the repository",
          phases: [{ title: "Review" }],
        };
        return await agent("review " + args.target, { label: "review" });
      `,
    );
    const launches: WorkflowCommandLaunchInput[] = [];
    const pi = createPi((input) => {
      launches.push(input);
      return {
        runId: "wf_command_12345678",
        artifactDir: join(cwd, ".pi", "workflows", "wf_command_12345678"),
        outputPath: join(cwd, ".pi", "workflows", "wf_command_12345678", "output.json"),
      };
    });
    const ui = createFakeUi();

    await pi.commands.get("workflow")!.handler('repo_review {"target":"src"}', {
      cwd,
      ui,
      isIdle: () => true,
    });

    expect(launches).toEqual([
      {
        workflow: expect.objectContaining({
          name: "repo_review",
          description: "Review the repository",
          path: workflowPath,
          script: expect.stringContaining("return await agent"),
        }),
        args: { target: "src" },
      },
    ]);
    expect(ui.notifications).toEqual([
      {
        level: "info",
        message: expect.stringContaining("ワークフロー「repo_review」を起動しました") as never,
      },
    ]);
    expect(ui.notifications[0]!.message).toContain("runId: wf_command_12345678");
    expect(ui.notifications[0]!.message).toContain("output.json");
  });

  test("launches a skill-packaged workflow by name through additional roots", async () => {
    const cwd = tempCwd();
    const packageRoot = mkdtempSync(join(tmpdir(), "pi-workflow-command-package-"));
    tempDirs.push(packageRoot);
    const skillWorkflowRoot = join(packageRoot, "skills", "deep-research", "workflows");
    const workflowPath = writeWorkflowFile(
      skillWorkflowRoot,
      "deep-research.js",
      `
        export const meta = {
          name: "deep_research",
          description: "Run packaged deep research",
          phases: [{ title: "Research" }],
        };
        return await agent("research " + args.topic, { label: "research" });
      `,
    );
    const launches: WorkflowCommandLaunchInput[] = [];
    const pi = createCommandPi();
    registerWorkflowCommand(pi as never, {
      launchWorkflow: ((input: WorkflowCommandLaunchInput) => {
        launches.push(input);
        return { runId: "wf_skill_12345678" };
      }) as never,
      additionalWorkflowRoots: () => [skillWorkflowRoot],
    });
    await emitSessionStart(pi, cwd);
    const ui = createFakeUi();

    await expect(pi.commands.get("workflow")!.getArgumentCompletions!("deep")).resolves.toEqual([
      {
        value: "deep_research",
        label: "deep_research",
        description: "Run packaged deep research",
      },
    ]);
    await pi.commands.get("workflow")!.handler('deep_research {"topic":"pi"}', {
      cwd,
      ui,
      isIdle: () => true,
    });

    expect(launches).toEqual([
      {
        workflow: expect.objectContaining({
          name: "deep_research",
          path: workflowPath,
          script: expect.stringContaining('agent("research " + args.topic'),
        }),
        args: { topic: "pi" },
      },
    ]);
    expect(ui.notifications).toEqual([
      {
        level: "info",
        message: expect.stringContaining("ワークフロー「deep_research」を起動しました") as never,
      },
    ]);
  });

  test("completes saved workflow names from the current session workflow root", async () => {
    const cwd = tempCwd();
    writeSavedWorkflow(
      cwd,
      "alpha.js",
      `export const meta = { name: "alpha", description: "Alpha workflow", phases: [{ title: "Run" }] };`,
    );
    writeSavedWorkflow(
      cwd,
      "beta.js",
      `export const meta = { name: "beta", phases: [{ title: "Run" }] };`,
    );
    const pi = createPi(() => undefined);
    const command = pi.commands.get("workflow")!;

    await expect(command.getArgumentCompletions!("a")).resolves.toBeNull();
    await emitSessionStart(pi, cwd);

    await expect(command.getArgumentCompletions!("a")).resolves.toEqual([
      { value: "alpha", label: "alpha", description: "Alpha workflow" },
    ]);
    await expect(command.getArgumentCompletions!("alpha {")).resolves.toBeNull();
  });

  test("reports usage, busy state, invalid JSON args, and missing workflows", async () => {
    const cwd = tempCwd();
    const launches: WorkflowCommandLaunchInput[] = [];
    const pi = createPi((input) => launches.push(input));
    const command = pi.commands.get("workflow")!;
    const ui = createFakeUi();

    await command.handler("", { cwd, ui, isIdle: () => true });
    await command.handler("repo_review", { cwd, ui, isIdle: () => false });
    await command.handler("repo_review {bad", { cwd, ui, isIdle: () => true });
    await command.handler("missing", { cwd, ui, isIdle: () => true });

    expect(launches).toEqual([]);
    expect(ui.notifications).toEqual([
      { level: "error", message: "使い方: /workflow <name> [JSON args]" },
      {
        level: "warning",
        message: "エージェントが処理中です。完了後に再実行してください。",
      },
      {
        level: "error",
        message: expect.stringContaining("args は JSON として指定してください") as never,
      },
      {
        level: "error",
        message: expect.stringContaining("saved workflow not found: missing") as never,
      },
    ]);
  });

  test("registers direct commands for safe saved workflow names", async () => {
    const cwd = tempCwd();
    const workflowPath = writeSavedWorkflow(
      cwd,
      "repo-review.js",
      `
        export const meta = {
          name: "repo_review",
          description: "Review the repository",
          phases: [{ title: "Run" }],
        };
        return await agent("review", { label: "review" });
      `,
    );
    const launches: WorkflowCommandLaunchInput[] = [];
    const pi = createCommandPi(["workflow", "workflows"]);

    const report = await registerDirectSavedWorkflowCommandsForRoot(
      pi as never,
      join(cwd, ".pi", "workflows"),
      {
        launchWorkflow: ((input: WorkflowCommandLaunchInput) => {
          launches.push(input);
          return undefined;
        }) as never,
      },
    );

    expect(report).toEqual({
      registered: [
        {
          name: "repo_review",
          commandName: "repo_review",
          path: workflowPath,
          fallbackCommand: "/workflow repo_review",
        },
      ],
      skipped: [],
    });
    expect(pi.commands.get("repo_review")?.description).toContain("/workflow repo_review");

    const ui = createFakeUi();
    await pi.commands.get("repo_review")!.handler('{"target":"src"}', {
      cwd,
      ui,
      isIdle: () => true,
    });

    expect(launches).toEqual([
      {
        workflow: expect.objectContaining({ name: "repo_review", path: workflowPath }),
        args: { target: "src" },
      },
    ]);
    expect(ui.notifications[0]).toEqual({
      level: "info",
      message: expect.stringContaining(
        "/repo_review: ワークフロー「repo_review」を起動しました",
      ) as never,
    });
  });

  test("skips unsafe, duplicate, and colliding direct command names with fallback guidance", async () => {
    const cwd = tempCwd();
    writeSavedWorkflow(
      cwd,
      "unsafe.js",
      `export const meta = { name: "Review Repo", phases: [{ title: "Run" }] };`,
    );
    writeSavedWorkflow(
      cwd,
      "duplicate-a.js",
      `export const meta = { name: "duplicate", phases: [{ title: "Run" }] };`,
    );
    writeSavedWorkflow(
      cwd,
      "duplicate-b.js",
      `export const meta = { name: "duplicate", phases: [{ title: "Run" }] };`,
    );
    writeSavedWorkflow(
      cwd,
      "workflow.js",
      `export const meta = { name: "workflow", phases: [{ title: "Run" }] };`,
    );
    writeSavedWorkflow(
      cwd,
      "settings.js",
      `export const meta = { name: "settings", phases: [{ title: "Run" }] };`,
    );
    writeSavedWorkflow(
      cwd,
      "valid.js",
      `export const meta = { name: "valid-flow", phases: [{ title: "Run" }] };`,
    );
    const pi = createCommandPi(["workflow"]);

    const report = await registerDirectSavedWorkflowCommandsForRoot(
      pi as never,
      join(cwd, ".pi", "workflows"),
      { launchWorkflow: (() => undefined) as never },
    );

    expect(report.registered.map((registration) => registration.commandName)).toEqual([
      "valid-flow",
    ]);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Review Repo",
          reason: "unsafe_name",
          fallbackCommand: '/workflow "Review Repo"',
        }),
        expect.objectContaining({
          name: "duplicate",
          reason: "duplicate_saved_name",
          fallbackCommand: "/workflow duplicate",
        }),
        expect.objectContaining({
          name: "workflow",
          reason: "command_collision",
          fallbackCommand: "/workflow workflow",
        }),
        expect.objectContaining({
          name: "settings",
          reason: "command_collision",
          fallbackCommand: "/workflow settings",
        }),
      ]),
    );
    expect(pi.commands.has("Review Repo")).toBe(false);
    expect(pi.commands.has("duplicate")).toBe(false);
    expect(pi.commands.has("workflow")).toBe(false);
    expect(pi.commands.has("settings")).toBe(false);
    expect(pi.commands.has("valid-flow")).toBe(true);
  });

  test("registers direct commands on session start and warns about collisions", async () => {
    const cwd = tempCwd();
    writeSavedWorkflow(
      cwd,
      "review.js",
      `export const meta = { name: "review", phases: [{ title: "Run" }] };`,
    );
    writeSavedWorkflow(
      cwd,
      "existing.js",
      `export const meta = { name: "existing", phases: [{ title: "Run" }] };`,
    );
    const pi = createCommandPi(["workflow", "existing"]);
    registerDirectSavedWorkflowCommands(pi as never, {
      launchWorkflow: (() => undefined) as never,
    });
    const ui = createFakeUi();

    await emitSessionStart(pi, cwd, ui);

    expect(pi.commands.has("review")).toBe(true);
    expect(pi.commands.has("existing")).toBe(false);
    expect(ui.notifications).toEqual([
      {
        level: "warning",
        message: expect.stringContaining("/workflow existing") as never,
      },
    ]);
  });

  test("validates command-safe workflow names", () => {
    expect(isDirectWorkflowCommandNameSafe("repo_review")).toBe(true);
    expect(isDirectWorkflowCommandNameSafe("repo-review2")).toBe(true);
    expect(isDirectWorkflowCommandNameSafe("RepoReview")).toBe(false);
    expect(isDirectWorkflowCommandNameSafe("review repo")).toBe(false);
    expect(isDirectWorkflowCommandNameSafe("1review")).toBe(false);
  });

  test("uses the workflow tool as the command launcher", async () => {
    const calls: unknown[][] = [];
    const tool = {
      async execute(...args: unknown[]) {
        calls.push(args);
        return { details: { runId: "wf_tool_12345678", artifactDir: "/artifacts" } };
      },
    };
    const launcher = createWorkflowToolCommandLauncher(tool as never);
    const workflow: SavedWorkflow = {
      name: "tool_workflow",
      phases: [{ title: "Run" }],
      path: "/repo/.pi/workflows/tool-workflow.js",
      fileName: "tool-workflow.js",
      script: "export const meta = {};",
    };
    const signal = new AbortController().signal;
    const ctx = { signal };

    await expect(launcher({ workflow, args: { target: "src" } }, ctx as never)).resolves.toEqual({
      runId: "wf_tool_12345678",
      artifactDir: "/artifacts",
    });
    expect(calls).toEqual([
      [
        "workflow-command",
        { script: "export const meta = {};", args: { target: "src" } },
        signal,
        undefined,
        ctx,
      ],
    ]);
  });
});
