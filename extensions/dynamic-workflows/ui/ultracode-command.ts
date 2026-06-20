import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type UltracodePolicyCommandAction = "on" | "off" | "status";

const ULTRACODE_COMMAND_USAGE = "使い方: /ultracode <on|off|status>";
const ULTRACODE_POLICY_PROMPT = `<system-reminder>
ultracode policy mode is ON for this Pi session.
For substantive tasks that benefit from decomposition, parallel investigation, or adversarial verification, prefer authoring and launching a dynamic workflow with the workflow tool.
The workflow tool is available but not automatically selected; do not launch one for quick single-file edits, simple factual questions, or tasks without an objective verification path.
Skill-packaged workflow discovery is not authorization by itself; only use a packaged workflow when the user request or loaded skill instructions explicitly authorize workflow launch.
Keep every workflow bounded and auditable: define phases, use short agent labels, and return compact JSON-serializable results.
</system-reminder>`;

export function registerUltracodePolicyCommand(
  pi: Pick<ExtensionAPI, "on" | "registerCommand">,
): void {
  let enabled = false;

  pi.on("session_start", () => {
    enabled = false;
  });

  pi.registerCommand("ultracode", {
    description: "Toggle optional ultracode workflow policy mode for the current session",
    handler: async (commandArgs: string, ctx: ExtensionCommandContext) => {
      const action = parseUltracodePolicyCommandArgs(commandArgs);
      if (action === undefined) {
        ctx.ui.notify(ULTRACODE_COMMAND_USAGE, "error");
        return;
      }

      if (action === "on") {
        enabled = true;
        ctx.ui.notify("/ultracode: policy mode を有効化しました。", "info");
        return;
      }

      if (action === "off") {
        enabled = false;
        ctx.ui.notify("/ultracode: policy mode を無効化しました。", "info");
        return;
      }

      ctx.ui.notify(formatUltracodePolicyStatus(enabled), "info");
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled) return undefined;
    return { systemPrompt: appendUltracodePolicyPrompt(event.systemPrompt) };
  });
}

export function parseUltracodePolicyCommandArgs(
  commandArgs: string,
): UltracodePolicyCommandAction | undefined {
  const action = commandArgs.trim().toLowerCase();
  if (action === "" || action === "status") return "status";
  if (action === "on" || action === "enable") return "on";
  if (action === "off" || action === "disable") return "off";
  return undefined;
}

export function appendUltracodePolicyPrompt(systemPrompt: string): string {
  return `${systemPrompt}\n\n${ULTRACODE_POLICY_PROMPT}`;
}

function formatUltracodePolicyStatus(enabled: boolean): string {
  return `/ultracode: policy mode は${enabled ? "有効" : "無効"}です。`;
}
