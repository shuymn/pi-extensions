import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import askUserQuestion from "../extensions/ask-user-question";
import {
  type AskUserQuestionParams,
  FREE_INPUT_LABEL,
} from "../extensions/ask-user-question/types";
import { createPiInteractiveDialogs } from "./support/pi-interactive-dialogs";
import { createPiRpcQuestion } from "./support/pi-rpc-question";

const params: AskUserQuestionParams = {
  questions: [
    {
      header: "Storage",
      question: "Which storage should keep the project data?",
      options: [
        {
          label: "Local",
          description:
            "Keep the data on this machine without synchronizing it to any remote service. Local-description-end.",
        },
        {
          label: "Remote",
          description:
            "Synchronize the data between machines and require a network connection for updates. Remote-description-end.",
        },
      ],
    },
    {
      header: "Name",
      question: "Which name should appear in the report?",
      options: [
        { label: "Short", description: "Use the short project name." },
        { label: "Full", description: "Use the full project name." },
      ],
    },
  ],
};

function captureTool() {
  let tool: ToolDefinition | undefined;
  askUserQuestion({
    registerTool(definition) {
      tool = definition;
    },
  } as ExtensionAPI);
  if (!tool) throw new Error("ask_user_question was not registered");
  return tool;
}
const flush = async () => {
  await Bun.sleep(0);
};
const expectedOption = {
  questionIndex: 0,
  question: params.questions[0].question,
  kind: "option",
  answer: "Local",
};
const expectedCustom = {
  questionIndex: 1,
  question: params.questions[1].question,
  kind: "custom",
  answer: "私の report",
};

function expectDescriptions(text: string) {
  // Ignore wrapping whitespace, not missing words or truncation. Assert both
  // complete descriptions before any choice is committed, at 48 columns.
  const compact = (value: string) => value.replace(/\s/g, "");
  for (const option of params.questions[0].options)
    expect(compact(text)).toContain(compact(option.description));
}

describe("ask_user_question through Pi InteractiveMode standard dialogs", () => {
  test("When choices and free text are entered, Pi shall show full descriptions and return the actual answers", async () => {
    const host = createPiInteractiveDialogs();
    try {
      const result = captureTool().execute("tui", params, undefined, undefined, {
        mode: "tui",
        hasUI: true,
        ui: host.ui,
      } as ExtensionContext);
      expectDescriptions(host.screen());
      expect(host.screen()).toContain("Local");
      host.press("\r");
      await flush();
      expect(host.screen()).toContain(params.questions[1].question);
      host.press("\x1b[B");
      host.press("\x1b[B");
      host.press("\r");
      await flush();
      for (const character of expectedCustom.answer) host.press(character);
      host.press("\r");
      expect((await result).details).toEqual({
        status: "completed",
        answers: [expectedOption, expectedCustom],
        questionCount: 2,
        unansweredQuestionIndexes: [],
      });
      expect(host.isEditorRestored()).toBe(true);
    } finally {
      host.close();
    }
  });

  for (const termination of ["escape", "abort"] as const) {
    test(`When ${termination} occurs during free input, Pi shall preserve only earlier answers and restore the editor`, async () => {
      const host = createPiInteractiveDialogs();
      const controller = new AbortController();
      try {
        const result = captureTool().execute("tui", params, controller.signal, undefined, {
          mode: "tui",
          hasUI: true,
          ui: host.ui,
        } as ExtensionContext);
        host.press("\r");
        await flush();
        host.press("\x1b[B");
        host.press("\x1b[B");
        host.press("\r");
        await flush();
        host.press("draft");
        if (termination === "abort") controller.abort();
        else host.press("\x1b");
        expect((await result).details).toEqual({
          status: termination === "abort" ? "interrupted" : "cancelled",
          answers: [expectedOption],
          questionCount: 2,
          unansweredQuestionIndexes: [1],
        });
        expect(host.isEditorRestored()).toBe(true);
      } finally {
        controller.abort();
        host.close();
      }
    });
  }
});

describe("ask_user_question through a real Pi RPC subprocess", () => {
  test("When the RPC client selects and enters text, Pi shall use standard dialogs and return actual answers", async () => {
    const rpc = await createPiRpcQuestion();
    try {
      rpc.ask(params);
      const first = await rpc.dialog();
      expect(first.method).toBe("select");
      expectDescriptions(first.title ?? "");
      expect(first.options).toEqual(["1. Local", "2. Remote", `3. ${FREE_INPUT_LABEL}`]);
      rpc.send({ type: "extension_ui_response", id: first.id, value: first.options?.[0] });
      const second = await rpc.dialog();
      expect(second.title).toContain(params.questions[1].question);
      rpc.send({ type: "extension_ui_response", id: second.id, value: second.options?.[2] });
      const input = await rpc.dialog();
      expect(input.method).toBe("input");
      rpc.send({ type: "extension_ui_response", id: input.id, value: expectedCustom.answer });
      expect(await rpc.result()).toMatchObject({
        mode: "rpc",
        hasUI: true,
        result: {
          details: {
            status: "completed",
            answers: [expectedOption, expectedCustom],
            unansweredQuestionIndexes: [],
          },
        },
      });
    } finally {
      await rpc.close();
    }
  }, 30_000);

  for (const termination of ["cancel", "abort"] as const) {
    test(`When ${termination} occurs in an RPC dialog, Pi shall preserve the partial result`, async () => {
      const rpc = await createPiRpcQuestion();
      try {
        rpc.ask(params);
        const first = await rpc.dialog();
        rpc.send({ type: "extension_ui_response", id: first.id, value: first.options?.[0] });
        const second = await rpc.dialog();
        if (termination === "cancel")
          rpc.send({ type: "extension_ui_response", id: second.id, cancelled: true });
        // Idle extension commands do not receive the agent turn's abort signal.
        // Trigger the fixture's tool signal, which the real RPC UI must observe.
        else rpc.send({ type: "prompt", message: "/integration-abort" });
        expect((await rpc.result()).result.details).toEqual({
          status: termination === "abort" ? "interrupted" : "cancelled",
          answers: [expectedOption],
          questionCount: 2,
          unansweredQuestionIndexes: [1],
        });
      } finally {
        await rpc.close();
      }
    }, 30_000);
  }
});
