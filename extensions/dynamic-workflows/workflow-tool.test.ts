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
    const acceptedPhaseExamples = [
      'phases: [{ title: "Inspect" }]',
      'phases: [{ title: "Inspect", description: "..." }]',
    ];

    expect(tool.description).toContain("deterministic JavaScript workflow");
    expect(tool.description).toContain("review_flow");
    expect(tool.description).toContain("research_flow");
    expect(tool.description).toContain("files > pr > base > staged > working tree");
    expect(tool.promptSnippet).toBeUndefined();
    expect(tool.promptGuidelines).toBeUndefined();
    const properties = (tool.parameters as any).properties;
    expect(properties).toMatchObject({
      resumeFromRunId: { type: "string", optional: true },
    });
    for (const example of acceptedPhaseExamples) {
      expect(properties.script.description).toContain(example);
    }
    expect(properties.name.description).toContain("extension-packaged workflows/*.js");
    expect(properties.script.description).toContain("with `title`, not strings or `name`");
    expect(properties.script.description).toContain("parallel() takes thunks");
    expect(properties.script.description).toContain('toolPolicy: "readOnly"');
    expect(properties.script.description).toContain("provider/model[:effort]");
    expect(properties.script.description).toContain("thinkingLevel, effort, and isolation");
    expect(properties.script.description).toContain(
      "imports, eval, and code generation are forbidden",
    );
    expect(properties.script.description).not.toContain("description?:");
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
