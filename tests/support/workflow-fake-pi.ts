import { createCustomDriver, type CustomAction } from "./tui-mocks";

export type ExecCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};
export type ExecResult = { code: number; stdout: string; stderr: string };
export type EventHandler = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

export function createWorkflowPi(
  execHandler: (call: ExecCall) => ExecResult | Promise<ExecResult>,
) {
  const flags = new Map<string, unknown>();
  const events = new Map<string, EventHandler[]>();
  const registeredFlags: Array<{ name: string; definition: unknown }> = [];
  const execCalls: ExecCall[] = [];
  const sentUserMessages: string[] = [];
  const activeToolSets: string[][] = [];
  let activeTools = ["read", "bash", "edit", "write", "todo"];
  const registeredTools: Array<{ name: string; [key: string]: unknown }> = [];

  return {
    flags,
    events,
    registeredFlags,
    execCalls,
    sentUserMessages,
    registerFlag(name: string, definition: unknown) {
      registeredFlags.push({ name, definition });
    },
    registerTool(definition: { name: string; [key: string]: unknown }) {
      registeredTools.push(definition);
    },
    on(eventName: string, handler: EventHandler) {
      events.set(eventName, [...(events.get(eventName) ?? []), handler]);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    async exec(command: string, args: string[], options: Record<string, unknown> = {}) {
      const call = { command, args, options };
      execCalls.push(call);
      return execHandler(call);
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
      activeToolSets.push([...tools]);
    },
    activeToolSets,
    registeredTools,
  };
}

export function createWorkflowContext(
  tuiInstances: ReturnType<typeof import("./tui-mocks").installTuiMocks>,
  actions: CustomAction[],
  options: { idle?: boolean; hasUI?: boolean } = {},
) {
  const notifications: Array<{ message: string; level: string }> = [];
  let shutdownCount = 0;

  return {
    notifications,
    get shutdownCount() {
      return shutdownCount;
    },
    hasUI: options.hasUI ?? true,
    isIdle: () => options.idle ?? true,
    shutdown: () => {
      shutdownCount += 1;
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: createCustomDriver(actions, tuiInstances),
    },
  };
}
