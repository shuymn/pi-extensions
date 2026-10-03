import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  getCurrentTools,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import reviewExtension from "../extensions/review";
import subagentsExtension from "../extensions/subagents";
import tavilyExtension from "../extensions/tavily";
import { TAVILY_TOOL_NAMES } from "../lib/tavily-tools";

const deferredNames = [
  ...TAVILY_TOOL_NAMES,
  "review",
  "get_subagent_result",
  "stop_subagent",
  "list_subagents",
];

test("Native tool search discovers extension capabilities without a custom loader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-tool-search-"));
  const errors: string[] = [];
  const declarations: string[][] = [];
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["+tool_search"],
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createToolSearchExtension(),
      tavilyExtension,
      subagentsExtension,
      reviewExtension,
    ],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
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
    expect(session.getActiveToolNames()).toContain("spawn_subagent");
    expect(session.getActiveToolNames()).toContain("tool_search");
    for (const name of deferredNames) {
      expect(session.getActiveToolNames()).not.toContain(name);
      expect(session.getCallableToolNames()).toContain(name);
    }
    let turn = 0;
    const streamResponse: Provider["streamSimple"] = (model, context) => {
      declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
      const stream = createAssistantMessageEventStream();
      const response = {
        ...fauxAssistantMessage("Done"),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      const query = deferredNames[turn++];
      if (query) {
        response.content = [
          {
            type: "toolCall",
            id: `call-${turn}`,
            name: "tool_search",
            arguments: { query, limit: deferredNames.length },
          },
        ];
        response.stopReason = "toolUse";
      }
      stream.push({
        type: "done",
        reason: response.stopReason as "stop" | "toolUse",
        message: response,
      });
      stream.end();
      return stream;
    };
    session.agent.streamFunction = streamResponse;
    await session.bindExtensions({ onError: (event) => errors.push(event.error) });
    await session.prompt("Discover the optional tools.");
    expect(errors).toEqual([]);
    for (const name of deferredNames) {
      expect(session.getActiveToolNames()).toContain(name);
      expect(declarations.at(-1)).toContain(name);
    }
    const names = session.getAllTools().map((tool) => tool.name);
    expect(names).not.toContain("search_tools");
    expect(names).not.toContain("workflow");
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
