import { expect, mock, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DelegatedSessionOptions, runDelegatedSession } from "./delegated-session";

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
      options({ allowedTools: [name], customTools: [definition], readOnly: true }),
    );
    expect(result.error).toContain(`read-only policy denies tool: ${name}`);
    expect(definition.execute).not.toHaveBeenCalled();
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
