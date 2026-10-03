import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { toCliExec } from "../../lib/cli";
import { isOneShotPrimaryModeSelected } from "../../lib/one-shot-flow";
import { createTavilyToolDefinitions } from "../../lib/tavily-tools";

export default function (pi: ExtensionAPI) {
  const exposure = isOneShotPrimaryModeSelected() ? "direct" : "deferred";
  for (const definition of createTavilyToolDefinitions(toCliExec(pi))) {
    // One-shot flows restrict active tools; deferred tools bypass that boundary for nested calls.
    pi.registerTool({
      ...definition,
      exposure,
    });
  }
}
