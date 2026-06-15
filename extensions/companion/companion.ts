import { type ChildProcess, spawn } from "node:child_process";
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { getCompanionSocketPath } from "./socket-path";

const SOCK = getCompanionSocketPath();
const GLIMPSEUI_COMMAND = process.env.PI_COMPANION_GLIMPSEUI_COMMAND ?? "glimpseui";
const IDLE_EXIT_MS = 5000;
// Clients may be persistent (pi extension holds one socket) or one-shot (Claude
// Code hooks connect, send a single line, then close per event). A closed socket
// therefore no longer means "agent gone"; rows are reaped by staleness instead.
// One-shot clients cannot heartbeat during a single long-running tool call, so the
// active TTL must outlast the longest expected operation; it only exists to clear
// rows from a client that crashed without sending "done"/remove.
const ACTIVE_TTL_MS = Number(process.env.PI_COMPANION_ACTIVE_TTL_MS) || 900000;
const TERMINAL_TTL_MS = 5000;
const REAP_INTERVAL_MS = 1000;
const TERMINAL_STATUSES = new Set(["done", "error"]);

const STATUS_COLOR: Record<string, string> = {
  starting: "#22C55E",
  thinking: "#F59E0B",
  reading: "#3B82F6",
  editing: "#FACC15",
  running: "#F97316",
  searching: "#8B5CF6",
  done: "#22C55E",
  error: "#EF4444",
};

const STATUS_LABEL: Record<string, string> = {
  thinking: "Working",
  reading: "Reading",
  editing: "Editing",
  running: "Running",
  searching: "Searching",
  done: "Done",
  error: "Error",
};

type CompanionAgent = Record<string, unknown> & {
  id: string;
  status: string;
  label: string;
  dotColor: string;
  detail: string;
};

function buildHTML(eventsUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: transparent !important;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 11px;
  font-weight: 600;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  height: 100vh;
}
#pill {
  width: fit-content;
  background: rgba(0,0,0,0.45);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-radius: 8px;
  padding: 2px 0;
  transition: opacity 0.3s ease-out;
}
.row { display: flex; align-items: center; gap: 6px; padding: 4px 10px; }
.dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
.project { color: rgba(255,255,255,0.95); font-weight: 500; flex-shrink: 0; }
.sep { color: rgba(255,255,255,0.5); flex-shrink: 0; }
.status { color: rgba(255,255,255,0.9); flex-shrink: 0; }
.detail {
  color: rgba(255,255,255,0.75);
  font-family: ui-monospace, 'SF Mono', monospace;
  font-size: 10px;
  white-space: nowrap;
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 4px 21px;
  font-size: 10px;
  font-weight: 500;
  color: rgba(255,255,255,0.85);
  font-family: ui-monospace, 'SF Mono', monospace;
}
.meta-sep { margin: 0 2px; }
</style>
</head>
<body>
<div id="pill"></div>
<script>
const source = new EventSource(${JSON.stringify(eventsUrl)});
const rows = {};
const startTimes = {};
const frozenElapsed = {};
let tickTimer = null;

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtElapsed(ms) {
  let s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  s = s % 60;
  return m + "m " + (s < 10 ? "0" : "") + s + "s";
}

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    const ids = Object.keys(rows);
    if (ids.length === 0) {
      clearInterval(tickTimer);
      tickTimer = null;
      return;
    }
    for (const id of ids) {
      if (frozenElapsed[id]) continue;
      const el = document.getElementById("elapsed-" + id);
      if (el && startTimes[id]) el.textContent = fmtElapsed(Date.now() - startTimes[id]);
    }
  }, 1000);
}

function update(data) {
  const id = data.id;
  if (!startTimes[id]) startTimes[id] = Date.now();
  if (data.status === "done" && startTimes[id] && !frozenElapsed[id]) {
    frozenElapsed[id] = fmtElapsed(Date.now() - startTimes[id]);
  }
  rows[id] = data;
  render();
  startTick();
}

function remove(id) {
  delete rows[id];
  delete startTimes[id];
  delete frozenElapsed[id];
  render();
}

function render() {
  const pill = document.getElementById("pill");
  const ids = Object.keys(rows);
  if (ids.length === 0) {
    pill.style.opacity = "0";
    setTimeout(() => { pill.innerHTML = ""; }, 350);
    return;
  }

  pill.style.opacity = "1";
  let html = "";
  for (const id of ids) {
    const row = rows[id];
    const frozen = frozenElapsed[id];
    const elapsed = frozen || (startTimes[id] ? fmtElapsed(Date.now() - startTimes[id]) : "");
    html += '<div id="r-' + esc(id) + '">';
    html += '<div class="row">';
    html += '<div class="dot" style="background:' + esc(row.dotColor || "#6B7280") + '"></div>';
    html += '<span class="project">' + esc(row.project || "pi") + '</span>';
    if (row.label) html += '<span class="sep">·</span><span class="status">' + esc(row.label) + '</span>';
    if (row.detail) html += '<span class="detail">' + esc(row.detail) + '</span>';
    html += '</div><div class="meta">';
    if (row.contextPercent != null) html += '<span>' + esc(row.contextPercent) + '%</span><span class="meta-sep">·</span>';
    html += '<span id="elapsed-' + esc(id) + '"' + (frozen ? ' style="font-weight:700"' : "") + '>' + esc(elapsed) + '</span>';
    html += '</div></div>';
  }
  pill.innerHTML = html;
}

source.addEventListener("status", (event) => update(JSON.parse(event.data)));
source.addEventListener("remove", (event) => remove(JSON.parse(event.data).id));
</script>
</body>
</html>`;
}

function safeUnlinkSocket(): void {
  try {
    const stat = lstatSync(SOCK);
    if (stat.isSocket()) unlinkSync(SOCK);
  } catch {}
}

function truncate(value: unknown, max = 60): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const agents = new Map<string, CompanionAgent>();
const lastSeen = new Map<string, number>();
const sockets = new Set<Socket>();
const eventClients = new Set<ServerResponse>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let reapTimer: ReturnType<typeof setInterval> | undefined;
let child: ChildProcess | undefined;

function writeEvent(client: ServerResponse, event: string, data: unknown): void {
  client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown): void {
  for (const client of eventClients) writeEvent(client, event, data);
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (agents.size === 0 && sockets.size === 0) {
      cleanup();
      process.exit(0);
    }
  }, IDLE_EXIT_MS);
}

function removeAgent(id: string): void {
  agents.delete(id);
  lastSeen.delete(id);
  broadcast("remove", { id });
  resetIdleTimer();
}

function reapStaleAgents(): void {
  const now = Date.now();
  for (const [id, agent] of agents) {
    const seenAt = lastSeen.get(id);
    const ttl = TERMINAL_STATUSES.has(agent.status) ? TERMINAL_TTL_MS : ACTIVE_TTL_MS;
    if (seenAt === undefined || now - seenAt >= ttl) removeAgent(id);
  }
}

const httpServer = createHttpServer((req, res) => {
  if (req.url !== "/events") {
    res.writeHead(404);
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("\n");
  eventClients.add(res);
  for (const agent of agents.values()) writeEvent(res, "status", agent);
  req.on("close", () => {
    eventClients.delete(res);
    resetIdleTimer();
  });
});

mkdirSync(dirname(SOCK), { recursive: true, mode: 0o700 });
safeUnlinkSocket();

const socketServer = createServer((socket) => {
  sockets.add(socket);
  const rl = createInterface({ input: socket, crlfDelay: Infinity });

  rl.on("line", (line) => {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg.id !== "string") return;
      const clientId = msg.id;

      if (msg.type === "remove") {
        removeAgent(clientId);
        return;
      }

      const status = String(msg.status ?? "running");
      const agent: CompanionAgent = {
        ...msg,
        id: clientId,
        status,
        label: STATUS_LABEL[status] ?? "",
        dotColor: STATUS_COLOR[status] ?? "#6B7280",
        detail: truncate(msg.detail),
      };
      agents.set(clientId, agent);
      lastSeen.set(clientId, Date.now());
      broadcast("status", agent);
      resetIdleTimer();
    } catch {}
  });

  socket.on("close", () => {
    sockets.delete(socket);
    resetIdleTimer();
  });
  socket.on("error", () => {});
});

function exitOnServerError(): void {
  cleanup();
  process.exit(1);
}

httpServer.on("error", exitOnServerError);
socketServer.on("error", exitOnServerError);

httpServer.listen(0, "127.0.0.1", () => {
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Failed to bind companion HTTP server");
  const eventsUrl = `http://127.0.0.1:${address.port}/events`;
  child = spawn(
    GLIMPSEUI_COMMAND,
    [
      "--width",
      "630",
      "--height",
      "100",
      "--frameless",
      "--floating",
      "--transparent",
      "--click-through",
      "--follow-cursor",
      "--follow-mode",
      "spring",
      "--cursor-anchor",
      "top-right",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  child.stdin?.end(buildHTML(eventsUrl));
  child.on("exit", () => {
    cleanup();
    process.exit(0);
  });
  child.on("error", () => {
    cleanup();
    process.exit(1);
  });
});

socketServer.listen(SOCK);

reapTimer = setInterval(reapStaleAgents, REAP_INTERVAL_MS);
reapTimer.unref?.();

let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (idleTimer) clearTimeout(idleTimer);
  if (reapTimer) clearInterval(reapTimer);
  try {
    socketServer.close();
  } catch {}
  try {
    httpServer.close();
  } catch {}
  for (const client of eventClients) client.end();
  safeUnlinkSocket();
  if (child && !child.killed) child.kill();
}

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);
