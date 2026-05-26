import { truncateToWidth } from "@earendil-works/pi-tui";

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

export type NotifyLevel = "info" | "warning" | "error";

type NotifyContext = {
  hasUI?: boolean;
  ui: { notify(message: string, type?: NotifyLevel): void };
};

export type WidgetContext = {
  ui: {
    setWidget(
      key: string,
      content: string[] | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
};

/**
 * Notify only when a UI is attached. UI-only extensions can call this without
 * guarding on `ctx.hasUI` themselves; headless runs become a no-op.
 * Returns whether the notification was delivered.
 */
export function notifyIfUI(
  ctx: NotifyContext,
  message: string,
  level: NotifyLevel = "info",
): boolean {
  if (ctx.hasUI === false) return false;
  ctx.ui.notify(message, level);
  return true;
}

/** Set an aboveEditor widget for prominent status/progress. */
export function setAboveEditorWidget(ctx: WidgetContext, key: string, lines: string[]): void {
  ctx.ui.setWidget(key, lines, { placement: "aboveEditor" });
}

/** Clear a previously set widget. */
export function clearWidget(ctx: WidgetContext, key: string): void {
  ctx.ui.setWidget(key, undefined);
}

const ESCAPE = String.fromCharCode(0x1b);
const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE}[201~`;

export function printableInput(data: string): string | null {
  const isBracketedPaste =
    data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END);
  const raw = isBracketedPaste
    ? data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)
    : data;
  if (!isBracketedPaste && raw.includes(ESCAPE)) return null;

  const text = [...raw]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return !(code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f));
    })
    .join("");
  return text || null;
}

export function truncateLines(lines: string[], width: number): string[] {
  return lines.map((line) => truncateToWidth(line, width, ""));
}

export function accentBorder(theme: ThemeLike, width: number): string {
  return theme.fg("accent", "─".repeat(Math.max(0, width)));
}
