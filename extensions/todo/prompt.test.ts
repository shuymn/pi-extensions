import { describe, expect, test } from "bun:test";
import { renderTodoReminder } from "./prompt";
import type { TodoState } from "./state";

const state: TodoState = {
  nextId: 5,
  items: [
    { id: 1, title: "Done", status: "completed", createdAt: 1, updatedAt: 1 },
    {
      id: 2,
      title: "Active",
      status: "in_progress",
      createdAt: 1,
      updatedAt: 1,
    },
    { id: 3, title: "Next", status: "pending", createdAt: 1, updatedAt: 1 },
    { id: 4, title: "Later", status: "pending", createdAt: 1, updatedAt: 1 },
  ],
};

describe("todo prompt", () => {
  test("returns undefined for empty state without a goal", () => {
    expect(renderTodoReminder({ items: [], nextId: 1 })).toBeUndefined();
  });

  test("returns undefined for terminal-only todos without an active goal", () => {
    expect(
      renderTodoReminder({
        nextId: 2,
        items: [{ id: 1, title: "Done", status: "completed", createdAt: 1, updatedAt: 1 }],
      }),
    ).toBeUndefined();
  });

  test("prioritizes in_progress and pending and includes protocol", () => {
    const reminder = renderTodoReminder(state)!;
    expect(reminder).toContain("● #2 Active");
    expect(reminder).toContain("○ #3 Next");
    expect(reminder.indexOf("#2 Active")).toBeLessThan(reminder.indexOf("#1 Done"));
    expect(reminder).toContain(
      "- Before final response, close or explicitly explain remaining todos.",
    );
  });

  test("renders active goal without todos", () => {
    const reminder = renderTodoReminder({
      nextId: 1,
      goal: {
        objective: "Ship goal support",
        doneWhen: ["Goal reminder is visible", "Tests pass"],
        verification: ["bun test extensions/todo/prompt.test.ts"],
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
      items: [],
    })!;

    expect(reminder).toContain("Goal: Ship goal support");
    expect(reminder).toContain("- Done when: Goal reminder is visible");
    expect(reminder).toContain("- Verification: bun test extensions/todo/prompt.test.ts");
    expect(reminder).toContain("- After closing todos, evaluate the active goal against doneWhen.");
    expect(reminder).toContain("satisfy_goal, abandon_goal, clear_goal");
    expect(reminder).not.toContain("Current todos:");
  });

  test("renders active goal with todos before the protocol", () => {
    const reminder = renderTodoReminder({
      ...state,
      goal: {
        objective: "Finish feature",
        doneWhen: ["Todos complete"],
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
    })!;

    expect(reminder).toContain("Goal: Finish feature");
    expect(reminder).toContain("Current todos:");
    expect(reminder.indexOf("Goal: Finish feature")).toBeLessThan(
      reminder.indexOf("Current todos:"),
    );
    expect(reminder.indexOf("Current todos:")).toBeLessThan(reminder.indexOf("● #2 Active"));
    expect(reminder.indexOf("● #2 Active")).toBeLessThan(reminder.indexOf("Protocol:"));
  });

  test("collapses overflow", () => {
    const reminder = renderTodoReminder(state, { maxLines: 9 })!;
    expect(reminder).toContain("... ");
    expect(reminder.split("\n").length).toBeLessThanOrEqual(9);
  });

  test("collapses active goal overflow", () => {
    const reminder = renderTodoReminder(
      {
        ...state,
        goal: {
          objective: "Finish feature",
          doneWhen: ["A", "B", "C", "D"],
          verification: ["E", "F"],
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { maxLines: 9 },
    )!;

    expect(reminder).toContain("Goal: Finish feature");
    expect(reminder).toContain("... ");
    expect(reminder.split("\n").length).toBeLessThanOrEqual(9);
  });
});
