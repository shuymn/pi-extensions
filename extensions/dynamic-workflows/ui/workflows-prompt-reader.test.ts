import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowPromptReaderViewModel } from "./workflows-projection";
import { createWorkflowsPromptReaderComponent } from "./workflows-prompt-reader";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

function keybindings() {
  return {
    matches(data: string, id: string) {
      return (
        (id === "tui.select.cancel" && data === "escape") ||
        (id === "tui.select.up" && data === "up") ||
        (id === "tui.select.down" && data === "down")
      );
    },
  };
}

function reader(
  overrides: Partial<WorkflowPromptReaderViewModel> = {},
): WorkflowPromptReaderViewModel {
  return {
    title: "risk scan",
    prompt: Array.from({ length: 24 }, (_, index) => `line ${index + 1}: 長いプロンプト本文`).join(
      "\n",
    ),
    source: "transcriptPrompt",
    isFullPrompt: true,
    transcriptPath: "/repo/.pi/workflows/wf_123/transcripts/0002-risk-scan.json",
    ...overrides,
  };
}

function createComponent(input: WorkflowPromptReaderViewModel | undefined | null = reader()) {
  let doneValue: null | undefined;
  let renderRequests = 0;
  const component = createWorkflowsPromptReaderComponent(
    input ?? undefined,
    { requestRender: () => (renderRequests += 1) },
    theme,
    keybindings(),
    (value) => {
      doneValue = value;
    },
  );
  return {
    component,
    get doneValue() {
      return doneValue;
    },
    get renderRequests() {
      return renderRequests;
    },
  };
}

describe("workflows prompt reader component", () => {
  test("renders full prompt metadata and width-safe wrapped content", () => {
    const { component } = createComponent();

    const lines = component.render(48);
    const text = lines.join("\n");

    expect(text).toContain("元プロンプト: risk scan");
    expect(text).toContain("取得元: transcript metadata.prompt · 全量");
    expect(text).toContain("0002-risk-scan.json");
    expect(text).toContain("line 1: 長いプロンプト本文");
    expect(text).not.toContain("line 24: 長いプロンプト本文");
    expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  test("scrolls with selection keys", () => {
    const view = createComponent();

    expect(view.component.render(56).join("\n")).toContain("line 1:");
    view.component.handleInput!("down");
    expect(view.renderRequests).toBe(1);
    expect(view.component.render(56).join("\n")).not.toContain("line 1:");

    for (let index = 0; index < 30; index += 1) view.component.handleInput!("down");
    expect(view.component.render(56).join("\n")).toContain("line 24:");
  });

  test("closes on cancel and renders empty reader safely", () => {
    const view = createComponent(null);

    const lines = view.component.render(24);
    view.component.handleInput!("escape");

    expect(lines.join("\n")).toContain("表示できるプロンプト");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(view.doneValue).toBeNull();
  });
});
