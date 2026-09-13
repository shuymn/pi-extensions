import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const GOAL_ENTRY = "goal-state-v1";
export const CONTINUATION_LIMIT = 20;
export const GOAL_STATUSES = [
  "running",
  "paused",
  "waiting",
  "completed",
  "limited",
  "failed",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type Goal = {
  objective: string;
  doneWhen: string[];
  status: GoalStatus;
  continuations: number;
  evidence: string;
};

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.trim())
  );
}
export function isGoal(value: unknown): value is Goal {
  if (!value || typeof value !== "object") return false;
  const g = value as Goal;
  return (
    typeof g.objective === "string" &&
    !!g.objective.trim() &&
    strings(g.doneWhen) &&
    GOAL_STATUSES.includes(g.status) &&
    Number.isInteger(g.continuations) &&
    g.continuations >= 0 &&
    g.continuations <= CONTINUATION_LIMIT &&
    typeof g.evidence === "string"
  );
}

// Branch entries survive compaction; summaries are never parsed to recover permission.
export function restoreGoal(entries: readonly SessionEntry[]): Goal | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type === "custom" && entry.customType === GOAL_ENTRY && isGoal(entry.data)) {
      return {
        ...entry.data,
        doneWhen: [...entry.data.doneWhen],
        status: entry.data.status === "running" ? "paused" : entry.data.status,
      };
    }
  }
  // Legacy todo goals are historical data, never executable authority.
  return undefined;
}

export function goalContext(goal: Goal): string {
  return (
    `Goal state (authoritative structured session state):\n${JSON.stringify(goal)}\n` +
    "Check every doneWhen condition. " +
    "Use goal complete with verification evidence only when all conditions are met. " +
    "Use goal wait before asking for required human input or approval, or goal stop to pause. " +
    "Never bypass human input or permissions."
  );
}

export function parseGoalStart(text: string): Pick<Goal, "objective" | "doneWhen"> | undefined {
  const [objective, ...doneWhen] = text.split("|").map((s) => s.trim());
  if (!objective || !strings(doneWhen)) return undefined;
  return { objective, doneWhen };
}
