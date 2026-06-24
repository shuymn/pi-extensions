import { describe, expect, test } from "bun:test";
import type { TodoCreateItemParams, TodoState } from "./state";
import { applyTodoMutation, cloneTodoState, EMPTY_TODO_STATE, isTodoState } from "./state";

const NOW = 1000;

const createItems = <T extends [TodoCreateItemParams, ...TodoCreateItemParams[]]>(items: T) => ({
  action: "create" as const,
  items,
});

const createOne = (title: string) => createItems([{ title }]);

describe("todo state", () => {
  test("create adds consecutive pending todos", () => {
    const result = applyTodoMutation(
      EMPTY_TODO_STATE,
      createItems([
        { title: "Investigate widget", description: "Find current shape" },
        { title: "Implement widget", activeForm: "Implementing widget" },
      ]),
      NOW,
    );
    expect(result.op).toEqual({ kind: "create", ids: [1, 2] });
    expect(result.state).toEqual({
      nextId: 3,
      items: [
        {
          id: 1,
          title: "Investigate widget",
          description: "Find current shape",
          status: "pending",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: 2,
          title: "Implement widget",
          activeForm: "Implementing widget",
          status: "pending",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
  });

  test("create without items returns an error op without mutation", () => {
    const result = applyTodoMutation(EMPTY_TODO_STATE, { action: "create" } as never, NOW);
    expect(result.op).toEqual({
      kind: "error",
      message: "items is required for create.",
    });
    expect(result.state).toEqual(EMPTY_TODO_STATE);
  });

  test("create with invalid items returns an error op without mutation", () => {
    const cases = [
      {
        params: { action: "create", items: [{ title: "A" }, { title: "  " }] },
        message: "items[1].title is required for create.",
      },
      {
        params: { action: "create", items: [null] },
        message: "items[0] must be an object for create.",
      },
      {
        params: { action: "create", items: [{ title: 123 }] },
        message: "items[0].title is required for create.",
      },
      {
        params: { action: "create", items: [{ title: "A", description: 123 }] },
        message: "items[0].description must be a string.",
      },
      {
        params: { action: "create", items: [{ title: "A", activeForm: 123 }] },
        message: "items[0].activeForm must be a string.",
      },
      {
        params: { action: "create", title: "A" },
        message: "items is required for create.",
      },
    ];

    for (const { params, message } of cases) {
      const result = applyTodoMutation(EMPTY_TODO_STATE, params as never, NOW);
      expect(result.op).toEqual({ kind: "error", message });
      expect(result.state).toEqual(EMPTY_TODO_STATE);
    }
  });

  test("update changes status and rejects unknown ids", () => {
    const first = applyTodoMutation(EMPTY_TODO_STATE, createOne("A"), NOW).state;
    const created = applyTodoMutation(first, createOne("B"), NOW).state;
    const updated = applyTodoMutation(
      created,
      { action: "update", id: 1, status: "completed" },
      NOW + 1,
    );
    expect(updated.op).toEqual({
      kind: "update",
      id: 1,
      title: "A",
      fromStatus: "pending",
      toStatus: "completed",
    });
    expect(updated.state.items[0].status).toBe("completed");

    const missing = applyTodoMutation(
      created,
      { action: "update", id: 99, status: "completed" },
      NOW + 1,
    );
    expect(missing.op).toEqual({
      kind: "error",
      message: "unknown todo id: 99.",
    });
  });

  test("setting in_progress returns any previous in_progress item to pending", () => {
    const one = applyTodoMutation(EMPTY_TODO_STATE, createOne("A"), NOW).state;
    const two = applyTodoMutation(one, createOne("B"), NOW).state;
    const activeA = applyTodoMutation(
      two,
      { action: "update", id: 1, status: "in_progress" },
      NOW,
    ).state;
    const activeB = applyTodoMutation(
      activeA,
      { action: "update", id: 2, status: "in_progress" },
      NOW,
    ).state;
    expect(activeB.items.map((item) => [item.id, item.status])).toEqual([
      [1, "pending"],
      [2, "in_progress"],
    ]);
  });

  test("updating the final active todo to terminal status auto-clears closed todos", () => {
    const created = applyTodoMutation(EMPTY_TODO_STATE, createOne("A"), NOW).state;
    const completed = applyTodoMutation(
      created,
      { action: "update", id: 1, status: "completed" },
      NOW + 1,
    );

    expect(completed.op).toEqual({
      kind: "update",
      id: 1,
      title: "A",
      fromStatus: "pending",
      toStatus: "completed",
      autoCleared: { count: 1 },
    });
    expect(completed.state).toEqual(EMPTY_TODO_STATE);

    const cancelled = applyTodoMutation(
      created,
      { action: "update", id: 1, status: "cancelled" },
      NOW + 1,
    );
    expect(cancelled.op).toEqual({
      kind: "update",
      id: 1,
      title: "A",
      fromStatus: "pending",
      toStatus: "cancelled",
      autoCleared: { count: 1 },
    });
    expect(cancelled.state).toEqual(EMPTY_TODO_STATE);
  });

  test("metadata-only updates to terminal-only todos do not auto-clear", () => {
    const state = {
      nextId: 2,
      items: [
        {
          id: 1,
          title: "A",
          status: "completed" as const,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };

    const updated = applyTodoMutation(
      state,
      { action: "update", id: 1, description: "Done" },
      NOW + 1,
    );

    expect(updated.op).toEqual({
      kind: "update",
      id: 1,
      title: "A",
      fromStatus: "completed",
      toStatus: "completed",
    });
    expect(updated.state.items).toEqual([
      {
        id: 1,
        title: "A",
        description: "Done",
        status: "completed",
        createdAt: NOW,
        updatedAt: NOW + 1,
      },
    ]);
  });

  test("clear resets items, goal, and nextId", () => {
    const withGoal = applyTodoMutation(
      EMPTY_TODO_STATE,
      {
        action: "set_goal",
        objective: "Ship goal support",
        doneWhen: ["Goal state exists"],
      },
      NOW,
    ).state;
    const created = applyTodoMutation(withGoal, createOne("A"), NOW).state;
    const cleared = applyTodoMutation(created, { action: "clear" }, NOW);
    expect(cleared.op).toEqual({ kind: "clear", count: 1, clearedGoal: true });
    expect(cleared.state).toEqual(EMPTY_TODO_STATE);
  });

  test("set_goal stores a normalized active goal without changing existing todos", () => {
    const created = applyTodoMutation(EMPTY_TODO_STATE, createOne("A"), NOW).state;
    const result = applyTodoMutation(
      created,
      {
        action: "set_goal",
        objective: "  Ship goal support  ",
        doneWhen: [" Goal is visible ", " Tests pass "],
        verification: [" bun test extensions/todo/state.test.ts "],
      },
      NOW + 1,
    );

    expect(result.op).toEqual({
      kind: "set_goal",
      objective: "Ship goal support",
      replaced: false,
    });
    expect(result.state).toEqual({
      ...created,
      goal: {
        objective: "Ship goal support",
        doneWhen: ["Goal is visible", "Tests pass"],
        verification: ["bun test extensions/todo/state.test.ts"],
        status: "active",
        createdAt: NOW + 1,
        updatedAt: NOW + 1,
      },
    });
  });

  test("set_goal reports when it replaces an existing goal", () => {
    const first = applyTodoMutation(
      EMPTY_TODO_STATE,
      { action: "set_goal", objective: "A", doneWhen: ["A done"] },
      NOW,
    ).state;
    const second = applyTodoMutation(
      first,
      { action: "set_goal", objective: "B", doneWhen: ["B done"] },
      NOW + 1,
    );

    expect(second.op).toEqual({ kind: "set_goal", objective: "B", replaced: true });
    expect(second.state.goal?.objective).toBe("B");
    expect(second.state.goal?.createdAt).toBe(NOW + 1);
  });

  test("goal actions reject invalid params without mutation", () => {
    const active = applyTodoMutation(
      EMPTY_TODO_STATE,
      { action: "set_goal", objective: "A", doneWhen: ["Done"] },
      NOW,
    ).state;
    const cases = [
      {
        state: EMPTY_TODO_STATE,
        params: { action: "set_goal", objective: " ", doneWhen: ["Done"] },
        message: "objective is required for set_goal.",
      },
      {
        state: EMPTY_TODO_STATE,
        params: { action: "set_goal", objective: "A" },
        message: "doneWhen must contain at least one completion condition for set_goal.",
      },
      {
        state: EMPTY_TODO_STATE,
        params: { action: "set_goal", objective: "A", doneWhen: [] },
        message: "doneWhen must contain at least one completion condition for set_goal.",
      },
      {
        state: EMPTY_TODO_STATE,
        params: { action: "set_goal", objective: "A", doneWhen: [" "] },
        message: "doneWhen[0] must be a non-empty string.",
      },
      {
        state: EMPTY_TODO_STATE,
        params: { action: "set_goal", objective: "A", doneWhen: ["Done"], verification: 1 },
        message: "verification must be an array.",
      },
      {
        state: EMPTY_TODO_STATE,
        params: { action: "set_goal", objective: "A", doneWhen: ["Done"], verification: [""] },
        message: "verification[0] must be a non-empty string.",
      },
      {
        state: EMPTY_TODO_STATE,
        params: { action: "satisfy_goal" },
        message: "goal is not set.",
      },
      {
        state: active,
        params: { action: "satisfy_goal", verification: [""] },
        message: "verification[0] must be a non-empty string.",
      },
    ];

    for (const { state, params, message } of cases) {
      const result = applyTodoMutation(state, params as never, NOW + 1);
      expect(result.op).toEqual({ kind: "error", message });
      expect(result.state).toEqual(state);
    }
  });

  test("goal actions satisfy, abandon, and clear an active goal", () => {
    const active = applyTodoMutation(
      EMPTY_TODO_STATE,
      { action: "set_goal", objective: "A", doneWhen: ["Done"], verification: ["Planned"] },
      NOW,
    ).state;
    const satisfied = applyTodoMutation(
      active,
      { action: "satisfy_goal", verification: ["Observed"] },
      NOW + 1,
    );
    expect(satisfied.op).toEqual({ kind: "satisfy_goal", objective: "A" });
    expect(satisfied.state.goal).toEqual({
      objective: "A",
      doneWhen: ["Done"],
      verification: ["Observed"],
      status: "satisfied",
      createdAt: NOW,
      updatedAt: NOW + 1,
    });
    expect(applyTodoMutation(satisfied.state, { action: "abandon_goal" }, NOW + 2).op).toEqual({
      kind: "error",
      message: "goal is already satisfied.",
    });

    const activeAgain = applyTodoMutation(
      satisfied.state,
      { action: "set_goal", objective: "B", doneWhen: ["Done"] },
      NOW + 2,
    ).state;
    const abandoned = applyTodoMutation(activeAgain, { action: "abandon_goal" }, NOW + 3);
    expect(abandoned.op).toEqual({ kind: "abandon_goal", objective: "B" });
    expect(abandoned.state.goal?.status).toBe("abandoned");

    const cleared = applyTodoMutation(abandoned.state, { action: "clear_goal" }, NOW + 4);
    expect(cleared.op).toEqual({ kind: "clear_goal", objective: "B" });
    expect(cleared.state.goal).toBeUndefined();
  });

  test("isTodoState accepts old snapshots and rejects malformed goals", () => {
    const oldSnapshot: TodoState = {
      nextId: 2,
      items: [{ id: 1, title: "A", status: "pending", createdAt: NOW, updatedAt: NOW }],
    };
    expect(isTodoState(oldSnapshot)).toBe(true);
    expect(
      isTodoState({
        ...oldSnapshot,
        goal: {
          objective: "A",
          doneWhen: ["Done"],
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ).toBe(true);

    const malformedGoals = [
      { objective: "", doneWhen: ["Done"], status: "active", createdAt: NOW, updatedAt: NOW },
      { objective: "A", doneWhen: [], status: "active", createdAt: NOW, updatedAt: NOW },
      { objective: "A", doneWhen: [""], status: "active", createdAt: NOW, updatedAt: NOW },
      { objective: "A", doneWhen: ["Done"], status: "bad", createdAt: NOW, updatedAt: NOW },
      { objective: "A", doneWhen: ["Done"], status: "active", createdAt: "now", updatedAt: NOW },
    ];

    for (const goal of malformedGoals) {
      expect(isTodoState({ ...oldSnapshot, goal })).toBe(false);
    }
  });

  test("cloneTodoState deep-clones goal arrays", () => {
    const state = applyTodoMutation(
      EMPTY_TODO_STATE,
      {
        action: "set_goal",
        objective: "A",
        doneWhen: ["Done"],
        verification: ["Observed"],
      },
      NOW,
    ).state;
    const cloned = cloneTodoState(state);
    cloned.goal!.doneWhen.push("Mutated");
    cloned.goal!.verification!.push("Mutated");

    expect(state.goal?.doneWhen).toEqual(["Done"]);
    expect(state.goal?.verification).toEqual(["Observed"]);
  });

  test("active goal blocks final active todo auto-clear", () => {
    const withGoal = applyTodoMutation(
      EMPTY_TODO_STATE,
      { action: "set_goal", objective: "A", doneWhen: ["Done"] },
      NOW,
    ).state;
    const created = applyTodoMutation(withGoal, createOne("A"), NOW + 1).state;
    const completed = applyTodoMutation(
      created,
      { action: "update", id: 1, status: "completed" },
      NOW + 2,
    );

    expect(completed.op).toEqual({
      kind: "update",
      id: 1,
      title: "A",
      fromStatus: "pending",
      toStatus: "completed",
      goalBlockedAutoClear: true,
    });
    expect(completed.state.goal?.status).toBe("active");
    expect(completed.state.items).toEqual([
      { id: 1, title: "A", status: "completed", createdAt: NOW + 1, updatedAt: NOW + 2 },
    ]);
  });
});
