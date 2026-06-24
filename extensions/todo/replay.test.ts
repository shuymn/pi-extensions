import { describe, expect, test } from "bun:test";
import { replayTodoState } from "./replay";
import type { TodoState } from "./state";

const first: TodoState = {
  nextId: 2,
  items: [{ id: 1, title: "A", status: "pending", createdAt: 1, updatedAt: 1 }],
};
const second: TodoState = {
  nextId: 3,
  items: [
    { id: 1, title: "A", status: "completed", createdAt: 1, updatedAt: 2 },
    { id: 2, title: "B", status: "pending", createdAt: 2, updatedAt: 2 },
  ],
};
const withGoal: TodoState = {
  nextId: 2,
  goal: {
    objective: "Ship goal support",
    doneWhen: ["Goal replays"],
    verification: ["Replay test"],
    status: "active",
    createdAt: 1,
    updatedAt: 2,
  },
  items: [{ id: 1, title: "A", status: "completed", createdAt: 1, updatedAt: 2 }],
};

function toolResult(state: unknown, toolName = "todo") {
  return {
    type: "message",
    message: { role: "toolResult", toolName, details: { state } },
  };
}

describe("todo replay", () => {
  test("restores the last valid snapshot from the active branch", () => {
    const restored = replayTodoState({
      getBranch: () => [toolResult(first), toolResult({ bad: true }), toolResult(second)],
    });
    expect(restored).toEqual(second);
    expect(restored).not.toBe(second);
  });

  test("ignores unrelated tool results and falls back to empty state", () => {
    const restored = replayTodoState({
      getBranch: () => [toolResult(first, "bash"), { type: "message", message: { role: "user" } }],
    });
    expect(restored).toEqual({ items: [], nextId: 1 });
  });

  test("uses branch-local entries instead of all entries when both are available", () => {
    const restored = replayTodoState({
      getEntries: () => [toolResult(first)],
      getBranch: () => [toolResult(second)],
    });
    expect(restored).toEqual(second);
  });

  test("restores valid goal snapshots and clones goal arrays", () => {
    const restored = replayTodoState({
      getBranch: () => [toolResult(first), toolResult(withGoal)],
    });
    expect(restored).toEqual(withGoal);
    expect(restored).not.toBe(withGoal);
    restored.goal!.doneWhen.push("mutated");
    restored.goal!.verification!.push("mutated");
    expect(withGoal.goal!.doneWhen).toEqual(["Goal replays"]);
    expect(withGoal.goal!.verification).toEqual(["Replay test"]);
  });

  test("ignores snapshots with duplicate ids, stale nextId, or malformed goals", () => {
    const duplicateIds: TodoState = {
      nextId: 3,
      items: [
        { id: 1, title: "A", status: "pending", createdAt: 1, updatedAt: 1 },
        { id: 1, title: "B", status: "pending", createdAt: 2, updatedAt: 2 },
      ],
    };
    const staleNextId: TodoState = {
      nextId: 2,
      items: [
        { id: 1, title: "A", status: "pending", createdAt: 1, updatedAt: 1 },
        { id: 2, title: "B", status: "pending", createdAt: 2, updatedAt: 2 },
      ],
    };
    const malformedGoal = {
      ...first,
      goal: {
        objective: "Broken",
        doneWhen: [],
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      },
    };

    const restored = replayTodoState({
      getBranch: () => [
        toolResult(first),
        toolResult(duplicateIds),
        toolResult(staleNextId),
        toolResult(malformedGoal),
      ],
    });
    expect(restored).toEqual(first);
  });
});
