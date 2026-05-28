import { describe, expect, test } from "bun:test";
import { createFakePi } from "../../tests/support/fake-pi";
import extension, {
  resolveVertexBaseUrl,
  resolveVertexModelRequest,
  VERTEX_CLAUDE_MODELS,
} from "./index";

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
