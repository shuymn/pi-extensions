import { describe, expect, test } from "bun:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { withTimeout } from "../../tests/support/async";
import { isolateEnvVars } from "../../tests/support/env";
import { createFakePi } from "../../tests/support/fake-pi";
import extension, {
  mapStopReason,
  resolveVertexBaseUrl,
  resolveVertexModelRequest,
  resolveWebSearchConfig,
  streamVertexClaude,
  VERTEX_CLAUDE_MODELS,
} from "./index";

function fakeModel(): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "vertex-claude-api",
    provider: "google-vertex-claude",
    baseUrl: "https://aiplatform.googleapis.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  } as Model<Api>;
}

async function collectStreamTypes(
  stream: ReturnType<typeof streamVertexClaude>,
): Promise<string[]> {
  const types: string[] = [];
  for await (const event of stream) {
    types.push(event.type);
  }
  return types;
}

describe("vertex-claude extension", () => {
  test("registers a Vertex Claude provider with latest-generation models", () => {
    const pi = createFakePi();

    extension(pi as never);

    const provider = pi.providers.get("google-vertex-claude");
    expect(provider).toBeDefined();
    expect(provider?.apiKey).toBe("GOOGLE_CLOUD_PROJECT");
    expect(provider?.api).toBe("vertex-claude-api");
    expect(provider?.models).toEqual(VERTEX_CLAUDE_MODELS);
  });

  test("uses the global Vertex AI host without requiring ANTHROPIC_VERTEX_BASE_URL", () => {
    expect(resolveVertexBaseUrl("global")).toBe("https://aiplatform.googleapis.com/v1");
  });

  test("uses regional Vertex AI hosts for non-global locations", () => {
    expect(resolveVertexBaseUrl("us-east5")).toBe("https://us-east5-aiplatform.googleapis.com/v1");
    expect(resolveVertexBaseUrl("europe-west1")).toBe(
      "https://europe-west1-aiplatform.googleapis.com/v1",
    );
  });

  test("includes 1M variants for supported latest-generation models", () => {
    const oneMillionModels = VERTEX_CLAUDE_MODELS.filter((model) => model.id.endsWith(":1m"));

    expect(oneMillionModels.map((model) => model.id).sort()).toEqual(["claude-sonnet-4-6:1m"]);
    expect(oneMillionModels.every((model) => model.contextWindow === 1_000_000)).toBe(true);
  });

  test("maps 1M aliases to the base Vertex model id and required beta header", () => {
    expect(resolveVertexModelRequest("claude-sonnet-4-6:1m")).toEqual({
      modelId: "claude-sonnet-4-6",
      betaFeatures: ["context-1m-2025-08-07"],
    });
  });

  test("does not send beta headers by default", () => {
    const pi = createFakePi();

    extension(pi as never);

    const provider = pi.providers.get("google-vertex-claude");
    expect(provider?.headers).toBeUndefined();
    expect(resolveVertexModelRequest("claude-sonnet-4-6")).toEqual({
      modelId: "claude-sonnet-4-6",
      betaFeatures: [],
    });
  });
});

describe("resolveWebSearchConfig", () => {
  isolateEnvVars([
    "VERTEX_CLAUDE_WEB_SEARCH",
    "VERTEX_CLAUDE_WEB_SEARCH_MAX_USES",
    "VERTEX_CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS",
    "VERTEX_CLAUDE_WEB_SEARCH_BLOCKED_DOMAINS",
  ]);

  test("is disabled by default when VERTEX_CLAUDE_WEB_SEARCH is unset", () => {
    const config = resolveWebSearchConfig();

    expect(config.enabled).toBe(false);
    expect(config.maxUses).toBe(5);
    expect(config.allowedDomains).toBeNull();
    expect(config.blockedDomains).toBeNull();
  });

  test("is enabled when VERTEX_CLAUDE_WEB_SEARCH=1", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH = "1";

    expect(resolveWebSearchConfig().enabled).toBe(true);
  });

  test("is enabled when VERTEX_CLAUDE_WEB_SEARCH=true", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH = "true";

    expect(resolveWebSearchConfig().enabled).toBe(true);
  });

  test("is disabled for values other than '1' or 'true'", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH = "yes";

    expect(resolveWebSearchConfig().enabled).toBe(false);
  });

  test("overrides maxUses via VERTEX_CLAUDE_WEB_SEARCH_MAX_USES", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH_MAX_USES = "10";

    expect(resolveWebSearchConfig().maxUses).toBe(10);
  });

  test("falls back to default maxUses of 5 for non-numeric VERTEX_CLAUDE_WEB_SEARCH_MAX_USES", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH_MAX_USES = "abc";

    expect(resolveWebSearchConfig().maxUses).toBe(5);
  });

  test("parses VERTEX_CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS as a trimmed string array", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS =
      "example.com, docs.example.com , other.io";

    const config = resolveWebSearchConfig();

    expect(config.allowedDomains).toEqual(["example.com", "docs.example.com", "other.io"]);
    expect(config.blockedDomains).toBeNull();
  });

  test("parses VERTEX_CLAUDE_WEB_SEARCH_BLOCKED_DOMAINS as a trimmed string array", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH_BLOCKED_DOMAINS = "ads.example.com,tracker.io";

    const config = resolveWebSearchConfig();

    expect(config.blockedDomains).toEqual(["ads.example.com", "tracker.io"]);
    expect(config.allowedDomains).toBeNull();
  });

  test("throws when both ALLOWED_DOMAINS and BLOCKED_DOMAINS are set", () => {
    process.env.VERTEX_CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS = "example.com";
    process.env.VERTEX_CLAUDE_WEB_SEARCH_BLOCKED_DOMAINS = "ads.example.com";

    expect(() => resolveWebSearchConfig()).toThrow(
      "VERTEX_CLAUDE_WEB_SEARCH_ALLOWED_DOMAINS and VERTEX_CLAUDE_WEB_SEARCH_BLOCKED_DOMAINS",
    );
  });
});

describe("mapStopReason", () => {
  test("maps end_turn, pause_turn, and stop_sequence to stop", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("pause_turn")).toBe("stop");
    expect(mapStopReason("stop_sequence")).toBe("stop");
  });

  test("maps max_tokens to length", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
  });

  test("maps tool_use to toolUse", () => {
    expect(mapStopReason("tool_use")).toBe("toolUse");
  });

  test("maps unknown reasons to error", () => {
    expect(mapStopReason("unknown_reason")).toBe("error");
  });
});

describe("streamVertexClaude", () => {
  isolateEnvVars(["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "ANTHROPIC_VERTEX_PROJECT_ID"]);

  test("emits a single error event and closes the stream when no project id is configured", async () => {
    const types = await withTimeout(
      collectStreamTypes(streamVertexClaude(fakeModel(), {} as Context)),
      "stream did not end after a missing-project-id failure",
      50,
    );
    expect(types).toEqual(["error"]);
  });
});
