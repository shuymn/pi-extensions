import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notifyIfUI } from "../../lib/tui";

const TOOL_NAME = "agmsg_pi";
const COMMAND_NAME = "agmsg";
const STORE_DIR = "agmsg-pi";
const IDENTITIES_FILE = "identities.json";
const MESSAGES_FILE = "messages.jsonl";
const MAX_HISTORY_LIMIT = 100;
const AUTO_POLL_INTERVAL_MS = 5_000;

const ACTIONS = ["join", "send", "inbox", "team", "history", "whoami"] as const;
type Action = (typeof ACTIONS)[number];

type Identity = {
  team: string;
  agent: string;
  project: string;
  updatedAt: string;
};

type Message = {
  id: string;
  team: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  readAt?: string;
  deliveryClaim?: string;
};

type DeliveryGuard = () => boolean;

type AgmsgPiParams = {
  action: Action;
  team?: string;
  agent?: string;
  to?: string;
  message?: string;
  limit?: number;
};

type RuntimeIdentity = {
  cwd: string;
  sessionFile?: string | null;
};

type StorePaths = {
  dir: string;
  identities: string;
  messages: string;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

type ContextLike = {
  cwd: string;
  sessionManager?: { getSessionFile?: () => string | null | undefined };
  isIdle?: () => boolean;
};

type SendUserMessageAPI = {
  sendUserMessage: (content: string, options?: { deliverAs?: "followUp" }) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function createMessageId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function normalizeName(value: string | undefined, field: string): string {
  const name = value?.trim();
  if (!name) throw new Error(`${field} is required.`);
  if (name.includes("\n") || name.includes("\r")) {
    throw new Error(`${field} must be a single line.`);
  }
  return name;
}

function normalizeMessage(value: string | undefined): string {
  const message = value?.trim();
  if (!message) throw new Error("message is required.");
  return message;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(Math.floor(limit), MAX_HISTORY_LIMIT);
}

function runtimeFromContext(ctx: ContextLike): RuntimeIdentity {
  return {
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
  };
}

function identityKey(runtime: RuntimeIdentity): string {
  return runtime.sessionFile || resolve(runtime.cwd);
}

function storePaths(): StorePaths {
  const dir = join(getAgentDir(), STORE_DIR);
  return {
    dir,
    identities: join(dir, IDENTITIES_FILE),
    messages: join(dir, MESSAGES_FILE),
  };
}

function ensureStore(paths = storePaths()): void {
  mkdirSync(paths.dir, { recursive: true });
  if (!existsSync(paths.identities)) writeFileSync(paths.identities, "{}\n", "utf8");
  if (!existsSync(paths.messages)) writeFileSync(paths.messages, "", "utf8");
}

function readIdentities(paths = storePaths()): Record<string, Identity> {
  ensureStore(paths);
  try {
    const parsed = JSON.parse(readFileSync(paths.identities, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, Identity>)
      : {};
  } catch {
    return {};
  }
}

function writeIdentities(identities: Record<string, Identity>, paths = storePaths()): void {
  ensureStore(paths);
  writeFileSync(paths.identities, `${JSON.stringify(identities, null, 2)}\n`, "utf8");
}

function readMessages(paths = storePaths()): Message[] {
  ensureStore(paths);
  const raw = readFileSync(paths.messages, "utf8").trim();
  if (!raw) return [];

  const messages: Message[] = [];
  for (const line of raw.split("\n")) {
    try {
      const parsed = JSON.parse(line) as Message;
      if (
        parsed &&
        typeof parsed.id === "string" &&
        typeof parsed.team === "string" &&
        typeof parsed.from === "string" &&
        typeof parsed.to === "string" &&
        typeof parsed.body === "string" &&
        typeof parsed.createdAt === "string"
      ) {
        messages.push(parsed);
      }
    } catch {
      // Ignore malformed lines so one bad record does not break messaging.
    }
  }
  return messages;
}

function writeMessages(messages: Message[], paths = storePaths()): void {
  ensureStore(paths);
  const data = messages.map((message) => JSON.stringify(message)).join("\n");
  writeFileSync(paths.messages, data ? `${data}\n` : "", "utf8");
}

function formatIdentity(identity: Identity | undefined): string {
  if (!identity) return "Not joined. Run join with team and agent.";
  return `You are ${identity.agent} in team ${identity.team}.`;
}

function formatMessages(title: string, messages: Message[]): string {
  if (messages.length === 0) return `${title}\nNo messages.`;
  return [
    title,
    ...messages.map(
      (message) =>
        `[${message.createdAt}] ${message.from} -> ${message.to}: ${message.body}${message.readAt ? "" : " (unread)"}`,
    ),
  ].join("\n");
}

function membersForTeam(team: string, identities: Record<string, Identity>): Identity[] {
  return Object.values(identities)
    .filter((identity) => identity.team === team)
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.project.localeCompare(b.project));
}

function requireIdentity(runtime: RuntimeIdentity, identities = readIdentities()): Identity {
  const identity = identities[identityKey(runtime)];
  if (!identity) throw new Error("This pi session has not joined agmsg-pi yet. Run join first.");
  return identity;
}

async function mutateIdentities<T>(run: (identities: Record<string, Identity>) => T): Promise<T> {
  const paths = storePaths();
  ensureStore(paths);
  return withFileMutationQueue(paths.identities, async () => {
    const identities = readIdentities(paths);
    const result = run(identities);
    writeIdentities(identities, paths);
    return result;
  });
}

async function mutateMessages<T>(run: (messages: Message[]) => T): Promise<T> {
  const paths = storePaths();
  ensureStore(paths);
  return withFileMutationQueue(paths.messages, async () => {
    const messages = readMessages(paths);
    const result = run(messages);
    writeMessages(messages, paths);
    return result;
  });
}

async function runAgmsgPi(runtime: RuntimeIdentity, params: AgmsgPiParams): Promise<ToolResult> {
  const paths = storePaths();
  ensureStore(paths);

  switch (params.action) {
    case "join": {
      const team = normalizeName(params.team, "team");
      const agent = normalizeName(params.agent, "agent");
      const identity: Identity = {
        team,
        agent,
        project: resolve(runtime.cwd),
        updatedAt: nowIso(),
      };
      await mutateIdentities((identities) => {
        identities[identityKey(runtime)] = identity;
      });
      return {
        content: [{ type: "text", text: `Joined team ${team} as ${agent}.` }],
        details: { identity },
      };
    }
    case "whoami": {
      const identity = readIdentities(paths)[identityKey(runtime)];
      return {
        content: [{ type: "text", text: formatIdentity(identity) }],
        details: { identity },
      };
    }
    case "team": {
      const identities = readIdentities(paths);
      const team = params.team?.trim() || requireIdentity(runtime, identities).team;
      const members = membersForTeam(team, identities);
      const text =
        members.length === 0
          ? `Team ${team} has no members.`
          : [
              `Team ${team}:`,
              ...members.map((member) => `- ${member.agent}: ${member.project}`),
            ].join("\n");
      return { content: [{ type: "text", text }], details: { team, members } };
    }
    case "send": {
      const identity = requireIdentity(runtime);
      const to = normalizeName(params.to, "to");
      const body = normalizeMessage(params.message);
      const message: Message = {
        id: createMessageId(),
        team: identity.team,
        from: identity.agent,
        to,
        body,
        createdAt: nowIso(),
      };
      await mutateMessages((messages) => messages.push(message));
      return {
        content: [{ type: "text", text: `Sent to ${to} in team ${identity.team}.` }],
        details: { message },
      };
    }
    case "inbox": {
      const identity = requireIdentity(runtime);
      const unread = await mutateMessages((messages) => {
        const selected = messages.filter(
          (message) =>
            message.team === identity.team && message.to === identity.agent && !message.readAt,
        );
        const readAt = nowIso();
        for (const message of selected) {
          message.readAt = readAt;
          delete message.deliveryClaim;
        }
        return selected.map((message) => ({ ...message }));
      });
      return {
        content: [{ type: "text", text: formatMessages("Inbox:", unread) }],
        details: { messages: unread },
      };
    }
    case "history": {
      const identity = requireIdentity(runtime);
      const limit = clampLimit(params.limit);
      const messages = readMessages(paths)
        .filter(
          (message) =>
            message.team === identity.team &&
            (message.from === identity.agent || message.to === identity.agent),
        )
        .slice(-limit);
      return {
        content: [
          { type: "text", text: formatMessages(`History (${messages.length}):`, messages) },
        ],
        details: { messages, limit },
      };
    }
  }
}

async function runCommand(args: string, runtime: RuntimeIdentity): Promise<ToolResult> {
  const [action = "inbox", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (action === "join") {
    return runAgmsgPi(runtime, { action, team: rest[0], agent: rest[1] });
  }
  if (action === "send") {
    return runAgmsgPi(runtime, { action, to: rest[0], message: rest.slice(1).join(" ") });
  }
  if (action === "team") return runAgmsgPi(runtime, { action, team: rest[0] });
  if (action === "history")
    return runAgmsgPi(runtime, { action, limit: Number(rest[0]) || undefined });
  if (action === "whoami") return runAgmsgPi(runtime, { action });
  if (action === "inbox") return runAgmsgPi(runtime, { action });
  throw new Error(`Unknown agmsg command: ${action}`);
}

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function formatAutoDelivery(messages: Message[]): string {
  return [
    "agmsg-pi received message(s). Act on them now, then reply or send agmsg_pi messages as needed.",
    "",
    ...messages.map((message) => `From ${message.from} at ${message.createdAt}:\n${message.body}`),
  ].join("\n");
}

async function claimUnreadMessages(runtime: RuntimeIdentity, claim: string): Promise<Message[]> {
  const identity = requireIdentity(runtime);
  return mutateMessages((messages) => {
    const selected = messages.filter(
      (message) =>
        message.team === identity.team &&
        message.to === identity.agent &&
        !message.readAt &&
        !message.deliveryClaim,
    );
    for (const message of selected) message.deliveryClaim = claim;
    return selected.map((message) => ({ ...message }));
  });
}

async function finishClaimedMessages(messageIds: string[], claim: string): Promise<void> {
  if (messageIds.length === 0) return;
  const ids = new Set(messageIds);
  await mutateMessages((messages) => {
    const readAt = nowIso();
    for (const message of messages) {
      if (!ids.has(message.id) || message.deliveryClaim !== claim) continue;
      message.readAt = readAt;
      delete message.deliveryClaim;
    }
  });
}

async function releaseClaimedMessages(messageIds: string[], claim: string): Promise<void> {
  if (messageIds.length === 0) return;
  const ids = new Set(messageIds);
  await mutateMessages((messages) => {
    for (const message of messages) {
      if (ids.has(message.id) && message.deliveryClaim === claim) delete message.deliveryClaim;
    }
  });
}

async function deliverUnreadMessages(
  pi: SendUserMessageAPI,
  runtime: RuntimeIdentity,
  shouldDeliver: DeliveryGuard = () => true,
): Promise<Message[]> {
  if (!shouldDeliver()) return [];
  const claim = crypto.randomUUID();
  const messages = await claimUnreadMessages(runtime, claim);
  const messageIds = messages.map((message) => message.id);
  if (messages.length === 0) return [];
  if (!shouldDeliver()) {
    await releaseClaimedMessages(messageIds, claim);
    return [];
  }
  try {
    pi.sendUserMessage(formatAutoDelivery(messages), { deliverAs: "followUp" });
    await finishClaimedMessages(messageIds, claim);
    return messages;
  } catch (error) {
    await releaseClaimedMessages(messageIds, claim);
    throw error;
  }
}

export default function agmsgPiExtension(pi: ExtensionAPI): void {
  let autoPollTimer: ReturnType<typeof setInterval> | undefined;
  let autoPollRunning = false;
  let autoPollGeneration = 0;
  let currentContext: ContextLike | undefined;

  function stopAutoPoll(): void {
    autoPollGeneration += 1;
    if (!autoPollTimer) return;
    clearInterval(autoPollTimer);
    autoPollTimer = undefined;
  }

  function startAutoPoll(ctx: ContextLike): void {
    stopAutoPoll();
    currentContext = ctx;
    const generation = autoPollGeneration;
    const shouldDeliver = () => currentContext === ctx && autoPollGeneration === generation;
    const poll = async () => {
      if (!shouldDeliver()) return;
      if (autoPollRunning) return;
      if (ctx.isIdle && !ctx.isIdle()) return;
      autoPollRunning = true;
      try {
        await deliverUnreadMessages(pi, runtimeFromContext(ctx), shouldDeliver);
      } catch {
        // Not joined yet or storage unavailable. Keep polling; explicit commands report errors.
      } finally {
        autoPollRunning = false;
      }
    };
    autoPollTimer = setInterval(() => void poll(), AUTO_POLL_INTERVAL_MS);
    void poll();
  }

  pi.on("session_start", async (_event, ctx) => startAutoPoll(ctx));
  pi.on("session_shutdown", async () => {
    stopAutoPoll();
    currentContext = undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "agmsg-pi",
    description: "Send and receive local messages between pi sessions in the same team.",
    promptSnippet: "Send and receive local messages between pi sessions in the same team.",
    promptGuidelines: [
      "Use agmsg_pi when the user asks to join a messaging team, send a message to another pi agent, check inbox, list team members, or show message history.",
      "If agmsg_pi reports that the pi session is not joined, ask the user for a team name and agent name before sending messages.",
      "Keep agmsg_pi messages concise and include enough context for another pi session to act without reading this session.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS, { description: "Messaging action to perform." }),
      team: Type.Optional(Type.String({ description: "Team name. Required for join." })),
      agent: Type.Optional(
        Type.String({ description: "This pi session's agent name. Required for join." }),
      ),
      to: Type.Optional(Type.String({ description: "Recipient agent name. Required for send." })),
      message: Type.Optional(Type.String({ description: "Message body. Required for send." })),
      limit: Type.Optional(Type.Number({ description: "Maximum history messages to show." })),
    }),
    async execute(_toolCallId, params: AgmsgPiParams, _signal, _onUpdate, ctx) {
      try {
        const result = await runAgmsgPi(runtimeFromContext(ctx), params);
        if (params.action === "join") startAutoPoll(ctx);
        return result;
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "pi 同士のローカルメッセージを確認・送信する",
    handler: async (args, ctx) => {
      try {
        const result = await runCommand(args, runtimeFromContext(ctx));
        if (args.trim().startsWith("join")) startAutoPoll(ctx);
        notifyIfUI(ctx, resultText(result), "info");
      } catch (error) {
        notifyIfUI(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

export const agmsgPiTestInternals = {
  ACTIONS,
  clampLimit,
  deliverUnreadMessages,
  formatAutoDelivery,
  formatMessages,
  identityKey,
  readIdentities,
  readMessages,
  runAgmsgPi,
  storePaths,
};
