import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { TodoItem, TodoState } from "./state";
import { renderWidgetLines, renderWidgetText, statusIcon } from "./view";

function terminalState(statuses: Array<TodoItem["status"]>): TodoState {
  return {
    nextId: statuses.length + 1,
    items: statuses.map((status, index) => ({
      id: index + 1,
      title: status,
      status,
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

const state: TodoState = {
  nextId: 5,
  items: [
    {
      id: 1,
      title: "Pending item with a very long title",
      status: "pending",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 2,
      title: "Active item",
      activeForm: "Doing now",
      status: "in_progress",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 3,
      title: "Done item",
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 4,
      title: "Cancelled item",
      status: "cancelled",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

describe("todo widget", () => {
  test("returns undefined for empty state", () => {
    expect(renderWidgetText({ items: [], nextId: 1 })).toBeUndefined();
  });

  test("returns undefined when only terminal todos remain without an active goal", () => {
    const terminalCases = [
      terminalState(["completed"]),
      terminalState(["cancelled"]),
      terminalState(["completed", "cancelled"]),
    ];

    for (const state of terminalCases) {
      expect(renderWidgetText(state)).toBeUndefined();
      expect(renderWidgetLines(state)).toBeUndefined();
    }
  });

  test("renders active goal even without active todos", () => {
    const goalOnly: TodoState = {
      nextId: 1,
      goal: {
        objective: "Ship goal support",
        doneWhen: ["Widget shows goal"],
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
      items: [],
    };
    expect(renderWidgetText(goalOnly)).toEqual(["● Goal: Ship goal support"]);

    const terminalWithGoal: TodoState = {
      ...terminalState(["completed"]),
      goal: {
        objective: "Evaluate completion",
        doneWhen: ["Todos complete"],
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const lines = renderWidgetLines(terminalWithGoal)!;
    expect(lines[0]).toMatchObject({ text: "● Goal: Evaluate completion", color: "accent" });
    expect(lines.some((line) => line.text.includes("✓ completed") && line.dim)).toBe(true);
  });

  test("has icons and color policy for every status", () => {
    expect(statusIcon("pending")).toBe("○");
    expect(statusIcon("in_progress")).toBe("◐");
    expect(statusIcon("completed")).toBe("✓");
    expect(statusIcon("cancelled")).toBe("×");
    const lines = renderWidgetLines(state)!;
    expect(lines.some((line) => line.text.includes("◐ Doing now") && line.color === "accent")).toBe(
      true,
    );
    expect(lines.some((line) => line.text.includes("✓ Done item") && line.dim)).toBe(true);
  });

  test("truncates to width and shows accurate overflow", () => {
    const lines = renderWidgetText(state, { width: 16, maxLines: 3 })!;
    expect(lines.every((line) => line.length <= 16)).toBe(true);
    expect(lines.at(-1)).toContain("+3 more");
  });

  test("truncates active goal header to width", () => {
    const lines = renderWidgetText(
      {
        nextId: 1,
        goal: {
          objective: "Very long goal objective that should be truncated",
          doneWhen: ["Done"],
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        },
        items: [],
      },
      { width: 20 },
    )!;

    expect(lines).toHaveLength(1);
    expect(stripVTControlCharacters(lines[0]!).length).toBeLessThanOrEqual(20);
  });

  test("honors zero max lines", () => {
    expect(renderWidgetText(state, { maxLines: 0 })).toEqual([]);
  });
});
