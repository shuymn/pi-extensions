import { expect, mock, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type ExtensionToolContext,
  type ToolDefinition,
  type ToolInfo,
  wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type DelegatedSessionOptions,
  inheritDelegatedTool,
  runDelegatedSession,
} from "./delegated-session";

function options(overrides: Partial<DelegatedSessionOptions> = {}): DelegatedSessionOptions {
  return {
    cwd: process.cwd(),
    modelRegistry: {} as DelegatedSessionOptions["modelRegistry"],
    model: { provider: "offline", id: "not-dispatched" } as DelegatedSessionOptions["model"],
    thinkingLevel: "off",
    systemPrompt: "Test",
    prompt: "Test",
    allowedTools: [],
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
    ...overrides,
  };
}
function tool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: mock(async () => ({ content: [], details: {} })),
  };
}

test("WHEN a caller tool is inherited, nested access and cancellation SHALL use the child context", async () => {
  const parentContext = { tools: [{ name: "parent_only" }] } as unknown as ExtensionToolContext;
  const childContext = { tools: [{ name: "child_only" }] } as unknown as ExtensionToolContext;
  const definition = tool("probe");
  definition.execute = async (_id, _params, signal, _update, ctx) => {
    expect(ctx).toBe(childContext);
    expect(ctx.tools.map((tool) => tool.name)).toEqual(["child_only"]);
    expect(signal?.aborted).toBe(true);
    return { content: [], details: {} };
  };
  const wrapped = wrapRegisteredTool(
    { definition } as Parameters<typeof wrapRegisteredTool>[0],
    { createToolContext: () => parentContext } as unknown as Parameters<
      typeof wrapRegisteredTool
    >[1],
  );
  const inherited = inheritDelegatedTool(
    wrapped as AgentTool,
    {
      annotations: { readOnlyHint: true },
      exposure: "deferred",
      sourceInfo: { path: "fixture" },
    } as ToolInfo,
  );
  const controller = new AbortController();
  controller.abort();
  await inherited.execute("probe", {}, controller.signal, undefined, childContext);
  expect(inherited.annotations?.readOnlyHint).toBe(true);
  expect(inherited.exposure).toBe("deferred");
});

// WHEN a requested tool violates the child policy, the runner SHALL fail before discovery,
// authentication, model execution, or any custom tool invocation.
test.each([
  { allowedTools: ["not-installed"], error: "unavailable tool: not-installed" },
  { allowedTools: ["write"], readOnly: true, error: "read-only policy denies tool: write" },
  { allowedTools: ["edit"], readOnly: true, error: "read-only policy denies tool: edit" },
  { allowedTools: ["bash"], readOnly: true, error: "requires a protected executor" },
  { allowedTools: ["structured_output"], error: "reserved" },
])("policy validation returns a structured failure (%j)", async ({ error, ...overrides }) => {
  const created = mock();
  const result = await runDelegatedSession(options({ ...overrides, onSessionCreated: created }));
  expect(result.status).toBe("failed");
  expect(result.error).toContain(error);
  expect(result.usage.totalTokens).toBe(0);
  expect(result.evidence).toEqual({ messages: [], branch: [] });
  expect(created).not.toHaveBeenCalled();
});

test("readOnly rejects untrusted custom tools and overrides even under a built-in read name", async () => {
  for (const name of ["read", "custom_network_write"]) {
    const definition = tool(name);
    const result = await runDelegatedSession(
      options({
        allowedTools: [name],
        customTools: [
          inheritDelegatedTool(
            { ...definition, execute: mock(async () => ({ content: [], details: {} })) },
            { sourceInfo: { path: "custom" } } as ToolInfo,
          ),
        ],
        readOnly: true,
      }),
    );
    expect(result.error).toContain(`read-only policy denies tool: ${name}`);
    expect(result.evidence.messages).toEqual([]);
  }
});

test("ambiguous tool definitions and forged terminal tools fail closed", async () => {
  const duplicated = await runDelegatedSession(
    options({ customTools: [tool("read"), tool("read")] }),
  );
  expect(duplicated.error).toContain("Duplicate delegated tool");
  const forged = await runDelegatedSession(
    options({ customTools: [tool("structured_output")], schema: Type.Object({}) }),
  );
  expect(forged.error).toContain("reserved");
});

test("already-aborted work returns cancellation before creating any resources", async () => {
  const controller = new AbortController();
  controller.abort();
  const created = mock();
  const disposed = mock();
  const result = await runDelegatedSession(
    options({ signal: controller.signal, onSessionCreated: created, onSessionDisposed: disposed }),
  );
  expect(result.status).toBe("cancelled");
  expect(result.error).toContain("before it started");
  expect(created).not.toHaveBeenCalled();
  expect(disposed).not.toHaveBeenCalled();
});
