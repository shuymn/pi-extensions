import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { GOAL_ENTRY } from "./goal";
import compactExtension from "./index";

for (const automatic of [false, true]) {
  test(`Real Pi event ordering continues across two ${automatic ? "automatic" : "manual"} compactions and then completes`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-session-"));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, keepRecentTokens: 300 },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [compactExtension],
    });
    await loader.reload();
    const models = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(dir, "models-store.json"),
      refreshOnCreate: false,
    });
    await models.setRuntimeApiKey("anthropic", "test-only");
    const model = models.getModel("anthropic", "claude-sonnet-4-5")!;
    const manager = SessionManager.inMemory(dir);
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      modelRuntime: models,
      model,
      resourceLoader: loader,
      sessionManager: manager,
      tools: ["goal", "compact_context"],
    });
    let calls = 0;
    let summaries = 0;
    const summaryFocus: boolean[] = [];
    const compactionReasons: string[] = [];
    const errors: string[] = [];
    await session.bindExtensions({ onError: (e) => errors.push(e.error) });
    const streamResponse: Provider["streamSimple"] = (m, context) => {
      const stream = createAssistantMessageEventStream();
      const summary =
        context.systemPrompt?.includes("summar") && !context.tools?.some((t) => t.name === "goal");
      const response = {
        ...fauxAssistantMessage("Verified current work. ".repeat(200)),
        api: m.api,
        provider: m.provider,
        model: m.id,
      };
      if (summary) {
        summaries++;
        summaryFocus.push(JSON.stringify(context).includes(`checkpoint ${calls}`));
        response.content = [
          { type: "text", text: "Completed previous checkpoint. Continue remaining work." },
        ];
      } else {
        calls++;
        if (calls === 2 || calls === 4) {
          response.content = [
            {
              type: "toolCall",
              id: `compact-${calls}`,
              name: "compact_context",
              arguments: { customInstructions: `checkpoint ${calls}` },
            },
          ];
          response.stopReason = "toolUse";
          if (automatic)
            response.usage = {
              ...response.usage,
              input: m.contextWindow,
              totalTokens: m.contextWindow,
            };
        }
        if (calls === 5) {
          response.content = [
            {
              type: "toolCall",
              id: "done",
              name: "goal",
              arguments: {
                action: "complete",
                evidence: "Two checkpoint summaries and final verification",
              },
            },
          ];
          response.stopReason = "toolUse";
        }
      }
      // Pi uses millisecond timestamps to distinguish pre-compaction usage.
      setTimeout(() => {
        response.timestamp = Date.now();
        stream.push({
          type: "done",
          reason: response.stopReason as "stop" | "toolUse",
          message: response,
        });
        stream.end();
      }, 2);
      return stream;
    };
    session.agent.streamFunction = streamResponse;
    if (automatic) models.getProvider(model.provider)!.streamSimple = streamResponse;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start") compactionReasons.push(event.reason);
      if (event.type === "agent_settled" && session.isIdle) {
        const state = manager
          .getBranch()
          .filter((e) => e.type === "custom" && e.customType === GOAL_ENTRY)
          .at(-1) as any;
        if (state?.data.status === "completed" || state?.data.status === "failed") finish();
      }
    });
    try {
      await session.prompt("/goal start Check handoffs | Two checkpoints and final verification");
      await finished;
      expect(errors).toEqual([]);
      // Pi may summarize both the history and a split turn prefix.
      expect(summaries).toBeGreaterThanOrEqual(2);
      expect(calls).toBe(6);
      if (automatic) {
        expect(summaryFocus.every(Boolean)).toBe(true);
        expect(compactionReasons).toEqual(["threshold", "threshold"]);
      }
      expect(manager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(2);
      const state = manager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === GOAL_ENTRY)
        .at(-1) as any;
      expect(state.data).toMatchObject({
        status: "completed",
        continuations: 4,
        doneWhen: ["Two checkpoints and final verification"],
      });
    } finally {
      unsubscribe();
      session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}
