import type { Component } from "@earendil-works/pi-tui";
import { truncateLines } from "../../../lib/tui";

export type WorkflowRenderAgent = {
  label: string;
  phase?: string;
  prompt: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
  error?: string;
};

export type WorkflowRenderDetails = {
  status: "running" | "completed";
  workflowName: string;
  description?: string;
  phases: string[];
  logs: string[];
  agents: WorkflowRenderAgent[];
  agentCount: number;
  result?: unknown;
  durationMs?: number;
};

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

class LinesComponent implements Component {
  constructor(private readonly lines: string[]) {}

  render(width: number): string[] {
    return truncateLines(this.lines, width);
  }

  invalidate(): void {}
}

export function createWorkflowCallComponent(theme: ThemeLike): Component {
  return new LinesComponent([theme.fg("toolTitle", theme.bold("workflow"))]);
}

export function createWorkflowResultComponent(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  theme: ThemeLike,
): Component {
  const details = result.details as WorkflowRenderDetails | undefined;
  if (isWorkflowRenderDetails(details)) {
    return new LinesComponent(renderWorkflowStatusLines(details));
  }

  const first = result.content?.[0];
  return new LinesComponent([
    first?.type === "text" ? (first.text ?? "") : theme.fg("muted", "workflow"),
  ]);
}

export function renderWorkflowStatusText(details: WorkflowRenderDetails): string {
  return renderWorkflowStatusLines(details).join("\n");
}

export function renderWorkflowStatusLines(details: WorkflowRenderDetails): string[] {
  const lines = [`Workflow ${details.workflowName}: ${details.status}`];
  if (details.phases.length > 0) lines.push(`Phases: ${details.phases.join(" → ")}`);
  if (details.agents.length > 0) {
    lines.push(
      ...details.agents.slice(-4).map((agent) => {
        const phase = agent.phase ? ` [${agent.phase}]` : "";
        const suffix = agent.error ? ` — ${agent.error}` : "";
        return `- ${agent.status}${phase} ${agent.label}${suffix}`;
      }),
    );
  }
  if (details.logs.length > 0) lines.push(`Log: ${details.logs.at(-1)}`);
  if (details.durationMs !== undefined) lines.push(`Duration: ${details.durationMs}ms`);
  return lines;
}

function isWorkflowRenderDetails(
  value: WorkflowRenderDetails | undefined,
): value is WorkflowRenderDetails {
  return Boolean(
    value &&
      typeof value.workflowName === "string" &&
      (value.status === "running" || value.status === "completed") &&
      Array.isArray(value.phases) &&
      Array.isArray(value.logs) &&
      Array.isArray(value.agents) &&
      typeof value.agentCount === "number",
  );
}
