import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { CliExec } from "../lib/cli";
import { createTavilyToolDefinitions, TAVILY_TOOL_NAMES } from "../lib/tavily-tools";

test("native codemode reads full deferred Tavily objects and rejects CLI failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tavily-codemode-"));
  const sentinel = "sentinel-beyond-text-cutoff";
  const payload = {
    results: [
      { url: "https://example.com/shared", raw_content: "x".repeat(65_000) },
      { url: "https://example.com/tail", raw_content: sentinel },
    ],
    request_id: "complete-object",
  };
  const stdout = JSON.stringify(payload);
  expect(stdout.indexOf(sentinel)).toBeGreaterThan(60_000);
  const calls: string[] = [];
  const exec: CliExec = async (command, args) => {
    expect(command).toBe("tvly");
    expect(args[0]).toBe("search");
    expect(args).toContain("--json");
    const query = args[1]!;
    calls.push(query);
    if (query === "invalid") return { code: 0, stdout: "not json", stderr: "" };
    if (query === "array") return { code: 0, stdout: "[]", stderr: "" };
    if (query === "null") return { code: 0, stdout: "null", stderr: "" };
    if (query === "cli-error") return { code: 7, stdout: "", stderr: "fixture CLI failure" };
    if (query === "spawn-error") throw new Error("fixture spawn failure");
    return { code: 0, stdout, stderr: "" };
  };
  const code = `
    const results = await Promise.all(["first", "second"].map(query => tools.tavily_search({ query })));
    text({
      urls: [...new Set(results.flatMap(result => result.results.map(hit => hit.url)))],
      tails: results.map(result => result.results[1].raw_content),
      lengths: results.map(result => result.results[0].raw_content.length),
      ids: results.map(result => result.request_id)
    });
    const failures = await Promise.allSettled(
      ["invalid", "array", "null", "cli-error", "spawn-error"].map(query => tools.tavily_search({ query }))
    );
    text(failures.map(result => ({ status: result.status, error: String(result.reason) })));
  `;
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["+codemode"],
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
      createCodemodeExtension(),
      (pi) => {
        for (const tool of createTavilyToolDefinitions(exec)) {
          pi.registerTool({ ...tool, exposure: "deferred" });
        }
      },
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
    let turn = 0;
    const streamResponse: Provider["streamSimple"] = (model) => {
      const stream = createAssistantMessageEventStream();
      const response = {
        ...fauxAssistantMessage("Done"),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      const current = turn++;
      if (current === 0 || current === 2) {
        response.content = [
          {
            type: "toolCall",
            id: `call-${current}`,
            name: current === 0 ? "codemode" : "tavily_search",
            arguments: current === 0 ? { code } : { query: "direct" },
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
    const errors: string[] = [];
    await session.bindExtensions({ onError: (event) => errors.push(event.error) });
    expect(session.getActiveToolNames()).toContain("codemode");
    for (const name of TAVILY_TOOL_NAMES) {
      expect(session.getActiveToolNames()).not.toContain(name);
      expect(session.getCallableToolNames()).toContain(name);
    }
    await session.prompt("Run the codemode fixture.");
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolName === "codemode",
    );
    expect(result?.role).toBe("toolResult");
    if (result?.role !== "toolResult") throw new Error("Missing codemode result");
    expect(result.isError).toBe(false);
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain("Script completed");
    expect(text).toContain(
      JSON.stringify({
        urls: ["https://example.com/shared", "https://example.com/tail"],
        tails: [sentinel, sentinel],
        lengths: [65_000, 65_000],
        ids: ["complete-object", "complete-object"],
      }),
    );
    expect(text.match(/"status":"rejected"/g)).toHaveLength(5);
    expect(text).toContain("fixture CLI failure");
    expect(text).toContain("fixture spawn failure");
    expect(calls.sort()).toEqual([
      "array",
      "cli-error",
      "first",
      "invalid",
      "null",
      "second",
      "spawn-error",
    ]);
    expect(session.getActiveToolNames()).not.toContain("tavily_search");

    session.setActiveToolsByName([...session.getActiveToolNames(), "tavily_search"]);
    await session.prompt("Run the direct tool fixture.");
    const direct = session.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "call-2",
    );
    if (direct?.role !== "toolResult") throw new Error("Missing direct Tavily result");
    expect(direct.isError).toBe(false);
    const directText = direct.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(directText).toContain("[truncated by tavily extension:");
    expect(directText).not.toContain(sentinel);
    expect(errors).toEqual([]);
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
