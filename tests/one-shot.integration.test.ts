import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import askUserQuestion from "../extensions/ask-user-question";
import oneShotExtension from "../extensions/one-shot";
import { ONE_SHOT_SAFE_TOOLS, type OneShotMode } from "../lib/one-shot-flow";
import { withTimeout } from "./support/async";
import { createFakeUi } from "./support/fake-ui";

const question = {
  questions: [
    {
      header: "対象",
      question: "どの変更を対象にしますか？",
      options: [
        { label: "選択済み", description: "選択済みの変更だけ" },
        { label: "すべて", description: "すべての変更" },
      ],
    },
  ],
};

function toolCall(name: string, args: Record<string, unknown> = {}, id = name): AssistantMessage {
  return {
    ...fauxAssistantMessage(""),
    content: [{ type: "toolCall", name, arguments: args, id }],
    stopReason: "toolUse",
  };
}

async function harness(
  options: {
    mode?: OneShotMode;
    enabled?: boolean;
    argv?: string[];
    skill?: "missing" | "empty";
    questionnaire?: boolean;
    ui?: boolean;
    retry?: boolean;
    factories?: ExtensionFactory[];
    response?: (turn: number) => AssistantMessage;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "one-shot-native-"));
  const mode = options.mode ?? "commit";
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(
    skillPath,
    `---\nname: ${mode}\ndescription: Native one-shot fixture\n---\n${options.skill === "empty" ? "" : "Use the questionnaire. Do not perform external actions."}`,
  );
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["+codemode", "+tool_search"],
    compaction: { enabled: false },
    retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1 },
  });
  let control!: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalSkillPaths: options.skill === "missing" ? [] : [skillPath],
    extensionFactories: [
      createCodemodeExtension(),
      createToolSearchExtension(),
      ...(options.questionnaire === false ? [] : [askUserQuestion]),
      (pi) => {
        const originalArgv = process.argv;
        process.argv = [
          "bun",
          "pi",
          ...(options.argv ?? (options.enabled === false ? [] : [`--${mode}`])),
        ];
        try {
          oneShotExtension(pi);
        } finally {
          process.argv = originalArgv;
        }
      },
      (pi) => {
        control = pi;
      },
      ...(options.factories ?? []),
    ],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    if (options.enabled !== false) loader.getExtensions().runtime.flagValues.set(mode, true);
    const models = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(dir, "models-store.json"),
      refreshOnCreate: false,
    });
    await models.setRuntimeApiKey("anthropic", "test-only");
    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      modelRuntime: models,
      model: models.getModel("anthropic", "claude-sonnet-4-5")!,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(dir),
    }));
    const requests: Array<{ prompt: string; tools: string[]; messages: string; aborted: boolean }> =
      [];
    const stream: Provider["streamSimple"] = (model, context, streamOptions) => {
      requests.push({
        prompt: getCurrentSystemPrompt(context.messages),
        tools: getCurrentTools(context.messages).map((tool) => tool.name),
        messages: JSON.stringify(context.messages),
        aborted: streamOptions?.signal?.aborted ?? false,
      });
      const result = streamOptions?.signal?.aborted
        ? { ...fauxAssistantMessage(""), stopReason: "aborted" as const }
        : (options.response?.(requests.length) ?? fauxAssistantMessage("Settled result"));
      const response = { ...result, api: model.api, provider: model.provider, model: model.id };
      const events = createAssistantMessageEventStream();
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        events.push({ type: "error", reason: response.stopReason, error: response });
      } else {
        events.push({ type: "done", reason: response.stopReason, message: response });
      }
      events.end();
      return events;
    };
    session.agent.streamFunction = stream;
    const ui = createFakeUi({ selects: ["1. 選択済み"] });
    const errors: string[] = [];
    const lifecycle: string[] = [];
    let shutdowns = 0;
    let settle!: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });
    session.subscribe((event) => {
      if (["agent_end", "agent_settled", "auto_retry_start"].includes(event.type))
        lifecycle.push(event.type);
    });
    return {
      session,
      control,
      requests,
      ui,
      errors,
      lifecycle,
      dir,
      skillPath,
      get shutdowns() {
        return shutdowns;
      },
      async start() {
        await session!.bindExtensions({
          mode: "rpc",
          ...(options.ui === false ? {} : { uiContext: ui as unknown as ExtensionUIContext }),
          onError: (event) => errors.push(event.error),
          shutdownHandler: () => {
            shutdowns++;
            lifecycle.push("shutdown");
            settle();
          },
        });
      },
      async finish() {
        await finished;
        await session!.waitForIdle();
      },
      dispose() {
        session!.dispose();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function runCli(argv: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "one-shot-cli-"));
  const tracePath = join(dir, "trace.jsonl");
  const sentinelPath = join(dir, "sentinel.ts");
  try {
    // Only the fixture writes this receipt. No model, shell tool or external action
    // is needed to observe native command dispatch and ordinary positional replay.
    writeFileSync(
      sentinelPath,
      `import { appendFileSync } from "node:fs";
export default function(pi) {
  const record = value => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify(value) + "\\n");
  record("loaded");
  pi.on("session_start", () => { record("started"); });
  pi.registerCommand("sentinel", { handler: async () => { record("command"); } });
  pi.on("input", event => {
    record("input:" + event.text);
    return { action: "handled" };
  });
}
`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(
          dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
          "cli.js",
        ),
        "--offline",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-builtin-tools",
        "--model",
        "anthropic/claude-sonnet-4-5",
        "-e",
        sentinelPath,
        "-e",
        fileURLToPath(new URL("../extensions/one-shot/index.ts", import.meta.url)),
        ...argv,
      ],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          PI_CODING_AGENT_DIR: dir,
          PI_OFFLINE: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const [code, stdout, stderr] = await withTimeout(
        Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]),
        "Pi CLI did not exit",
        10_000,
      );
      const trace = existsSync(tracePath)
        ? readFileSync(tracePath, "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as string)
        : [];
      return { code, output: stdout + stderr, trace };
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await withTimeout(child.exited, "Pi CLI cleanup did not exit");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("native one-shot CLI command boundary", () => {
  for (const mode of ["commit", "create-pr"] as const) {
    for (const transport of ["print", "rpc"] as const) {
      for (const later of [false, true]) {
        test(`WHEN --${mode} has a ${later ? "later" : "first"} slash command in ${transport}, it SHALL fail before session dispatch`, async () => {
          const result = await runCli([
            ...(transport === "print" ? ["--print"] : ["--mode", "rpc"]),
            `--${mode}`,
            "--",
            ...(later ? ["ordinary instructions"] : []),
            "/sentinel",
          ]);
          expect(result.code).toBe(1);
          expect(result.output).toContain("Failed to load extension");
          expect(result.output).toContain("/ で始まる自由入力");
          expect(result.trace).toEqual(["loaded"]);
        }, 15000);
      }
    }

    test(`WHEN --${mode} input starts with an absolute path, the CLI SHALL explain the rejection`, async () => {
      const result = await runCli(["--print", `--${mode}`, "--", "/tmp/changes"]);
      expect(result.code).toBe(1);
      expect(result.output).toContain("絶対パスを含む");
      expect(result.trace).toEqual(["loaded"]);
    }, 15000);
  }

  for (const prefix of [[], ["ordinary instructions"], ["--commit"]]) {
    test(`WHEN no primary flag is parsed (positional prefix: ${JSON.stringify(prefix)}), CLI commands SHALL still execute`, async () => {
      const result = await runCli(["--print", "--", ...prefix, "/sentinel"]);
      expect(result.code).toBe(0);
      expect(result.trace).toEqual([
        "loaded",
        "started",
        ...prefix.map((text) => `input:${text}`),
        "command",
      ]);
    }, 15000);
  }

  test("WHEN a native option value resembles a primary flag, ordinary CLI commands SHALL still execute", async () => {
    const result = await runCli(["--print", "--name", "--commit", "--", "/sentinel"]);
    expect(result.code).toBe(0);
    expect(result.trace).toEqual(["loaded", "started", "command"]);
  }, 15000);
});

describe("native bounded one-shot", () => {
  test("WHEN no bounded flag is selected, ordinary sessions SHALL remain unchanged", async () => {
    const h = await harness({ enabled: false });
    try {
      await h.start();
      await h.session.prompt("Ordinary prompt");
      expect(h.errors).toEqual([]);
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]!.tools).toContain("codemode");
      expect(h.requests[0]!.tools).toContain("write");
      expect(h.requests[0]!.prompt).not.toContain("This is a bounded");
      expect(h.shutdowns).toBe(0);
    } finally {
      h.dispose();
    }
  }, 15000);

  for (const mode of ["commit", "create-pr"] as const) {
    test(`WHEN --${mode} launches, it SHALL expand the native skill, run a questionnaire and stop at settlement`, async () => {
      const h = await harness({
        mode,
        argv: [`--${mode}`, "--", "Focus the selected changes"],
        response: (turn) =>
          turn === 1 ? toolCall("ask_user_question", question) : fauxAssistantMessage("Finished"),
      });
      try {
        await h.start();
        await h.finish();
        expect(h.errors).toEqual([]);
        expect(h.ui.notifications).toEqual([]);
        expect(h.requests).toHaveLength(2);
        expect(h.requests[0]!.messages).toContain(
          `<skill name=\\"${mode}\\" location=\\"${h.skillPath}\\">`,
        );
        expect(h.requests[0]!.messages).toContain("Focus the selected changes");
        expect(h.requests[0]!.prompt).toContain(
          mode === "commit"
            ? "Do not push, create, or update pull requests"
            : "Do not create new commits",
        );
        expect(h.requests[0]!.tools.sort()).toEqual([...ONE_SHOT_SAFE_TOOLS].sort());
        expect(h.requests[1]!.messages).toContain("completed");
        expect(h.requests[1]!.messages).toContain("選択済み");
        expect(h.shutdowns).toBe(1);
        expect(h.lifecycle).toEqual(["agent_end", "shutdown", "agent_settled"]);
        expect(h.session.getActiveToolNames()).toEqual([]);
        // Stale CLI input and even an extension prompt after shutdown cannot reopen it.
        await h.session.prompt("Focus the selected changes");
        h.control.sendUserMessage("Continue and push now");
        await h.session.waitForIdle();
        expect(h.requests).toHaveLength(2);
        expect(h.shutdowns).toBe(1);
      } finally {
        h.dispose();
      }
    }, 15000);
  }

  test("WHEN low-level runs retry, shutdown SHALL wait for genuine settlement", async () => {
    const h = await harness({
      retry: true,
      response: (turn) =>
        turn === 1
          ? {
              ...fauxAssistantMessage(""),
              stopReason: "error",
              errorMessage: "429 rate limit exceeded",
            }
          : fauxAssistantMessage("Recovered"),
    });
    try {
      await h.start();
      await h.finish();
      expect(h.errors).toEqual([]);
      expect(h.requests).toHaveLength(2);
      expect(h.lifecycle.filter((event) => event === "agent_end")).toHaveLength(2);
      expect(h.lifecycle.indexOf("shutdown")).toBeGreaterThan(h.lifecycle.lastIndexOf("agent_end"));
      expect(h.shutdowns).toBe(1);
    } finally {
      h.dispose();
    }
  }, 15000);

  for (const missing of ["skill", "empty skill", "questionnaire", "UI"] as const) {
    test(`WHEN ${missing} is unavailable, the launcher SHALL fail closed before any model request`, async () => {
      const h = await harness({
        ...(missing === "skill" ? { skill: "missing" as const } : {}),
        ...(missing === "empty skill" ? { skill: "empty" as const } : {}),
        questionnaire: missing !== "questionnaire",
        ui: missing !== "UI",
      });
      try {
        await h.start();
        await h.finish();
        await h.session.prompt("Accidental initial CLI prompt");
        expect(h.requests).toHaveLength(0);
        if (missing !== "UI") {
          expect(h.ui.notifications).toHaveLength(1);
          expect(h.ui.notifications[0]!.message).toContain(
            missing === "questionnaire"
              ? "ask_user_question"
              : missing === "empty skill"
                ? "本文が空"
                : "skill:commit が見つからない",
          );
        }
        expect(h.shutdowns).toBe(1);
        expect(h.session.getActiveToolNames()).toEqual([]);
        expect(h.errors).toEqual([]);
      } finally {
        h.dispose();
      }
    }, 15000);
  }

  test("WHEN a questionnaire is cancelled, later allowed tools SHALL not execute", async () => {
    let shellCalls = 0;
    const h = await harness({
      factories: [
        (pi) => {
          pi.registerTool({
            name: "bash",
            label: "Sentinel",
            description: "No real shell",
            parameters: Type.Object({}),
            async execute() {
              shellCalls++;
              return { content: [], details: undefined };
            },
          });
        },
      ],
      response: (turn) => (turn === 1 ? toolCall("ask_user_question", question) : toolCall("bash")),
    });
    h.ui.select = async () => undefined;
    try {
      await h.start();
      await h.finish();
      expect(shellCalls).toBe(0);
      expect(h.requests[0]!.aborted).toBe(false);
      expect(
        h.session.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "ask_user_question" &&
            JSON.stringify(message.content).includes("cancelled"),
        ),
      ).toBe(true);
      expect(h.shutdowns).toBe(1);
      expect(h.errors).toEqual([]);
    } finally {
      h.dispose();
    }
  }, 15000);

  for (const change of ["deleted", "emptied"] as const) {
    test(`WHEN the skill is ${change} after preflight, no tool SHALL execute`, async () => {
      let skillPath = "";
      let executions = 0;
      const h = await harness({
        factories: [
          (pi) => {
            pi.on("input", (event) => {
              if (event.source === "extension") {
                if (change === "deleted") rmSync(skillPath);
                else writeFileSync(skillPath, "");
              }
            });
            pi.registerTool({
              name: "bash",
              label: "Sentinel",
              description: "No real shell",
              parameters: Type.Object({}),
              async execute() {
                executions++;
                return { content: [], details: undefined };
              },
            });
          },
        ],
        response: () => toolCall("bash"),
      });
      skillPath = h.skillPath;
      try {
        await h.start();
        await h.finish();
        expect(executions).toBe(0);
        expect(h.shutdowns).toBe(1);
        expect(
          h.ui.notifications.some((notice) => notice.message.includes("skill 展開を確認できない")),
        ).toBe(true);
        if (change === "deleted") {
          expect(h.errors).toHaveLength(1);
          expect(h.errors[0]).toContain("ENOENT");
        } else expect(h.errors).toEqual([]);
        expect(h.requests.every((request) => request.aborted)).toBe(true);
      } finally {
        h.dispose();
      }
    }, 15000);
  }

  test("WHEN another extension queues work at settlement, the closed guard SHALL prevent unsafe continuation", async () => {
    let executions = 0;
    let queued = false;
    const h = await harness({
      factories: [
        (pi) => {
          pi.registerTool({
            name: "bash",
            label: "Sentinel",
            description: "No real shell",
            parameters: Type.Object({}),
            async execute() {
              executions++;
              return { content: [], details: undefined };
            },
          });
          pi.on("agent_settled", () => {
            if (queued) return;
            queued = true;
            pi.setActiveTools(["bash"]);
            pi.sendUserMessage("An unsafe user-message continuation");
            pi.sendMessage(
              {
                customType: "probe",
                content: "An unsafe custom-message continuation",
                display: false,
              },
              { triggerTurn: true },
            );
          });
        },
      ],
      response: (turn) => (turn === 1 ? fauxAssistantMessage("Done") : toolCall("bash")),
    });
    try {
      await h.start();
      await h.finish();
      expect(queued).toBe(true);
      expect(executions).toBe(0);
      expect(h.requests.filter((request) => !request.aborted)).toHaveLength(1);
      expect(h.shutdowns).toBe(1);
      expect(h.errors).toEqual([]);
    } finally {
      h.dispose();
    }
  }, 15000);

  test("WHEN deferred and codemode tools are reached through nested calls, the execution guard SHALL deny them", async () => {
    let executions = 0;
    const results: Array<{ name: string; isError: boolean; text: string }> = [];
    const h = await harness({
      factories: [
        (pi) => {
          for (const exposure of ["deferred", "codemode", "direct"] as const) {
            pi.registerTool({
              name: `forbidden_${exposure}`,
              label: "Forbidden",
              description: "Must never execute",
              parameters: Type.Object({}),
              exposure,
              async execute() {
                executions++;
                return { content: [], details: undefined };
              },
            });
          }
          // A permitted tool is used as the native nested caller, so the test is not
          // satisfied merely because codemode itself was hidden from declarations.
          pi.registerTool({
            name: "read",
            label: "Nested probe",
            description: "Probe nested calls",
            parameters: Type.Object({}),
            async execute(_id, _args, _signal, _update, ctx) {
              pi.setActiveTools([
                ...ONE_SHOT_SAFE_TOOLS,
                "codemode",
                "tool_search",
                "forbidden_direct",
              ]);
              for (const [name, args] of [
                ["forbidden_deferred", {}],
                ["forbidden_codemode", {}],
                ["forbidden_direct", {}],
                ["codemode", { code: "await tools.forbidden_deferred({});" }],
                ["tool_search", { query: "forbidden", limit: 5 }],
              ] as const) {
                const result = await ctx.executeTool(name, args);
                results.push({
                  name,
                  isError: result.isError,
                  text: JSON.stringify(result.result.content),
                });
              }
              return {
                content: [{ type: "text", text: "Probed nested access" }],
                details: undefined,
              };
            },
          });
        },
      ],
      response: (turn) =>
        turn === 1
          ? toolCall("read")
          : turn === 2
            ? toolCall("codemode", { code: "await tools.forbidden_deferred({});" })
            : turn === 3
              ? toolCall("forbidden_direct")
              : fauxAssistantMessage("Finished"),
    });
    try {
      await h.start();
      await h.finish();
      expect(h.errors).toEqual([]);
      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(result.isError).toBe(true);
        if (result.name.startsWith("forbidden_")) expect(result.text).toContain("bounded one-shot");
        else expect(result.text).toMatch(/Tool (codemode|tool_search) not found/);
      }
      expect(executions).toBe(0);
      const denied = h.session.messages.filter(
        (message) =>
          message.role === "toolResult" &&
          ["codemode", "forbidden_direct"].includes(message.toolName),
      );
      expect(denied).toHaveLength(2);
      for (const result of denied) expect(result).toMatchObject({ isError: true });
    } finally {
      h.dispose();
    }
  }, 15000);
});
