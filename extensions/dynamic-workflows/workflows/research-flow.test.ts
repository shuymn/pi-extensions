import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../runtime/runtime";
import { extensionPackagedWorkflowRootDescriptors } from "../saved/packaged";
import { listSavedWorkflows, resolveSavedWorkflow } from "../saved/resolver";

type AgentCall = { prompt: string; label?: string; phase?: string; hasSchema: boolean };

const PACKAGED_ROOTS = extensionPackagedWorkflowRootDescriptors();

async function loadResearchFlow() {
  return await resolveSavedWorkflow(PACKAGED_ROOTS, "research_flow");
}

describe("packaged research_flow workflow", () => {
  test("is discoverable as an extension-packaged workflow with provenance", async () => {
    const workflows = await listSavedWorkflows(PACKAGED_ROOTS);
    const research = workflows.find((workflow) => workflow.name === "research_flow");
    expect(research).toMatchObject({
      name: "research_flow",
      fileName: "research-flow.js",
      source: "extension",
      phases: [
        { title: "Frame" },
        { title: "Collect" },
        { title: "Assess" },
        { title: "Synthesize" },
      ],
    });
  });

  test("loops Assess -> Collect up to the cap when assessment keeps asking for more", async () => {
    const workflow = await loadResearchFlow();
    const calls: AgentCall[] = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: { task: "Compare Pi extension packaging options", depth: "standard", maxSources: 6 },
      agent: (prompt, options) => {
        calls.push({
          prompt,
          label: options.label,
          phase: options.phase,
          hasSchema: options.schema !== undefined,
        });
        if (options.label?.startsWith("assess")) {
          // Always request another collection pass to exercise the cap.
          return {
            needMoreCollection: true,
            followUpQueries: [{ query: `more ${options.label}`, purpose: "fill gap" }],
          };
        }
        return { label: options.label };
      },
    });

    expect(result.meta.name).toBe("research_flow");
    expect(result.phases).toEqual(["Frame", "Collect", "Assess", "Synthesize"]);
    // 1 frame + (1 initial + 2 capped follow-up) collect + 3 assess + 1 synthesis.
    expect(result.agentCount).toBe(8);
    expect(calls.map((call) => call.label)).toEqual([
      "frame",
      "collect",
      "assess",
      "collect-followup-1",
      "assess-2",
      "collect-followup-2",
      "assess-3",
      "synthesis",
    ]);
    expect(calls.map((call) => call.phase)).toEqual([
      "Frame",
      "Collect",
      "Assess",
      "Collect",
      "Assess",
      "Collect",
      "Assess",
      "Synthesize",
    ]);
    // Every phase uses structured output for auditable, parse-free handoff.
    expect(calls.every((call) => call.hasSchema)).toBe(true);
    // Untrusted-input guard and tavily_research exclusion are present in prompts.
    expect(calls[1]!.prompt).toContain("untrusted");
    expect(calls[1]!.prompt).toContain("do not use high-cost tavily_research");
    expect(result.result).toMatchObject({ label: "synthesis" });
  });

  test("stops after one Collect/Assess pass when assessment is satisfied", async () => {
    const workflow = await loadResearchFlow();
    const calls: AgentCall[] = [];

    const result = await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: { task: "Single-pass research question" },
      agent: (prompt, options) => {
        calls.push({
          prompt,
          label: options.label,
          phase: options.phase,
          hasSchema: options.schema !== undefined,
        });
        if (options.label?.startsWith("assess")) {
          return { needMoreCollection: false, followUpQueries: [] };
        }
        return { label: options.label };
      },
    });

    expect(result.agentCount).toBe(4);
    expect(calls.map((call) => call.label)).toEqual(["frame", "collect", "assess", "synthesis"]);
    expect(calls.map((call) => call.phase)).toEqual(["Frame", "Collect", "Assess", "Synthesize"]);
    expect(result.result).toMatchObject({ label: "synthesis" });
  });
});
