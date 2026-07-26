import { describe, expect, test } from "bun:test";
import { createFakePi } from "../../tests/support/fake-pi";
import toolSearchExtension from "./index";

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: { query: string },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: { matches: string[]; added: string[] };
  }>;
};

function createToolSearchPi(activeTools: string[], flags: Record<string, unknown> = {}) {
  const pi = createFakePi<ToolDefinition>({ flags });
  const active = [...activeTools];
  const activeToolsCalls: string[][] = [];

  return Object.assign(pi, {
    getAllTools() {
      return [...pi.tools.values()];
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      active.splice(0, active.length, ...names);
      activeToolsCalls.push([...names]);
    },
    activeToolsCalls,
  });
}

function registerDeferredStubs(pi: ReturnType<typeof createToolSearchPi>) {
  for (const [name, description] of [
    ["tavily_search", "Search the current web"],
    ["tavily_extract", "Extract a URL"],
    ["tavily_map", "Map a website"],
    ["tavily_crawl", "Crawl a website"],
    ["tavily_auth_status", "Check Tavily auth"],
    ["workflow", "Run deterministic orchestration"],
    ["get_subagent_result", "Get a background subagent result"],
    ["stop_subagent", "Stop a background subagent"],
    ["list_subagents", "List background subagents"],
  ]) {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters: {},
      async execute() {
        throw new Error("stub");
      },
    } as never);
  }
}

async function startSession(pi: ReturnType<typeof createToolSearchPi>) {
  await pi.getEventHandlers("session_start")[0]!({}, {});
}

async function withArgv(argv: string[], callback: () => Promise<void>): Promise<void> {
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? "bun", originalArgv[1] ?? "pi", ...argv];
  try {
    await callback();
  } finally {
    process.argv = originalArgv;
  }
}

describe("tool-search extension", () => {
  test("keeps core tools active and defers large registered tool groups at session start", async () => {
    const pi = createToolSearchPi([
      "read",
      "ask_user_question",
      "compact_context",
      "todo",
      "spawn_subagent",
      "github_clone_workspace",
      "workflow",
      "tavily_search",
      "get_subagent_result",
    ]);
    registerDeferredStubs(pi);
    toolSearchExtension(pi as never);

    await startSession(pi);

    expect(pi.getActiveTools()).toEqual([
      "read",
      "ask_user_question",
      "compact_context",
      "todo",
      "spawn_subagent",
      "github_clone_workspace",
      "search_tools",
    ]);
  });

  test("does not weaken bounded one-shot tool allowlists without reading sibling flags", async () => {
    const pi = createToolSearchPi(["read", "bash", "ask_user_question"]);
    registerDeferredStubs(pi);
    toolSearchExtension(pi as never);

    await withArgv(["--commit"], async () => startSession(pi));

    expect(pi.getActiveTools()).toEqual(["read", "bash", "ask_user_question"]);
    expect(pi.activeToolsCalls).toEqual([]);
  });

  test("loads matching groups additively and leaves already active tools untouched", async () => {
    const pi = createToolSearchPi(["read", "spawn_subagent"]);
    registerDeferredStubs(pi);
    toolSearchExtension(pi as never);
    await startSession(pi);
    const tool = pi.tools.get("search_tools")!;

    const review = await tool.execute("call", { query: "I need a code review workflow" });
    expect(review.details.added).toEqual(["workflow"]);
    expect(pi.getActiveTools()).toEqual(["read", "spawn_subagent", "search_tools", "workflow"]);

    const background = await tool.execute("call", { query: "background subagent status" });
    expect(background.details.added).toEqual([
      "get_subagent_result",
      "stop_subagent",
      "list_subagents",
    ]);
    expect(pi.getActiveTools()).toContain("workflow");

    const again = await tool.execute("call", { query: "review_flow" });
    expect(again.details.added).toEqual([]);
    expect(again.content[0]?.text).toContain("already active");
  });

  test("loads the Tavily group for web research and reports unmatched capabilities", async () => {
    const pi = createToolSearchPi(["read"]);
    registerDeferredStubs(pi);
    toolSearchExtension(pi as never);
    await startSession(pi);
    const tool = pi.tools.get("search_tools")!;

    const web = await tool.execute("call", { query: "I need current web sources" });
    expect(web.details.added).toEqual([
      "tavily_search",
      "tavily_extract",
      "tavily_map",
      "tavily_crawl",
      "tavily_auth_status",
    ]);

    const missing = await tool.execute("call", { query: "database migration" });
    expect(missing.details).toEqual({ matches: [], added: [] });
  });
});
