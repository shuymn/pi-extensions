export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_GOAL_STATUSES = ["active", "satisfied", "abandoned"] as const;

export type TodoGoalStatus = (typeof TODO_GOAL_STATUSES)[number];

export type TodoGoal = {
  objective: string;
  doneWhen: string[];
  verification?: string[];
  status: TodoGoalStatus;
  createdAt: number;
  updatedAt: number;
};

export type TodoItem = {
  id: number;
  title: string;
  description?: string;
  status: TodoStatus;
  activeForm?: string;
  createdAt: number;
  updatedAt: number;
};

export type TodoState = {
  goal?: TodoGoal;
  items: TodoItem[];
  nextId: number;
};

export const EMPTY_TODO_STATE: TodoState = { items: [], nextId: 1 };

export const TODO_ACTIONS = [
  "create",
  "update",
  "list",
  "clear",
  "set_goal",
  "satisfy_goal",
  "abandon_goal",
  "clear_goal",
] as const;

export type TodoAction = (typeof TODO_ACTIONS)[number];

export type TodoCreateItemParams = {
  title: string;
  description?: string;
  activeForm?: string;
};

export type TodoParams =
  | {
      action: "create";
      items: [TodoCreateItemParams, ...TodoCreateItemParams[]];
    }
  | {
      action: "update";
      id?: number;
      title?: string;
      description?: string;
      status?: TodoStatus;
      activeForm?: string;
    }
  | { action: "list" }
  | { action: "clear" }
  | {
      action: "set_goal";
      objective?: string;
      doneWhen?: string[];
      verification?: string[];
    }
  | { action: "satisfy_goal"; verification?: string[] }
  | { action: "abandon_goal" }
  | { action: "clear_goal" };

export type TodoOperation =
  | { kind: "create"; ids: number[] }
  | {
      kind: "update";
      id: number;
      title: string;
      fromStatus: TodoStatus;
      toStatus: TodoStatus;
      autoCleared?: { count: number };
      goalBlockedAutoClear?: boolean;
    }
  | { kind: "list" }
  | { kind: "clear"; count: number; clearedGoal?: boolean }
  | { kind: "set_goal"; objective: string; replaced: boolean }
  | { kind: "satisfy_goal"; objective: string }
  | { kind: "abandon_goal"; objective: string }
  | { kind: "clear_goal"; objective: string }
  | { kind: "error"; message: string };

export type TodoToolDetails = {
  action: TodoAction;
  params: Record<string, unknown>;
  state: TodoState;
  op: TodoOperation;
};

export type ApplyResult = {
  state: TodoState;
  op: TodoOperation;
};

function cloneTodoGoal(goal: TodoGoal): TodoGoal {
  return {
    ...goal,
    doneWhen: [...goal.doneWhen],
    verification: goal.verification ? [...goal.verification] : undefined,
  };
}

export function cloneTodoState(state: TodoState): TodoState {
  return {
    ...(state.goal ? { goal: cloneTodoGoal(state.goal) } : {}),
    nextId: state.nextId,
    items: state.items.map((item) => ({ ...item })),
  };
}

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && TODO_STATUSES.includes(value as TodoStatus);
}

export function isTodoGoalStatus(value: unknown): value is TodoGoalStatus {
  return typeof value === "string" && TODO_GOAL_STATUSES.includes(value as TodoGoalStatus);
}

export function isActiveTodoStatus(status: TodoStatus): boolean {
  return status === "pending" || status === "in_progress";
}

export function isTerminalTodoStatus(status: TodoStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export function isActiveTodoGoalStatus(status: TodoGoalStatus): boolean {
  return status === "active";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(
  value: unknown,
  options: { requireNonEmpty: boolean },
): value is string[] {
  if (!Array.isArray(value)) return false;
  if (options.requireNonEmpty && value.length === 0) return false;
  return value.every(isNonEmptyString);
}

function isTodoGoal(value: unknown): value is TodoGoal {
  if (typeof value !== "object" || value === null) return false;
  const goal = value as TodoGoal;
  return (
    isNonEmptyString(goal.objective) &&
    isNonEmptyStringArray(goal.doneWhen, { requireNonEmpty: true }) &&
    (goal.verification === undefined ||
      isNonEmptyStringArray(goal.verification, { requireNonEmpty: false })) &&
    isTodoGoalStatus(goal.status) &&
    typeof goal.createdAt === "number" &&
    typeof goal.updatedAt === "number"
  );
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as TodoItem;
  return (
    Number.isInteger(item.id) &&
    item.id > 0 &&
    typeof item.title === "string" &&
    item.title.trim().length > 0 &&
    isTodoStatus(item.status) &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number" &&
    (item.description === undefined || typeof item.description === "string") &&
    (item.activeForm === undefined || typeof item.activeForm === "string")
  );
}

export function isTodoState(value: unknown): value is TodoState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as TodoState;
  if (state.goal !== undefined && !isTodoGoal(state.goal)) return false;
  if (!Number.isInteger(state.nextId) || state.nextId < 1) return false;
  if (!Array.isArray(state.items) || !state.items.every(isTodoItem)) {
    return false;
  }
  const ids = new Set<number>();
  let maxId = 0;
  for (const item of state.items) {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    maxId = Math.max(maxId, item.id);
  }
  if (state.nextId <= maxId) return false;
  return state.items.filter((item) => item.status === "in_progress").length <= 1;
}

function error(state: TodoState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

function normalizeGoalObjective(value: unknown): { value?: string; message?: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { message: "objective is required for set_goal." };
  }
  return { value: value.trim() };
}

function normalizeStringList(
  value: unknown,
  field: "doneWhen" | "verification",
  options: { required: boolean; action: string },
): { value?: string[]; message?: string } {
  if (!Array.isArray(value)) {
    if (options.required) {
      return {
        message: `${field} must contain at least one completion condition for ${options.action}.`,
      };
    }
    return { message: `${field} must be an array.` };
  }
  if (options.required && value.length === 0) {
    return {
      message: `${field} must contain at least one completion condition for ${options.action}.`,
    };
  }

  const normalized: string[] = [];
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      return { message: `${field}[${index}] must be a non-empty string.` };
    }
    normalized.push(candidate.trim());
  }

  return { value: normalized.length > 0 ? normalized : undefined };
}

function requireActiveGoal(current: TodoState): { goal?: TodoGoal; result?: ApplyResult } {
  if (!current.goal) {
    return { result: error(current, "goal is not set.") };
  }
  if (!isActiveTodoGoalStatus(current.goal.status)) {
    return { result: error(current, `goal is already ${current.goal.status}.`) };
  }
  return { goal: current.goal };
}

export function applyTodoMutation(state: TodoState, params: TodoParams, now: number): ApplyResult {
  const current = cloneTodoState(state);

  if (params.action === "list") {
    return { state: current, op: { kind: "list" } };
  }

  if (params.action === "clear") {
    return {
      state: cloneTodoState(EMPTY_TODO_STATE),
      op: {
        kind: "clear",
        count: current.items.length,
        ...(current.goal ? { clearedGoal: true } : {}),
      },
    };
  }

  if (params.action === "set_goal") {
    const objective = normalizeGoalObjective(params.objective);
    if (objective.message) return error(current, objective.message);
    const objectiveValue = objective.value;
    if (objectiveValue === undefined) return error(current, "objective is required for set_goal.");

    const doneWhen = normalizeStringList(params.doneWhen, "doneWhen", {
      required: true,
      action: "set_goal",
    });
    if (doneWhen.message) return error(current, doneWhen.message);
    const doneWhenValue = doneWhen.value;
    if (doneWhenValue === undefined) {
      return error(
        current,
        "doneWhen must contain at least one completion condition for set_goal.",
      );
    }

    const verification =
      params.verification === undefined
        ? { value: undefined }
        : normalizeStringList(params.verification, "verification", {
            required: false,
            action: "set_goal",
          });
    if (verification.message) return error(current, verification.message);

    return {
      state: {
        ...current,
        goal: {
          objective: objectiveValue,
          doneWhen: doneWhenValue,
          verification: verification.value,
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      },
      op: { kind: "set_goal", objective: objectiveValue, replaced: current.goal !== undefined },
    };
  }

  if (params.action === "satisfy_goal") {
    const requiredGoal = requireActiveGoal(current);
    if (requiredGoal.result) return requiredGoal.result;
    const goal = requiredGoal.goal;
    if (!goal) return error(current, "goal is not set.");

    const verification =
      params.verification === undefined
        ? { value: undefined }
        : normalizeStringList(params.verification, "verification", {
            required: false,
            action: "satisfy_goal",
          });
    if (verification.message) return error(current, verification.message);

    return {
      state: {
        ...current,
        goal: {
          ...goal,
          verification: params.verification === undefined ? goal.verification : verification.value,
          status: "satisfied",
          updatedAt: now,
        },
      },
      op: { kind: "satisfy_goal", objective: goal.objective },
    };
  }

  if (params.action === "abandon_goal") {
    const requiredGoal = requireActiveGoal(current);
    if (requiredGoal.result) return requiredGoal.result;
    const goal = requiredGoal.goal;
    if (!goal) return error(current, "goal is not set.");

    return {
      state: {
        ...current,
        goal: { ...goal, status: "abandoned", updatedAt: now },
      },
      op: { kind: "abandon_goal", objective: goal.objective },
    };
  }

  if (params.action === "clear_goal") {
    if (!current.goal) return error(current, "goal is not set.");
    const { goal: _goal, ...withoutGoal } = current;
    return {
      state: withoutGoal,
      op: { kind: "clear_goal", objective: current.goal.objective },
    };
  }

  if (params.action === "create") {
    if (!Array.isArray(params.items) || params.items.length === 0) {
      return error(current, "items is required for create.");
    }

    const items: TodoItem[] = [];
    for (const [index, candidate] of params.items.entries()) {
      if (typeof candidate !== "object" || candidate === null) {
        return error(current, `items[${index}] must be an object for create.`);
      }
      if (typeof candidate.title !== "string") {
        return error(current, `items[${index}].title is required for create.`);
      }
      const title = candidate.title.trim();
      if (!title) {
        return error(current, `items[${index}].title is required for create.`);
      }
      if (candidate.description !== undefined && typeof candidate.description !== "string") {
        return error(current, `items[${index}].description must be a string.`);
      }
      if (candidate.activeForm !== undefined && typeof candidate.activeForm !== "string") {
        return error(current, `items[${index}].activeForm must be a string.`);
      }
      items.push({
        id: current.nextId + index,
        title,
        description: candidate.description?.trim() || undefined,
        status: "pending",
        activeForm: candidate.activeForm?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
      });
    }

    return {
      state: {
        ...current,
        items: [...current.items, ...items],
        nextId: current.nextId + items.length,
      },
      op: { kind: "create", ids: items.map((item) => item.id) },
    };
  }

  if (params.action === "update") {
    if (!Number.isInteger(params.id)) {
      return error(current, "id is required for update.");
    }
    const id = params.id as number;
    const hasMutation =
      params.status !== undefined ||
      params.title !== undefined ||
      params.description !== undefined ||
      params.activeForm !== undefined;
    if (!hasMutation) {
      return error(current, "update requires status, title, description, or activeForm.");
    }
    if (params.status !== undefined && !isTodoStatus(params.status)) {
      return error(current, "status is invalid.");
    }

    const existing = current.items.find((item) => item.id === id);
    if (!existing) {
      return error(current, `unknown todo id: ${id}.`);
    }

    const fromStatus = existing.status;
    const toStatus = params.status ?? existing.status;
    const title = params.title?.trim();
    if (params.title !== undefined && !title) {
      return error(current, "title must not be empty.");
    }

    const items = current.items.map((item) => {
      if (params.status === "in_progress" && item.id !== id && item.status === "in_progress") {
        return { ...item, status: "pending" as const, updatedAt: now };
      }
      if (item.id !== id) return item;
      return {
        ...item,
        title: title ?? item.title,
        description:
          params.description === undefined
            ? item.description
            : params.description.trim() || undefined,
        activeForm:
          params.activeForm === undefined ? item.activeForm : params.activeForm.trim() || undefined,
        status: toStatus,
        updatedAt: now,
      };
    });

    const nextState = { ...current, items, nextId: current.nextId };
    const op: TodoOperation = {
      kind: "update",
      id,
      title: title ?? existing.title,
      fromStatus,
      toStatus,
    };
    const hasActiveTodos = items.some((item) => isActiveTodoStatus(item.status));
    const closedActiveTodo = isActiveTodoStatus(fromStatus) && isTerminalTodoStatus(toStatus);
    if (closedActiveTodo && !hasActiveTodos) {
      if (current.goal && isActiveTodoGoalStatus(current.goal.status)) {
        return {
          state: nextState,
          op: { ...op, goalBlockedAutoClear: true },
        };
      }
      return {
        state: cloneTodoState(EMPTY_TODO_STATE),
        op: { ...op, autoCleared: { count: items.length } },
      };
    }

    return { state: nextState, op };
  }

  return error(current, "unknown action.");
}
