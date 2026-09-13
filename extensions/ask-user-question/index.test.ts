import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFakePi } from "../../tests/support/fake-pi";
import extension from "./index";
import { type AskUserQuestionParams, FREE_INPUT_LABEL, type QuestionnaireResult } from "./types";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0] & { [key: string]: unknown };
const pi = createFakePi<Tool>();
extension(pi as never);
const tool = pi.tools.get("ask_user_question")!;
const params: AskUserQuestionParams = {
  questions: ["Storage?", "Deployment?"].map((question) => ({
    question,
    header: "Decision",
    options: [
      { label: "Local", description: "Works without network access." },
      { label: "Remote", description: "Shared across machines." },
    ],
  })),
};

type UI = Pick<ExtensionContext["ui"], "select" | "input">;
async function execute(ui?: Partial<UI>, signal?: AbortSignal, input: unknown = params) {
  const result = await tool.execute("call", input, signal, undefined, {
    hasUI: ui !== undefined,
    ui,
  } as ExtensionContext);
  // Providers send content to the model; details alone cannot convey an answer.
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const modelResult = JSON.parse(text) as QuestionnaireResult;
  expect(result.details).toEqual(modelResult);
  return modelResult;
}

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected UI call");
};

describe("ask_user_question standard dialog flow", () => {
  test("shows descriptions at each decision and records option and free input answers", async () => {
    let selects = 0;
    const signal = new AbortController().signal;
    const result = await execute(
      {
        select: async (title, options, opts) => {
          expect(opts?.signal).toBe(signal);
          expect(title).toContain(params.questions[selects].question);
          expect(title).toContain("1. Local\nWorks without network access.");
          expect(title).toContain("2. Remote\nShared across machines.");
          expect(options).toEqual(["1. Local", "2. Remote", `3. ${FREE_INPUT_LABEL}`]);
          return options[selects++ === 0 ? 1 : 2];
        },
        input: async (title, _placeholder, opts) => {
          expect(opts?.signal).toBe(signal);
          expect(title).toContain("Deployment?");
          return "日本語の回答";
        },
      },
      signal,
    );
    expect(result).toEqual({
      status: "completed",
      questionCount: 2,
      unansweredQuestionIndexes: [],
      answers: [
        { questionIndex: 0, question: "Storage?", kind: "option", answer: "Remote" },
        { questionIndex: 1, question: "Deployment?", kind: "custom", answer: "日本語の回答" },
      ],
    });
  });

  test("cancels selection without inventing an answer and preserves prior answers", async () => {
    let calls = 0;
    const result = await execute({
      select: async (_title, options) => (calls++ === 0 ? options[0] : undefined),
    });
    expect(result.status).toBe("cancelled");
    expect(result.answers).toHaveLength(1);
    expect(result.unansweredQuestionIndexes).toEqual([1]);
    expect(result.questionCount).toBe(2);
  });

  test.each([
    undefined,
    "",
    "  \n",
  ])("cancels empty free input (%j) without a synthetic answer", async (input) => {
    const result = await execute({
      select: async (_title, options) => options[2],
      input: async () => input,
    });
    expect(result).toMatchObject({
      status: "cancelled",
      answers: [],
      unansweredQuestionIndexes: [0, 1],
    });
  });

  test("unavailable UI is distinct from cancellation", async () => {
    expect(await execute()).toEqual({
      status: "unavailable",
      questionCount: 2,
      answers: [],
      unansweredQuestionIndexes: [0, 1],
    });
  });

  test("already aborted signal never opens UI", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await execute({ select: unexpected, input: unexpected }, controller.signal),
    ).toMatchObject({ status: "interrupted", answers: [] });
  });

  test("abort during selection ignores returned selection and preserves partial answers", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await execute(
      {
        select: async (_title, options) => {
          if (calls++ === 1) controller.abort();
          return options[0];
        },
      },
      controller.signal,
    );
    expect(result).toMatchObject({ status: "interrupted", unansweredQuestionIndexes: [1] });
    expect(result.answers).toHaveLength(1);
  });

  test.each([false, true])("abort during input ignores value or rejection (%j)", async (reject) => {
    const controller = new AbortController();
    const result = await execute(
      {
        select: async (_title, options) => options[2],
        input: async () => {
          controller.abort();
          if (reject) throw new Error("Aborted");
          return "not accepted";
        },
      },
      controller.signal,
    );
    expect(result).toMatchObject({
      status: "interrupted",
      answers: [],
      unansweredQuestionIndexes: [0, 1],
    });
  });

  test("rejects invalid RPC selections and propagates UI failures", async () => {
    await expect(execute({ select: async () => "Local" })).rejects.toThrow(
      "Invalid ask_user_question UI selection",
    );
    await expect(
      execute({
        select: async () => {
          throw new Error("RPC failed");
        },
      }),
    ).rejects.toThrow("RPC failed");
  });

  const question = params.questions[0];
  const invalidInputs = [
    null,
    {},
    { questions: [] },
    { questions: Array(5).fill(question) },
    { ...params, resume: true },
    { questions: [{ ...question, multiSelect: false }] },
    { questions: [{ ...question, unknown: "ignored?" }] },
    {
      questions: [
        { ...question, options: [{ ...question.options[0], preview: "old" }, question.options[1]] },
      ],
    },
    {
      questions: [
        { ...question, options: [{ ...question.options[0], extra: true }, question.options[1]] },
      ],
    },
    { questions: [{ ...question, header: "x".repeat(17) }] },
    { questions: [{ ...question, question: " " }] },
    {
      questions: [{ ...question, options: [{ label: "", description: "x" }, question.options[1]] }],
    },
    {
      questions: [
        {
          ...question,
          options: [{ label: "x".repeat(61), description: "x" }, question.options[1]],
        },
      ],
    },
    {
      questions: [
        { ...question, options: [{ label: "x", description: " " }, question.options[1]] },
      ],
    },
    { questions: [{ ...question, options: question.options.slice(0, 1) }] },
    { questions: [{ ...question, options: Array(5).fill(question.options[0]) }] },
    { questions: [question, { ...question, question: ` ${question.question.toUpperCase()} ` }] },
    {
      questions: [
        {
          ...question,
          options: [question.options[0], { ...question.options[1], label: " LOCAL " }],
        },
      ],
    },
  ];
  test.each(
    invalidInputs,
  )("direct execution rejects invalid and removed fields before UI: %j", async (input) => {
    await expect(
      execute({ select: unexpected, input: unexpected }, undefined, input),
    ).rejects.toThrow();
  });
});
