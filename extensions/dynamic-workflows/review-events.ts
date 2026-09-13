export const REVIEW_WORKFLOW_EVENT_NAME = "review";
export const REVIEW_FLOW_WORKFLOW_NAME = "review_flow";

export type ReviewWorkflowLifecycleStatus = "started" | "completed" | "failed" | "cancelled";
export type ReviewWorkflowEventName = `workflow:${ReviewWorkflowLifecycleStatus}`;

export type ReviewWorkflowLifecycleEvent = {
  name: typeof REVIEW_WORKFLOW_EVENT_NAME;
  status: ReviewWorkflowLifecycleStatus;
  workflowName: typeof REVIEW_FLOW_WORKFLOW_NAME;
  runId: string;
  taskId: string;
  artifactDir: string;
  outputPath: string;
  error?: string;
};

export function reviewWorkflowEventName(
  status: ReviewWorkflowLifecycleStatus,
): ReviewWorkflowEventName {
  return `workflow:${status}`;
}
