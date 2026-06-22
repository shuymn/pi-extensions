import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { toCliExec } from "../../lib/cli";
import { createTavilyToolDefinitions } from "../../lib/tavily-tools";

export default function (pi: ExtensionAPI) {
  for (const definition of createTavilyToolDefinitions(toCliExec(pi))) {
    pi.registerTool(definition);
  }
}
