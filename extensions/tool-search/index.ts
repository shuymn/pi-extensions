import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isOneShotPrimaryModeSelected } from "../../lib/one-shot-flow";
import { TAVILY_TOOL_NAMES } from "../../lib/tavily-tools";

const TOOL_NAME = "search_tools";

const DEFERRED_TOOL_GROUPS = [
  {
    id: "web",
    names: TAVILY_TOOL_NAMES,
    keywords:
      "web internet current recent news research source sources url urls search extract map crawl website websites tavily authentication",
  },
  {
    id: "workflow",
    names: ["workflow"],
    keywords:
      "workflow workflows orchestration fan-out parallel multi-agent review reviews research review_flow research_flow deterministic",
  },
  {
    id: "subagent-management",
    names: ["get_subagent_result", "stop_subagent", "list_subagents"],
    keywords:
      "subagent subagents background delegated agent agents status result results wait stop cancel terminate list manage management",
  },
] as const;

const DEFERRED_TOOL_NAMES: ReadonlySet<string> = new Set<string>(
  DEFERRED_TOOL_GROUPS.flatMap((group) => [...group.names]),
);

const paramsSchema = Type.Object({
  query: Type.String({
    description:
      "Capability or task to search for, such as web research, workflow code review, or background subagent status.",
  }),
});

function queryTerms(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function matchingDeferredTools(query: string, tools: ToolInfo[]): string[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const matches = new Set<string>();

  for (const group of DEFERRED_TOOL_GROUPS) {
    const keywords = new Set(`${group.id} ${group.keywords}`.split(/\s+/));
    if (terms.some((term) => keywords.has(term))) {
      for (const name of group.names) {
        if (available.has(name)) matches.add(name);
      }
    }
  }

  return [...matches];
}

export default function toolSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "Search Tools",
    description:
      "Search deferred tool groups and activate capabilities relevant to a task. Use for Tavily web tools, the workflow tool (including review_flow and research_flow), and background subagent management tools.",
    promptSnippet:
      "Search and load deferred tools when the active tool set does not contain the capability needed for the user's task.",
    promptGuidelines: [
      "Use search_tools before attempting a task that needs deferred Tavily web tools, workflow orchestration, review_flow/research_flow, or background subagent result/stop/list management.",
      "Describe the needed capability in query; search_tools activates matching registered tools additively for the rest of the session.",
    ],
    parameters: paramsSchema,
    async execute(_toolCallId, params) {
      const matches = matchingDeferredTools(params.query, pi.getAllTools());
      if (matches.length === 0) {
        return {
          content: [
            { type: "text" as const, text: `No deferred tools found for: ${params.query}` },
          ],
          details: { matches: [], added: [] },
        };
      }

      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const added = matches.filter((name) => !activeSet.has(name));
      if (added.length > 0) pi.setActiveTools([...new Set([...active, ...added])]);

      return {
        content: [
          {
            type: "text" as const,
            text:
              added.length > 0
                ? `Loaded tools: ${added.join(", ")}`
                : `Matching tools already active: ${matches.join(", ")}`,
          },
        ],
        details: { matches, added },
      };
    },
  });

  pi.on("session_start", () => {
    // Bounded commit/create-pr one-shot flows intentionally replace the active
    // tool set with a strict allowlist. Do not re-add this loader there.
    if (isOneShotPrimaryModeSelected()) return;

    const initialTools = pi.getActiveTools().filter((name) => !DEFERRED_TOOL_NAMES.has(name));
    pi.setActiveTools([...new Set([...initialTools, TOOL_NAME])]);
  });
}
