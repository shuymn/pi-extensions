import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createWorkflowResultComponent, renderWorkflowStatusText } from "./render-tool";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => `**${text}**`,
};

describe("workflow tool rendering", () => {
  test("renders compact status lines and truncates to terminal width", () => {
    const details = {
      status: "completed" as const,
      workflowName: "very_long_workflow_name_for_rendering",
      phases: ["Discover", "Verify"],
      logs: ["a very long log line that should not overflow narrow terminals"],
      agents: [
        {
          label: "a very long agent label that should truncate",
          phase: "Discover",
          prompt: "prompt",
          status: "done" as const,
        },
      ],
      agentCount: 1,
      durationMs: 12,
    };

    expect(renderWorkflowStatusText(details)).toContain("Workflow very_long_workflow_name");

    const component = createWorkflowResultComponent({ content: [], details }, theme);
    const lines = component.render(24);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  test("falls back to text content when details are unavailable", () => {
    const component = createWorkflowResultComponent(
      { content: [{ type: "text", text: "plain result" }] },
      theme,
    );

    expect(component.render(80)).toEqual(["plain result"]);
  });
});
