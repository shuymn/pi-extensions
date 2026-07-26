import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../runtime/runtime";
import { extensionPackagedWorkflowRootDescriptors } from "../saved/packaged";
import { listSavedWorkflows, resolveSavedWorkflow } from "../saved/resolver";

type AgentCall = {
  prompt: string;
  label?: string;
  phase?: string;
  hasSchema: boolean;
  toolPolicy?: string;
  allowedTools?: string[];
};

const PACKAGED_ROOTS = extensionPackagedWorkflowRootDescriptors();

const FRAME_OUTPUT = {
  objective: "answer the task",
  questions: ["what matters?"],
  searchStrategy: ["search primary sources"],
  assumptions: [],
};
const COLLECT_OUTPUT = { sources: [], searchTrace: [] };
const SYNTHESIS_OUTPUT = {
  summary: "summary",
  keyFindings: [],
  sources: [],
  uncertainties: [],
  nextSteps: [],
};
const satisfiedAssessment = () => ({
  needMoreCollection: false,
  followUpQueries: [],
  coverageGaps: [],
  rationale: "sufficient",
});
function phaseOutput(label: string | undefined) {
  if (label === "frame") return FRAME_OUTPUT;
  if (label?.startsWith("collect")) return COLLECT_OUTPUT;
  if (label?.startsWith("assess")) return satisfiedAssessment();
  if (label === "synthesis") return SYNTHESIS_OUTPUT;
  return {};
}

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
          toolPolicy: options.toolPolicy,
          allowedTools: options.allowedTools,
        });
        if (options.label?.startsWith("assess")) {
          // Always request another collection pass to exercise the cap.
          return {
            needMoreCollection: true,
            followUpQueries: [{ query: `more ${options.label}`, purpose: "fill gap" }],
            coverageGaps: ["gap"],
            rationale: "more evidence needed",
          };
        }
        return phaseOutput(options.label);
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
    expect(calls.every((call) => call.toolPolicy === "readOnly")).toBe(true);
    expect(
      calls
        .filter((call) => call.label?.startsWith("collect"))
        .every(
          (call) =>
            call.allowedTools?.join(",") === "tavily_search,tavily_extract,tavily_map,tavily_crawl",
        ),
    ).toBe(true);
    expect(
      calls
        .filter((call) => !call.label?.startsWith("collect"))
        .every((call) => call.allowedTools?.length === 0),
    ).toBe(true);
    // Untrusted-input guard and high-cost escalation exclusion are present in prompts.
    expect(calls[1]!.prompt).toContain("untrusted");
    expect(calls[1]!.prompt).toContain("do not attempt high-cost research escalation");
    expect(result.result).toEqual(SYNTHESIS_OUTPUT);
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
          toolPolicy: options.toolPolicy,
          allowedTools: options.allowedTools,
        });
        if (options.label?.startsWith("assess")) {
          return satisfiedAssessment();
        }
        return phaseOutput(options.label);
      },
    });

    expect(result.agentCount).toBe(4);
    expect(calls.map((call) => call.label)).toEqual(["frame", "collect", "assess", "synthesis"]);
    expect(calls.map((call) => call.phase)).toEqual(["Frame", "Collect", "Assess", "Synthesize"]);
    expect(result.result).toEqual(SYNTHESIS_OUTPUT);
  });

  test("rejects a missing task before launching agents", async () => {
    const workflow = await loadResearchFlow();
    let agentCalls = 0;

    await expect(
      runWorkflow(workflow.script, {
        cwd: "/repo",
        args: {},
        agent: () => {
          agentCalls += 1;
          return {};
        },
      }),
    ).rejects.toThrow("non-empty `task`");
    expect(agentCalls).toBe(0);
  });

  test("deduplicates and caps sources across collection passes", async () => {
    const workflow = await loadResearchFlow();
    let collectPass = 0;
    let synthesisPrompt = "";

    await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: { task: "Bound sources", maxSources: 3 },
      agent: (prompt, options) => {
        if (options.label?.startsWith("collect")) {
          collectPass += 1;
          return {
            sources:
              collectPass === 1
                ? [
                    {
                      url: "https://example.com/a#section",
                      title: "A",
                      whyItMatters: "primary",
                      facts: ["a"],
                    },
                    {
                      url: "https://example.com/b",
                      title: "B",
                      whyItMatters: "secondary",
                      facts: ["b"],
                    },
                  ]
                : [
                    {
                      url: "https://example.com/a",
                      title: "duplicate",
                      whyItMatters: "duplicate",
                      facts: ["a"],
                    },
                    { url: "https://example.com/c", title: "C", whyItMatters: "new", facts: ["c"] },
                    { url: "https://example.com/d", title: "D", whyItMatters: "new", facts: ["d"] },
                  ],
            searchTrace: [`pass-${collectPass}`],
          };
        }
        if (options.label?.startsWith("assess")) {
          return {
            needMoreCollection: collectPass === 1,
            followUpQueries: [{ query: "more", purpose: "gap" }],
            coverageGaps: collectPass === 1 ? ["gap"] : [],
            rationale: "assessed",
          };
        }
        if (options.label === "synthesis") synthesisPrompt = prompt;
        return phaseOutput(options.label);
      },
    });

    const evidence = JSON.parse(
      synthesisPrompt.match(
        /Evidence \(objects, no parsing needed\):\n([^\n]+)\nAssessment/,
      )?.[1] ?? "null",
    );
    expect(evidence.sources.map((source: { url: string }) => source.url)).toEqual([
      "https://example.com/a#section",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  test("keeps case-sensitive path and query URLs while deduplicating host and fragment variants", async () => {
    const workflow = await loadResearchFlow();
    let synthesisPrompt = "";
    await runWorkflow(workflow.script, {
      cwd: "/repo",
      args: { task: "URL identity" },
      agent: (prompt, options) => {
        if (options.label === "collect") {
          return {
            sources: [
              {
                url: "https://EXAMPLE.com/Report#one",
                title: "upper",
                whyItMatters: "case",
                facts: [],
              },
              {
                url: "https://example.com/Report#two",
                title: "fragment duplicate",
                whyItMatters: "case",
                facts: [],
              },
              {
                url: "https://example.com/report",
                title: "lower",
                whyItMatters: "case",
                facts: [],
              },
              {
                url: "https://example.com/report?q=A",
                title: "query upper",
                whyItMatters: "case",
                facts: [],
              },
              {
                url: "https://example.com/report?q=a",
                title: "query lower",
                whyItMatters: "case",
                facts: [],
              },
              {
                url: "https://EXAMPLE.com?q=A",
                title: "host query upper",
                whyItMatters: "case",
                facts: [],
              },
              {
                url: "https://example.com?q=a",
                title: "host query lower",
                whyItMatters: "case",
                facts: [],
              },
            ],
            searchTrace: [],
          };
        }
        if (options.label === "synthesis") synthesisPrompt = prompt;
        return phaseOutput(options.label);
      },
    });
    const evidence = JSON.parse(
      synthesisPrompt.match(
        /Evidence \(objects, no parsing needed\):\n([^\n]+)\nAssessment/,
      )?.[1] ?? "null",
    );
    expect(evidence.sources.map((source: { url: string }) => source.url)).toEqual([
      "https://EXAMPLE.com/Report#one",
      "https://example.com/report",
      "https://example.com/report?q=A",
      "https://example.com/report?q=a",
      "https://EXAMPLE.com?q=A",
      "https://example.com?q=a",
    ]);
  });

  test("rejects incomplete structured phase output", async () => {
    const workflow = await loadResearchFlow();
    await expect(
      runWorkflow(workflow.script, {
        cwd: "/repo",
        args: { task: "Contract handling" },
        agent: (_prompt, options) => (options.label === "frame" ? {} : phaseOutput(options.label)),
      }),
    ).rejects.toThrow("agent frame result did not match its schema");
  });

  test("fails when a phase agent returns null instead of completing with empty research", async () => {
    const workflow = await loadResearchFlow();
    await expect(
      runWorkflow(workflow.script, {
        cwd: "/repo",
        args: { task: "Failure handling" },
        agent: (_prompt, options) => {
          if (options.label === "collect") throw new Error("collection failed");
          return phaseOutput(options.label);
        },
      }),
    ).rejects.toThrow("Collect agent failed");
  });
});
