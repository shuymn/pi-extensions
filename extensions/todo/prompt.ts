import { activeGoal, activeTodos, inProgressTodo, pendingTodos } from "./selectors";
import { isTerminalTodoStatus, type TodoGoal, type TodoItem, type TodoState } from "./state";

const DEFAULT_MAX_LINES = 12;

function icon(item: TodoItem): string {
  switch (item.status) {
    case "in_progress":
      return "●";
    case "pending":
      return "○";
    case "completed":
      return "✓";
    case "cancelled":
      return "×";
  }
}

function overflowLines(lines: string[], capacity: number): string[] {
  if (lines.length <= capacity) return lines;
  if (capacity <= 0) return [];
  const shown = lines.slice(0, Math.max(0, capacity - 1));
  const hidden = lines.length - shown.length;
  return [...shown, `... ${hidden} more`];
}

function todoReminderLines(state: TodoState): string[] {
  const candidates = [
    ...activeTodos(state),
    ...state.items.filter((item) => isTerminalTodoStatus(item.status)),
  ];
  return candidates.map((item) => `${icon(item)} #${item.id} ${item.title}`);
}

function goalLines(goal: TodoGoal): string[] {
  const lines = [`Goal: ${goal.objective}`];
  lines.push(...goal.doneWhen.map((condition) => `- Done when: ${condition}`));
  if (goal.verification) {
    lines.push(...goal.verification.map((evidence) => `- Verification: ${evidence}`));
  }
  return lines;
}

export function renderTodoReminder(
  state: TodoState,
  options: { maxLines?: number } = {},
): string | undefined {
  const goal = activeGoal(state);
  if (!goal && activeTodos(state).length === 0) return undefined;

  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const protocol = goal
    ? [
        "Protocol:",
        "- Continue the single in_progress todo; otherwise pick the next pending todo before tool use.",
        "- After closing todos, evaluate the active goal against doneWhen.",
        "- Before final response, satisfy_goal, abandon_goal, clear_goal, or explain why the active goal remains.",
      ]
    : [
        "Protocol:",
        "- Continue the single in_progress todo.",
        "- If no todo is in_progress, pick the next pending todo before tool use.",
        "- Before final response, close or explicitly explain remaining todos.",
      ];
  const footer = ["</todo-state>"];

  if (!goal) {
    const header = ["<todo-state>", "Current todos:"];
    const todoLines = todoReminderLines(state);
    const fixedLineCount = header.length + 1 + protocol.length + footer.length;
    const shown = overflowLines(todoLines, Math.max(0, maxLines - fixedLineCount));
    return [...header, ...shown, "", ...protocol, ...footer].join("\n");
  }

  const bodyLines = [
    ...goalLines(goal),
    ...(state.items.length > 0 ? ["Current todos:", ...todoReminderLines(state)] : []),
  ];
  const header = ["<todo-state>"];
  const fixedLineCount = header.length + 1 + protocol.length + footer.length;
  const shown = overflowLines(bodyLines, Math.max(0, maxLines - fixedLineCount));
  return [...header, ...shown, "", ...protocol, ...footer].join("\n");
}

export function nextActionText(state: TodoState): string | undefined {
  const active = inProgressTodo(state);
  const pending = pendingTodos(state);
  if (!active && pending.length > 0) {
    return "No todo is in_progress. Pick one pending todo and mark it in_progress before continuing.";
  }
  return undefined;
}
