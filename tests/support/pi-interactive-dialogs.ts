import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

/** Only terminal I/O is fake. Input is dispatched by the real TUI to Pi's dialogs. */
class MemoryTerminal implements Terminal {
  columns = 48;
  rows = 100;
  kittyProtocolActive = false;
  onInput?: (data: string) => void;
  start(onInput: (data: string) => void) {
    this.onInput = onInput;
  }
  stop() {
    this.onInput = undefined;
  }
  async drainInput() {}
  write(_data: string) {}
  moveBy(_lines: number) {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(_title: string) {}
  setProgress(_active: boolean) {}
}

export function createPiInteractiveDialogs() {
  initTheme("dark", false);
  const terminal = new MemoryTerminal();
  const tui = new TuiMainScreen(terminal);
  const editor = new Input();
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  tui.addChild(editorContainer);
  tui.setFocus(editor);

  // Pi has no terminal-injection constructor. Initialize only the dialog host
  // fields, retaining its actual createExtensionUIContext/show/hide methods.
  // No select/input/custom implementation or component is replaced.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui,
    editor,
    editorContainer,
  }) as { createExtensionUIContext(): ExtensionUIContext };
  const ui = mode.createExtensionUIContext();
  tui.start();
  return {
    ui,
    press(key: string) {
      terminal.onInput?.(key);
    },
    screen() {
      return editorContainer.render(terminal.columns).map(Bun.stripANSI).join("\n");
    },
    isEditorRestored() {
      return editorContainer.children.length === 1 && editorContainer.children[0] === editor;
    },
    close() {
      tui.stop();
    },
  };
}
