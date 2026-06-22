import { describe, expect, test } from "bun:test";
import { loadWorkflowToolModule } from "./workflow-tool.test-support";

describe("dynamic workflow tool contract", () => {
  test("defines workflow tool schema and English prompt guidance", async () => {
    const { createWorkflowTool } = await loadWorkflowToolModule();
    const tool = createWorkflowTool({ agent: () => "unused" });

    expect(tool).toMatchObject({
      name: "workflow",
      label: "Workflow",
      parameters: {
        type: "object",
        properties: {
          scriptPath: { type: "string", optional: true },
          script: { type: "string", optional: true },
          name: { type: "string", optional: true },
          args: { optional: true },
        },
      },
    });
    const guidelines = tool.promptGuidelines!.join("\n");
    expect(tool.description).toContain("deterministic JavaScript workflow");
    expect(tool.promptSnippet).toContain("Use workflow");
    expect(guidelines).toContain("explicitly asks");
    expect(guidelines).toContain("not authorization by itself");
    expect(guidelines).toContain("parallel() takes functions");
    expect(guidelines).toContain("do not use TypeScript");
    expect(guidelines).toContain("agent(prompt, { schema, label }) returns the parsed object");
    expect(guidelines).toContain("model and thinkingLevel are request hints/metadata");
    expect((tool.parameters as any).properties).toMatchObject({
      resumeFromRunId: { type: "string", optional: true },
    });
  });

  test("normalizes raw arguments and strips a single surrounding Markdown fence", async () => {
    const { normalizeWorkflowToolInput } = await loadWorkflowToolModule();

    expect(
      normalizeWorkflowToolInput({
        script:
          "```js\nexport const meta = { name: 'x', phases: [{ title: 'Run' }] };\nreturn 1;\n```",
        args: { target: "src" },
      }),
    ).toEqual({
      script: "export const meta = { name: 'x', phases: [{ title: 'Run' }] };\nreturn 1;",
      args: { target: "src" },
    });

    expect(normalizeWorkflowToolInput({ resumeFromRunId: "wf_previous_12345678" })).toEqual({
      resumeFromRunId: "wf_previous_12345678",
    });

    expect(normalizeWorkflowToolInput({ scriptPath: "workflow.js", name: "ignored" })).toEqual({
      scriptPath: "workflow.js",
      name: "ignored",
    });

    expect(() => normalizeWorkflowToolInput({ script: 1 })).toThrow("script");
  });
});
