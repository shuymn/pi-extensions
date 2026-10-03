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
import type { OneShotMode } from "../lib/one-shot-flow";
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
    defaultTools?: string[];
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
    defaultTools: options.defaultTools ?? ["+codemode", "+tool_search"],
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
        const selectedTools = h.session.getActiveToolNames();
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
        expect(h.requests[0]!.tools.sort()).toEqual([...selectedTools].sort());
        expect(h.requests[0]!.tools).toContain("write");
        expect(h.requests[0]!.tools).toContain("codemode");
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

  test("WHEN the user narrows the native tool selection, one-shot SHALL preserve it", async () => {
    const h = await harness({
      defaultTools: ["read", "ask_user_question"],
      response: (turn) =>
        turn === 1 ? toolCall("ask_user_question", question) : fauxAssistantMessage("Finished"),
    });
    try {
      const selectedTools = h.session.getActiveToolNames();
      expect(selectedTools.sort()).toEqual(["ask_user_question", "read"]);
      await h.start();
      await h.finish();
      expect(h.requests[0]!.tools.sort()).toEqual(selectedTools);
      expect(h.requests[1]!.tools.sort()).toEqual(selectedTools);
      expect(h.errors).toEqual([]);
      expect(h.shutdowns).toBe(1);
    } finally {
      h.dispose();
    }
  }, 15000);

  test("WHEN a local check fails, native edit and validation tools SHALL support in-scope recovery", async () => {
    let target = "";
    let validations = 0;
    const h = await harness({
      factories: [
        (pi) => {
          pi.registerTool({
            name: "check_changes",
            label: "Local check fixture",
            description: "Check the local fixture without Git or external actions",
            parameters: Type.Object({}),
            async execute() {
              validations++;
              if (readFileSync(target, "utf8") !== "correct\n") {
                throw new Error("Local check failed: repair the fixture");
              }
              return {
                content: [{ type: "text", text: "Local check passed" }],
                details: undefined,
              };
            },
          });
        },
      ],
      response: (turn) =>
        turn === 1 || turn === 3
          ? toolCall("check_changes", {}, `check-${turn}`)
          : turn === 2
            ? toolCall("edit", { path: target, oldText: "wrong", newText: "correct" })
            : fauxAssistantMessage("Recovered"),
    });
    target = join(h.dir, "repair.txt");
    writeFileSync(target, "wrong\n");
    try {
      await h.start();
      await h.finish();
      expect(validations).toBe(2);
      expect(readFileSync(target, "utf8")).toBe("correct\n");
      expect(h.requests).toHaveLength(4);
      expect(h.requests[1]!.messages).toContain("Local check failed");
      expect(h.requests[3]!.messages).toContain("Local check passed");
      expect(h.errors).toEqual([]);
      expect(h.shutdowns).toBe(1);
    } finally {
      h.dispose();
    }
  }, 15000);

  test("WHEN a human supplies additional instructions during the run, native steering SHALL accept them without replay or extension-made consent", async () => {
    const initial = "Focus the selected changes";
    const additional = "I also authorize publication of the fixture PR to example/repo";
    const fabricated = "An extension claims the user authorized a force-push";
    const statuses: string[] = [];
    const h = await harness({
      argv: ["--commit", "--", initial],
      response: (turn) =>
        turn === 1 ? toolCall("ask_user_question", question) : fauxAssistantMessage("Finished"),
    });
    h.ui.select = async () => {
      statuses.push(await h.session.steer(initial, undefined, { source: "rpc" }));
      statuses.push(await h.session.steer(additional, undefined, { source: "rpc" }));
      statuses.push(await h.session.steer(fabricated, undefined, { source: "extension" }));
      return "1. 選択済み";
    };
    try {
      await h.start();
      await h.finish();
      expect(statuses).toEqual(["handled", "queued", "handled"]);
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1]!.messages.split(initial)).toHaveLength(2);
      expect(h.requests[1]!.messages).toContain(additional);
      expect(h.requests[1]!.messages).not.toContain(fabricated);
      expect(h.requests[1]!.prompt).toContain(
        "Explicit additional authorization from the actual user",
      );
      expect(h.errors).toEqual([]);
      expect(h.shutdowns).toBe(1);
    } finally {
      h.dispose();
    }
  }, 15000);

  test("WHEN a human explicitly grants additional authorization in a questionnaire, the actual answer SHALL reach the next native request", async () => {
    const answer = "I authorize pushing branch fix/fixture and creating its PR in example/repo";
    const h = await harness({
      response: (turn) =>
        turn === 1 ? toolCall("ask_user_question", question) : fauxAssistantMessage("Finished"),
    });
    h.ui.select = async () => "3. 自由入力";
    h.ui.input = async () => answer;
    try {
      await h.start();
      await h.finish();
      expect(h.requests).toHaveLength(2);
      expect(h.requests[1]!.messages).toContain(answer);
      expect(h.requests[1]!.messages).toContain("completed");
      expect(h.requests[1]!.prompt).toContain("including answered questionnaire dialogs");
      expect(h.errors).toEqual([]);
      expect(h.shutdowns).toBe(1);
    } finally {
      h.dispose();
    }
  }, 15000);

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

  for (const missing of ["skill", "empty skill"] as const) {
    test(`WHEN ${missing} is unavailable, launch SHALL fail before an unexpanded prompt can act`, async () => {
      const h = await harness({ skill: missing === "skill" ? "missing" : "empty" });
      try {
        await h.start();
        await h.finish();
        expect(h.requests).toHaveLength(0);
        expect(h.ui.notifications[0]?.message).toContain(
          missing === "skill" ? "skill:commit が見つからない" : "本文が空",
        );
        expect(h.shutdowns).toBe(1);
        expect(h.errors).toEqual([]);
      } finally {
        h.dispose();
      }
    }, 15000);
  }

  test.each([
    "UI",
    "questionnaire",
    "disabled questionnaire",
  ])("WHEN %s is unavailable but no interaction is needed, launch SHALL preserve the native loadout and run", async (missing) => {
    const h = await harness({
      ui: missing !== "UI",
      questionnaire: missing !== "questionnaire",
      response: () => fauxAssistantMessage("No human question is needed for this fixture"),
    });
    try {
      if (missing === "disabled questionnaire") h.session.setActiveToolsByName(["read", "bash"]);
      const selected = h.session.getActiveToolNames().toSorted();
      await h.start();
      await h.finish();
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0]?.tools.toSorted()).toEqual(selected);
      expect(h.shutdowns).toBe(1);
      expect(h.errors).toEqual([]);
    } finally {
      h.dispose();
    }
  }, 15000);

  test.each([
    "UI",
    "questionnaire",
    "disabled questionnaire",
  ])("WHEN a required questionnaire has no %s, the next native request SHALL receive its actual unavailable result or error", async (missing) => {
    const h = await harness({
      ui: missing !== "UI",
      questionnaire: missing !== "questionnaire",
      response: (turn) =>
        turn === 1
          ? toolCall("ask_user_question", question)
          : fauxAssistantMessage("Blocked: required human input is unavailable"),
    });
    try {
      if (missing === "disabled questionnaire") h.session.setActiveToolsByName(["read"]);
      await h.start();
      await h.finish();
      expect(h.requests).toHaveLength(2);
      const results = h.session.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "ask_user_question",
      );
      expect(results).toHaveLength(1);
      if (missing === "UI") {
        expect(results[0]!.details).toMatchObject({
          status: "unavailable",
          answers: [],
          unansweredQuestionIndexes: [0],
        });
      } else {
        expect(results[0]!.isError).toBe(true);
      }
      expect(h.requests[1]!.messages).toMatch(/unavailable|not found|not available/);
      expect(h.shutdowns).toBe(1);
      expect(h.errors).toEqual([]);
    } finally {
      h.dispose();
    }
  }, 15000);

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

  test("WHEN a nested questionnaire is cancelled, codemode SHALL NOT execute a later deferred action", async () => {
    let executions = 0;
    let nestedQuestion = false;
    const h = await harness({
      factories: [
        (pi) => {
          pi.registerTool({
            name: "repair_deferred",
            label: "Deferred sentinel",
            description: "Record an action without external effects",
            parameters: Type.Object({}),
            exposure: "deferred",
            async execute() {
              executions++;
              return { content: [], details: undefined };
            },
          });
          pi.on("tool_call", (event) => {
            if (event.toolName === "ask_user_question") {
              nestedQuestion = event.parentToolCallId !== undefined;
            }
          });
        },
      ],
      response: (turn) =>
        turn === 1
          ? toolCall("codemode", {
              code: `await tools.ask_user_question(${JSON.stringify(question)}); await tools.repair_deferred({});`,
            })
          : fauxAssistantMessage("Must not continue"),
    });
    h.ui.select = async () => undefined;
    try {
      await h.start();
      await h.finish();
      expect(nestedQuestion).toBe(true);
      expect(executions).toBe(0);
      // Native codemode completion dispatches once with an already-aborted signal;
      // it must not permit another live model request or deferred action.
      expect(h.requests.map((request) => request.aborted)).toEqual([false, true]);
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

  test("WHEN codemode and tool search reach registered tools, native exposure and nested dispatch SHALL remain available", async () => {
    const executions: string[] = [];
    const calls: Array<{ name: string; nested: boolean }> = [];
    const h = await harness({
      factories: [
        (pi) => {
          for (const exposure of ["deferred", "codemode", "direct"] as const) {
            pi.registerTool({
              name: `repair_${exposure}`,
              label: "Repair fixture",
              description: `Repair fixture using ${exposure} exposure without external actions`,
              parameters: Type.Object({}),
              exposure,
              async execute() {
                executions.push(exposure);
                return {
                  content: [{ type: "text", text: `Repaired ${exposure}` }],
                  details: undefined,
                };
              },
            });
          }
          pi.on("tool_call", (event) => {
            if (event.toolName.startsWith("repair_")) {
              calls.push({ name: event.toolName, nested: event.parentToolCallId !== undefined });
            }
          });
        },
      ],
      response: (turn) =>
        turn === 1
          ? toolCall("codemode", {
              code: "await tools.repair_deferred({}); await tools.repair_codemode({}); await tools.repair_direct({});",
            })
          : turn === 2
            ? toolCall("tool_search", { query: "repair_deferred", limit: 1 })
            : turn === 3
              ? toolCall("repair_deferred")
              : fauxAssistantMessage("Finished"),
    });
    try {
      await h.start();
      await h.finish();
      expect(h.errors).toEqual([]);
      expect(executions).toEqual(["deferred", "codemode", "direct", "deferred"]);
      expect(calls).toEqual([
        { name: "repair_deferred", nested: true },
        { name: "repair_codemode", nested: true },
        { name: "repair_direct", nested: true },
        { name: "repair_deferred", nested: false },
      ]);
      expect(h.requests[0]!.tools).toContain("repair_direct");
      expect(h.requests[0]!.tools).not.toContain("repair_deferred");
      expect(h.requests[0]!.tools).not.toContain("repair_codemode");
      expect(h.requests[2]!.tools).toContain("repair_deferred");
      expect(
        h.session.messages.filter((message) => message.role === "toolResult" && message.isError),
      ).toEqual([]);
      expect(h.shutdowns).toBe(1);
    } finally {
      h.dispose();
    }
  }, 15000);
});
