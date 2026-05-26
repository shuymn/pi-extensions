import { describe, expect, test } from "bun:test";

import { createFakeUi } from "../tests/support/fake-ui";

const ESC = String.fromCharCode(0x1b);

async function loadTuiLib() {
  return await import("./tui");
}

describe("tui helpers", () => {
  test("printableInput accepts bracketed paste and filters control chars", async () => {
    const { printableInput } = await loadTuiLib();

    expect(printableInput("abc")).toBe("abc");
    expect(printableInput(`${ESC}[A`)).toBeNull();
    expect(printableInput(`${ESC}[200~hello\nworld${ESC}[201~`)).toBe("helloworld");
  });

  test("notifyIfUI delivers only when a UI is attached", async () => {
    const { notifyIfUI } = await loadTuiLib();
    const calls: Array<{ message: string; level?: string }> = [];
    const ctx = (hasUI?: boolean) => ({
      hasUI,
      ui: {
        notify(message: string, level?: string) {
          calls.push({ message, level });
        },
      },
    });

    expect(notifyIfUI(ctx(true), "hi")).toBe(true);
    expect(notifyIfUI(ctx(undefined), "default", "warning")).toBe(true);
    expect(notifyIfUI(ctx(false), "skip")).toBe(false);
    expect(calls).toEqual([
      { message: "hi", level: "info" },
      { message: "default", level: "warning" },
    ]);
  });

  test("widget helpers set aboveEditor lines and clear them", async () => {
    const { setAboveEditorWidget, clearWidget } = await loadTuiLib();
    const ui = createFakeUi();
    const ctx = { ui };

    setAboveEditorWidget(ctx, "top", ["status"]);
    clearWidget(ctx, "top");
    expect(ui.widgets).toEqual([
      {
        key: "top",
        lines: ["status"],
        options: { placement: "aboveEditor" },
      },
      { key: "top", lines: undefined, options: undefined },
    ]);
  });
});
