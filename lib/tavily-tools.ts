import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";

import { type CliExec, cliResultForTool, runCli } from "./cli";
import { addOptions, cliTimeoutMs } from "./tavily-cli";

const SEARCH_DEPTHS = ["ultra-fast", "fast", "basic", "advanced"] as const;
const TOPICS = ["general", "news", "finance"] as const;
const TIME_RANGES = ["day", "week", "month", "year"] as const;
const EXTRACT_DEPTHS = ["basic", "advanced"] as const;
const CONTENT_FORMATS = ["markdown", "text"] as const;

const MAX_CONTEXT_CHARS = 60_000;
const SEARCH_TIMEOUT_MS = 120_000;
const AUTH_TIMEOUT_MS = 20_000;
const DEFAULT_EXTRACT_TIMEOUT_SECONDS = 60;
const DEFAULT_SITE_TIMEOUT_SECONDS = 150;
type ToolUpdateHandler =
  | ((update: {
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, unknown>;
    }) => void)
  | undefined;

function sendStatus(onUpdate: ToolUpdateHandler, text: string) {
  onUpdate?.({ content: [{ type: "text", text }], details: {} });
}

async function runTvly(
  exec: CliExec,
  commandArgs: string[],
  signal: AbortSignal | undefined,
  timeout: number,
) {
  const result = await runCli(exec, {
    command: "tvly",
    args: commandArgs,
    timeout,
    signal,
    parseJson: true,
    maxOutputChars: MAX_CONTEXT_CHARS,
    successLabel: "Tavily result",
    failureLabel: "Tavily command failed",
    truncationLabel: "tavily extension",
    failureHint:
      "Failed to execute tvly. Ensure the Tavily CLI is installed and authenticated (tvly auth).",
  });

  return cliResultForTool(result);
}

const searchSchema = Type.Object({
  query: Type.String({
    description:
      "Search query. Keep under 400 characters; use search-keyword style, not a long prompt.",
  }),
  depth: Type.Optional(StringEnum(SEARCH_DEPTHS, { description: "Search depth. Default: basic." })),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 20,
      description: "Maximum results. Default: 5.",
    }),
  ),
  topic: Type.Optional(StringEnum(TOPICS, { description: "Search topic. Default: general." })),
  timeRange: Type.Optional(StringEnum(TIME_RANGES, { description: "Restrict recency." })),
  startDate: Type.Optional(Type.String({ description: "Results after date, YYYY-MM-DD." })),
  endDate: Type.Optional(Type.String({ description: "Results before date, YYYY-MM-DD." })),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Domains to include, e.g. ['sec.gov', 'reuters.com'].",
    }),
  ),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Domains to exclude." })),
  country: Type.Optional(Type.String({ description: "Boost results from a country." })),
  includeAnswer: Type.Optional(
    StringEnum(["basic", "advanced"] as const, {
      description: "Include Tavily-generated answer.",
    }),
  ),
  includeRawContent: Type.Optional(
    StringEnum(CONTENT_FORMATS, {
      description: "Include full page content as markdown or text. Use sparingly.",
    }),
  ),
  includeImages: Type.Optional(Type.Boolean({ description: "Include image results." })),
  includeImageDescriptions: Type.Optional(
    Type.Boolean({ description: "Include AI image descriptions." }),
  ),
  chunksPerSource: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Chunks per source; requires fast/advanced depth.",
    }),
  ),
});

const extractSchema = Type.Object({
  urls: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 20,
    description: "URLs to extract. Maximum 20.",
  }),
  query: Type.Optional(
    Type.String({
      description: "Optional focus query to rerank chunks by relevance.",
    }),
  ),
  chunksPerSource: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Chunks per source. Requires query.",
    }),
  ),
  extractDepth: Type.Optional(
    StringEnum(EXTRACT_DEPTHS, {
      description: "Extraction depth. Use advanced for JS-heavy pages.",
    }),
  ),
  format: Type.Optional(
    StringEnum(CONTENT_FORMATS, {
      description: "Output content format. Default: markdown.",
    }),
  ),
  includeImages: Type.Optional(Type.Boolean({ description: "Include image URLs." })),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: DEFAULT_EXTRACT_TIMEOUT_SECONDS,
      description: "Tavily extraction timeout in seconds.",
    }),
  ),
});

const mapSchema = Type.Object({
  url: Type.String({ description: "Site URL to map." }),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  maxBreadth: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum URLs to discover. Default: 50.",
    }),
  ),
  instructions: Type.Optional(
    Type.String({
      description: "Natural-language guidance for URL discovery.",
    }),
  ),
  selectPaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regex path patterns to include.",
    }),
  ),
  excludePaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regex path patterns to exclude.",
    }),
  ),
  allowExternal: Type.Optional(Type.Boolean({ description: "Include external links." })),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 10, maximum: DEFAULT_SITE_TIMEOUT_SECONDS }),
  ),
});

const crawlSchema = Type.Object({
  url: Type.String({ description: "Site URL to crawl." }),
  maxDepth: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Levels deep. Default: 1.",
    }),
  ),
  maxBreadth: Type.Optional(
    Type.Integer({ minimum: 1, description: "Links per page. Default: 20." }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Total pages cap. Default: 50." })),
  instructions: Type.Optional(
    Type.String({
      description: "Semantic focus for crawl. Prefer this for targeted docs/content.",
    }),
  ),
  chunksPerSource: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 5,
      description: "Chunks per page; requires instructions.",
    }),
  ),
  extractDepth: Type.Optional(StringEnum(EXTRACT_DEPTHS)),
  format: Type.Optional(StringEnum(CONTENT_FORMATS)),
  selectPaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regex path patterns to include.",
    }),
  ),
  excludePaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regex path patterns to exclude.",
    }),
  ),
  selectDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regex domain patterns to include.",
    }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regex domain patterns to exclude.",
    }),
  ),
  allowExternal: Type.Optional(
    Type.Boolean({
      description: "Include external links. CLI default is true.",
    }),
  ),
  includeImages: Type.Optional(Type.Boolean({ description: "Include images." })),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 10, maximum: DEFAULT_SITE_TIMEOUT_SECONDS }),
  ),
});

type SearchParams = Static<typeof searchSchema>;
type ExtractParams = Static<typeof extractSchema>;
type MapParams = Static<typeof mapSchema>;
type CrawlParams = Static<typeof crawlSchema>;

type AuthParams = Record<string, never>;

type TavilyToolSpec<TParams extends object> = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  buildArgs: (params: TParams) => string[];
  validate?: (params: TParams) => void;
  progressText?: (params: TParams) => string;
  timeoutMs: (params: TParams) => number;
};

type RegisteredTavilyToolSpec = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  buildArgs: (params: unknown) => string[];
  validate?: (params: unknown) => void;
  progressText?: (params: unknown) => string;
  timeoutMs: (params: unknown) => number;
};

function defineTavilyToolSpec<TParams extends object>(
  spec: TavilyToolSpec<TParams>,
): RegisteredTavilyToolSpec {
  const validate = spec.validate;
  const progressText = spec.progressText;

  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    buildArgs: (params) => spec.buildArgs(params as TParams),
    validate: validate ? (params) => validate(params as TParams) : undefined,
    progressText: progressText ? (params) => progressText(params as TParams) : undefined,
    timeoutMs: (params) => spec.timeoutMs(params as TParams),
  };
}

const searchSpec = defineTavilyToolSpec<SearchParams>({
  name: "tavily_search",
  label: "Tavily Search",
  description: "Search the web with LLM-optimized Tavily results via the tvly CLI.",
  parameters: searchSchema,
  validate(params) {
    if (params.query.trim().length > 400) {
      throw new Error(
        "tavily_search query must be 400 characters or fewer. Split complex questions into focused sub-queries.",
      );
    }
  },
  buildArgs(params) {
    const args = ["search", params.query.trim(), "--json"];
    addOptions(args, [
      ["--depth", params.depth],
      ["--max-results", params.maxResults],
      ["--topic", params.topic],
      ["--time-range", params.timeRange],
      ["--start-date", params.startDate],
      ["--end-date", params.endDate],
      ["--include-domains", params.includeDomains],
      ["--exclude-domains", params.excludeDomains],
      ["--country", params.country],
      ["--include-answer", params.includeAnswer],
      ["--include-raw-content", params.includeRawContent],
      ["--include-images", params.includeImages],
      ["--include-image-descriptions", params.includeImageDescriptions],
      ["--chunks-per-source", params.chunksPerSource],
    ]);
    return args;
  },
  progressText(params) {
    return `Running tvly search ${params.query.trim()} ...`;
  },
  timeoutMs() {
    return SEARCH_TIMEOUT_MS;
  },
});

const extractSpec = defineTavilyToolSpec<ExtractParams>({
  name: "tavily_extract",
  label: "Tavily Extract",
  description: "Extract clean markdown/text content from one or more known URLs via the tvly CLI.",
  parameters: extractSchema,
  validate(params) {
    if (params.chunksPerSource !== undefined && !params.query) {
      throw new Error("tavily_extract chunksPerSource requires a query.");
    }
  },
  buildArgs(params) {
    const args = ["extract", ...params.urls, "--json"];
    addOptions(args, [
      ["--query", params.query],
      ["--chunks-per-source", params.chunksPerSource],
      ["--extract-depth", params.extractDepth],
      ["--format", params.format],
      ["--include-images", params.includeImages],
      ["--timeout", params.timeoutSeconds],
    ]);
    return args;
  },
  progressText(params) {
    return `Extracting ${params.urls.length} URL(s) with Tavily...`;
  },
  timeoutMs(params) {
    return cliTimeoutMs(params.timeoutSeconds, DEFAULT_EXTRACT_TIMEOUT_SECONDS);
  },
});

const mapSpec = defineTavilyToolSpec<MapParams>({
  name: "tavily_map",
  label: "Tavily Map",
  description: "Discover URLs on a website without extracting page content via the tvly CLI.",
  parameters: mapSchema,
  buildArgs(params) {
    const args = ["map", params.url, "--json"];
    addOptions(args, [
      ["--max-depth", params.maxDepth],
      ["--max-breadth", params.maxBreadth],
      ["--limit", params.limit],
      ["--instructions", params.instructions],
      ["--select-paths", params.selectPaths],
      ["--exclude-paths", params.excludePaths],
      ["--allow-external", params.allowExternal],
      ["--timeout", params.timeoutSeconds],
    ]);
    return args;
  },
  progressText(params) {
    return `Mapping ${params.url} with Tavily...`;
  },
  timeoutMs(params) {
    return cliTimeoutMs(params.timeoutSeconds, DEFAULT_SITE_TIMEOUT_SECONDS);
  },
});

const crawlSpec = defineTavilyToolSpec<CrawlParams>({
  name: "tavily_crawl",
  label: "Tavily Crawl",
  description: "Crawl a website and extract content from multiple pages via the tvly CLI.",
  parameters: crawlSchema,
  validate(params) {
    if (params.chunksPerSource !== undefined && !params.instructions) {
      throw new Error("tavily_crawl chunksPerSource requires instructions.");
    }
  },
  buildArgs(params) {
    const args = ["crawl", params.url, "--json"];
    addOptions(args, [
      ["--max-depth", params.maxDepth],
      ["--max-breadth", params.maxBreadth],
      ["--limit", params.limit],
      ["--instructions", params.instructions],
      ["--chunks-per-source", params.chunksPerSource],
      ["--extract-depth", params.extractDepth],
      ["--format", params.format],
      ["--select-paths", params.selectPaths],
      ["--exclude-paths", params.excludePaths],
      ["--select-domains", params.selectDomains],
      ["--exclude-domains", params.excludeDomains],
      ["--allow-external", params.allowExternal],
      ["--include-images", params.includeImages],
      ["--timeout", params.timeoutSeconds],
    ]);
    return args;
  },
  progressText(params) {
    return `Crawling ${params.url} with Tavily...`;
  },
  timeoutMs(params) {
    return cliTimeoutMs(params.timeoutSeconds, DEFAULT_SITE_TIMEOUT_SECONDS);
  },
});

const authSpec = defineTavilyToolSpec<AuthParams>({
  name: "tavily_auth_status",
  label: "Tavily Auth Status",
  description: "Check whether the tvly CLI is installed and authenticated.",
  parameters: Type.Object({}),
  buildArgs() {
    return ["auth", "--json"];
  },
  timeoutMs() {
    return AUTH_TIMEOUT_MS;
  },
});

const TAVILY_TOOL_SPECS = [searchSpec, extractSpec, mapSpec, crawlSpec, authSpec] as const;

export const TAVILY_TOOL_NAMES = TAVILY_TOOL_SPECS.map((spec) => spec.name);

export function createTavilyToolDefinitions(exec: CliExec): ToolDefinition[] {
  return TAVILY_TOOL_SPECS.map(
    (spec): ToolDefinition => ({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(_toolCallId, params, signal, onUpdate) {
        spec.validate?.(params);
        const args = spec.buildArgs(params);
        const progress = spec.progressText?.(params);
        if (progress) sendStatus(onUpdate, progress);
        return runTvly(exec, args, signal, spec.timeoutMs(params));
      },
    }),
  );
}
