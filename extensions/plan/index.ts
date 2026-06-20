import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatAdditionalUserInstructionsBlock } from "../../lib/prompt";

const BUSY_MESSAGE = "エージェントが処理中です。完了後に再実行してください。";

const PLAN_PROMPT = `Create PLAN.md from the investigation and selection work in this session.

Requirements:
- Do not start implementation.
- Before writing PLAN.md, inspect relevant files, existing design, constraints, dependencies, and candidate work. Select what should be implemented, excluded, or deferred.
- Include an Implementation Tasks section designed for Coding Agent execution through /impl, not for human time management.
- Write agent-executable work units. Each selected work unit must carry these fields: objective, inputs/constraints, expected change scope, dependencies/handoff, parallelization or async notes, observable outcome, and validation evidence.
- Split work only at real dependency, parallelization, or validation boundaries. Avoid mechanical decomposition by file, function, individual test, or command.
- If useful, add a brief separate note for excluded or deferred candidates and why they were not selected.
- Use numbered lists or normal bullets for tasks, not Markdown checkboxes such as \`- [ ] task\`.
- PLAN.md is not the progress tracker; later progress belongs in the pi todo tool during /impl.
- Ask clarifying questions when ambiguity affects implementation decisions.`;

const IMPL_PROMPT = `Read PLAN.md and implement it.

Before implementation:
- Treat PLAN.md's Implementation Tasks section as an agent execution graph, not a human checklist.
- Create pi todo items from the selected work units, preserving each unit's fields in the todo descriptions.
- Do not create one todo per PLAN.md bullet mechanically; merge or split only when needed for agent-executable implementation loops, and record the reason in implementation-notes.md.
- Order the active todo sequence by dependency. Use concurrency or subagents for independent work only when safe, supported, and useful.
- Use the pi todo tool as the execution progress tracker.

During implementation:
- Track progress in the pi todo tool, not by checking off items in PLAN.md.
- Keep a running Japanese implementation-notes.md with decisions not covered by the spec, changes made, tradeoffs, and user-relevant notes.
- Treat PLAN.md as a working plan. If new findings require course correction, update the pi todo list before continuing.
- Validate each todo against its preserved outcome and evidence. Choose concrete checks based on actual changes instead of treating PLAN.md as a fixed command checklist.
- Update PLAN.md only when the actual plan, design, or assumptions change.`;

function stripInstructionSeparator(args: string): string {
  return args
    .trim()
    .replace(/^--(?:\s+|$)/, "")
    .trim();
}

function appendAdditionalInstructions(prompt: string, args: string): string {
  const instructions = stripInstructionSeparator(args);
  if (!instructions) return prompt;

  return `${prompt}\n\n## Additional User Instructions\n\nApply the user-provided instructions in the XML-like block only if they do not conflict with the requirements above.\n\n${formatAdditionalUserInstructionsBlock(instructions)}`;
}

function sendWorkflowPrompt(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: Pick<ExtensionCommandContext, "isIdle" | "ui">,
  prompt: string,
  args: string,
): void {
  if (!ctx.isIdle()) {
    ctx.ui.notify(BUSY_MESSAGE, "warning");
    return;
  }

  pi.sendUserMessage(appendAdditionalInstructions(prompt, args));
}

export default function planExtension(pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Create PLAN.md from the current session investigation",
    handler: async (args, ctx) => sendWorkflowPrompt(pi, ctx, PLAN_PROMPT, args),
  });

  pi.registerCommand("impl", {
    description: "Implement PLAN.md using pi todo tracking and Japanese notes",
    handler: async (args, ctx) => sendWorkflowPrompt(pi, ctx, IMPL_PROMPT, args),
  });
}
