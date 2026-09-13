import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AskUserQuestionParams } from "../../extensions/ask-user-question/types";

type RpcEvent = {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  options?: string[];
  message?: string;
  success?: boolean;
  error?: string;
};

export async function createPiRpcQuestion() {
  const directory = await mkdtemp(join(tmpdir(), "pi-question-rpc-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  const fixture = join(directory, "fixture.ts");
  // The command replaces only LLM tool selection: actual extension registration,
  // execute(), command context, RPC dialog transport and responses are retained.
  await writeFile(
    fixture,
    `
import ask from ${JSON.stringify(resolve("extensions/ask-user-question/index.ts"))};
export default function(pi) {
  let tool;
  let controller;
  ask(new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return definition => {
      tool = definition;
      target.registerTool(definition);
    };
    return Reflect.get(target, key);
  }}));
  pi.registerCommand("integration-ask", { handler: async (args, ctx) => {
    controller = new AbortController();
    const result = await tool.execute("integration", JSON.parse(args), controller.signal, undefined, ctx);
    ctx.ui.notify("integration-result:" + JSON.stringify({ mode: ctx.mode, hasUI: ctx.hasUI, result }));
  }});
  pi.registerCommand("integration-abort", { handler: async () => { controller.abort(); }});
}
`,
  );
  const child = spawn(
    process.execPath,
    [
      join(
        dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
        "cli.js",
      ),
      "--mode",
      "rpc",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-builtin-tools",
      "-e",
      fixture,
    ],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffer = "";
  let stderr = "";
  const events: RpcEvent[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trimEnd();
      buffer = buffer.slice(newline + 1);
      if (line) events.push(JSON.parse(line) as RpcEvent);
      newline = buffer.indexOf("\n");
    }
  });
  function send(command: object) {
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }
  async function next(predicate: (event: RpcEvent) => boolean): Promise<RpcEvent> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const index = events.findIndex(predicate);
      if (index !== -1) return events.splice(index, 1)[0];
      const failure = events.find(
        (event) => event.type === "extension_error" || event.success === false,
      );
      if (failure || child.exitCode !== null)
        throw new Error(`Pi RPC failed: ${JSON.stringify(failure)} ${stderr}`);
      await Bun.sleep(5);
    }
    throw new Error(`Pi RPC timeout: ${JSON.stringify(events)} ${stderr}`);
  }
  return {
    send,
    ask(params: AskUserQuestionParams) {
      send({ type: "prompt", message: `/integration-ask ${JSON.stringify(params)}` });
    },
    dialog() {
      return next(
        (event) =>
          event.type === "extension_ui_request" && ["select", "input"].includes(event.method ?? ""),
      );
    },
    async result() {
      const event = await next(
        (event) => event.method === "notify" && !!event.message?.startsWith("integration-result:"),
      );
      return JSON.parse(event.message?.slice("integration-result:".length) ?? "null");
    },
    async close() {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) resolveExit();
        else child.once("exit", () => resolveExit());
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}
