import { createServer, type IncomingMessage, type ServerResponse } from "http";

import type { StreamEvent } from "./runtime.js";
import type { Attachment } from "./interfaces/types.js";
import { log } from "./log.js";

export interface ServerEvent extends StreamEvent {
  // Extends StreamEvent with cross-channel messages
  fromInterface?: string;
  fromUserId?: string;
  fromChannel?: string;
  fromClientId?: string;
  command?: string;
}

type SSEClient = {
  id: string;
  res: ServerResponse;
};

export class AgentServer {
  private server: ReturnType<typeof createServer>;
  private clients: SSEClient[] = [];
  private onMessage: ((text: string, userId: string, iface: string, channel: string, attachments?: Attachment[]) => Promise<void>) | null = null;
  private statusFn: (() => any | Promise<any>) | null = null;
  private historyFn: ((limit: number, before?: number) => any[]) | null = null;
  private segmentsFn: ((sessionId?: string) => any) | null = null;
  private contextSegmentsFn: (() => any | Promise<any>) | null = null;
  private systemPromptFn: (() => any | Promise<any>) | null = null;
  private segmentsRebuildFn: (() => Promise<any>) | null = null;
  private segmentsStopFn: (() => void) | null = null;
  private segmentsCleanFn: (() => void) | null = null;
  private segmentsStartFn: (() => Promise<any>) | null = null;
  private segmentResummarizeFn: ((id: number) => Promise<any>) | null = null;
  private sessionListFn: (() => any) | null = null;
  private sessionActivityFn: ((sessionId: string) => any) | null = null;
  private currentSessionIdFn: (() => string | null) | null = null;
  private commandsFn: (() => Record<string, string>) | null = null;
  private pluginRoutes: import("./plugins/types.js").RouteHandler[] = [];
  private port = 0;
  private agentDir = "";

  constructor() {
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  setAgentDir(dir: string) {
    this.agentDir = dir;
  }

  setPluginRoutes(routes: import("./plugins/types.js").RouteHandler[]) {
    this.pluginRoutes = routes;
  }

  setMessageHandler(handler: (text: string, userId: string, iface: string, channel: string, attachments?: Attachment[]) => Promise<void>) {
    this.onMessage = handler;
  }

  setStatusFn(fn: () => any) {
    this.statusFn = fn;
  }

  setCommandsFn(fn: () => Record<string, string>) {
    this.commandsFn = fn;
  }

  setHistoryFn(fn: (limit: number, before?: number) => any[]) {
    this.historyFn = fn;
  }

  setSegmentsFn(fn: (sessionId?: string) => any) {
    this.segmentsFn = fn;
  }

  setContextSegmentsFn(fn: () => any | Promise<any>) {
    this.contextSegmentsFn = fn;
  }

  setSystemPromptFn(fn: () => any | Promise<any>) {
    this.systemPromptFn = fn;
  }

  setSegmentsRebuildFn(fn: () => Promise<any>) {
    this.segmentsRebuildFn = fn;
  }

  setSegmentsStopFn(fn: () => void) {
    this.segmentsStopFn = fn;
  }

  setSegmentsCleanFn(fn: () => void) {
    this.segmentsCleanFn = fn;
  }

  setSegmentsStartFn(fn: () => Promise<any>) {
    this.segmentsStartFn = fn;
  }

  setSegmentResummarizeFn(fn: (id: number) => Promise<any>) {
    this.segmentResummarizeFn = fn;
  }

  setSessionListFn(fn: () => any) {
    this.sessionListFn = fn;
  }

  setSessionActivityFn(fn: (sessionId: string) => any) {
    this.sessionActivityFn = fn;
  }

  setCurrentSessionIdFn(fn: () => string | null) {
    this.currentSessionIdFn = fn;
  }

  async start(
    host: string = "0.0.0.0",
    port: number = 0,
    maxRetries: number = 8,
    retryDelayMs: number = 200
  ): Promise<number> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const boundPort = await new Promise<number>((resolve, reject) => {
          let cleanedUp = false;
          const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            this.server.removeListener("error", onError);
            this.server.removeListener("listening", onListening);
          };
          const onError = (err: any) => {
            cleanup();
            reject(err);
          };
          const onListening = () => {
            cleanup();
            this.port = (this.server.address() as any).port;
            log("server", `listening on ${host}:${this.port}`);
            resolve(this.port);
          };
          this.server.once("error", onError);
          this.server.once("listening", onListening);
          try {
            this.server.listen(port, host);
          } catch (err) {
            cleanup();
            reject(err);
          }
        });
        return boundPort;
      } catch (err: any) {
        if (err.code === "EADDRINUSE" && attempt < maxRetries) {
          log("server", `port ${port} in use, retrying in ${retryDelayMs}ms (${attempt + 1}/${maxRetries})...`);
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Failed to bind server to ${host}:${port}`);
  }

  hasConnectedClients(): boolean {
    return this.clients.length > 0;
  }

  stop() {
    for (const client of this.clients) {
      client.res.end();
    }
    this.clients = [];
    if (this.server.listening) {
      this.server.close();
    }
  }

  // Broadcast event to all SSE clients (optionally skip one connection)
  broadcast(event: ServerEvent, excludeConnectionId?: string) {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (excludeConnectionId && client.id === excludeConnectionId) continue;
      try {
        client.res.write(`data: ${data}\n\n`);
      } catch {
        // client disconnected
      }
    }
  }

  getPort(): number {
    return this.port;
  }

  private isHeartbeat(text: string): boolean {
    return text === "[heartbeat]" || text.startsWith("[heartbeat");
  }

  private checkAuth(req: IncomingMessage): boolean {
    const token = process.env.KERN_AUTH_TOKEN;
    if (!token) return true; // shouldn't happen — token is always generated

    // Check Authorization: Bearer header
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${token}`) return true;

    // Check ?token= query param (for EventSource — can't set headers)
    const url = new URL(req.url || "/", "http://localhost");
    if (url.searchParams.get("token") === token) return true;

    return false;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    // CORS for web UI
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const rawUrl = req.url || "/";
    const url = rawUrl.split("?")[0]; // strip query string for route matching

    // Health check — always public (for monitoring)
    if (url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      return;
    }

    // Auth check — all other endpoints require token
    if (!this.checkAuth(req)) {
      const remote = req.socket.remoteAddress || "unknown";
      log("server", `401 unauthorized: ${req.method} ${url} from ${remote}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // SSE endpoint — stream all events
    if (url === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Assign a connection ID and send it as the first event
      const connectionId = crypto.randomUUID().slice(0, 8);
      res.write(`data: ${JSON.stringify({ type: "connection", connectionId })}\n\n`);

      // Keepalive ping every 15s to prevent body timeout
      const keepalive = setInterval(() => {
        try { res.write(":\n\n"); } catch {}
      }, 15000);

      const client: SSEClient = { id: connectionId, res };
      this.clients.push(client);
      const remote = req.socket.remoteAddress || "unknown";
      log("server", `SSE client connected from ${remote} (id=${connectionId}, ${this.clients.length} total)`);

      req.on("close", () => {
        clearInterval(keepalive);
        this.clients = this.clients.filter((c) => c !== client);
        log("server", `SSE client disconnected (${this.clients.length} total)`);
      });
      return;
    }

    // Post a message
    if (url === "/message" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const { text, userId, interface: iface, channel, connectionId, attachments: rawAttachments } = JSON.parse(body);
        if (!text && (!rawAttachments || rawAttachments.length === 0)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "text or attachments required" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

        // Parse base64-encoded attachments from web clients
        let attachments: Attachment[] | undefined;
        if (rawAttachments && Array.isArray(rawAttachments) && rawAttachments.length > 0) {
          attachments = rawAttachments.map((att: any) => ({
            type: att.type || "document",
            data: Buffer.from(att.data, "base64"),
            mimeType: att.mimeType || "application/octet-stream",
            filename: att.filename,
            size: att.size || 0,
          }));
          log("server", `received ${attachments.length} attachment(s) from web`);
        }

        // Broadcast incoming to all OTHER clients (exclude sender)
        if (!this.isHeartbeat(text || "")) {
          const excludeId = connectionId || undefined;
          log("server", `incoming broadcast: interface=${iface || "web"} user=${userId || "tui"} exclude=${excludeId || "none"} clients=${this.clients.length}`);
          const incomingEvent: any = {
            type: "incoming",
            text: text || "",
            fromInterface: iface || "web",
            fromUserId: userId || "tui",
            fromChannel: channel || "web",
          };
          // Include media data URLs for other tabs to render
          if (rawAttachments?.length) {
            incomingEvent.media = rawAttachments
              .filter((a: any) => a.data && a.mimeType)
              .map((a: any) => ({
                type: a.type === "image" ? "image" : "file",
                url: `data:${a.mimeType};base64,${a.data}`,
                filename: a.filename,
              }));
          }
          this.broadcast(incomingEvent, excludeId);
        }

        // Handle async — don't await, response already sent
        if (this.onMessage) {
          this.onMessage(text || "", userId || "tui", iface || "tui", channel || "tui", attachments).catch(() => {});
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "invalid JSON" }));
        } else {
          log.warn("server", `error after response sent: ${err}`);
        }
      }
      return;
    }

    // Status
    if (url === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.statusFn ? this.statusFn() : {}));
      return;
    }

    // Commands — available slash commands
    if (url === "/commands" && req.method === "GET") {
      const cmds = this.commandsFn ? this.commandsFn() : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(cmds));
      return;
    }

    // History — ?limit=50&before=<index>
    if (url === "/history" && req.method === "GET") {
      const params = new URL(rawUrl, "http://localhost").searchParams;
      const limit = parseInt(params.get("limit") || "50", 10);
      const beforeStr = params.get("before");
      const before = beforeStr ? parseInt(beforeStr, 10) : undefined;
      const history = this.historyFn ? this.historyFn(limit, before) : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(history));
      return;
    }

    // Segments — semantic segment DAG data
    if (url === "/segments" && req.method === "GET") {
      const data = this.segmentsFn ? this.segmentsFn() : { segments: [], stats: {} };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    // Context system prompt debug dump
    if (url === "/context/system" && req.method === "GET") {
      const data = this.systemPromptFn ? await this.systemPromptFn() : { system: "" };
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(typeof data === "string" ? data : (data.system || ""));
      return;
    }

    // Context-selected segments currently used for history injection
    if (url === "/context/segments" && req.method === "GET") {
      const data = this.contextSegmentsFn ? await this.contextSegmentsFn() : { segments: [], tokenCount: 0 };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    // Segments start — index new messages (no clear)
    if (url === "/segments/start" && req.method === "POST") {
      if (!this.segmentsStartFn) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "segments not enabled" }));
        return;
      }
      this.segmentsStartFn().catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "started" }));
      return;
    }

    // Segments rebuild — clear and re-index
    if (url === "/segments/rebuild" && req.method === "POST") {
      if (!this.segmentsRebuildFn) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "segments not enabled" }));
        return;
      }
      // Non-blocking — start rebuild, return immediately
      this.segmentsRebuildFn().catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "rebuilding" }));
      return;
    }

    // Segments stop — abort running rebuild/summarization
    if (url === "/segments/stop" && req.method === "POST") {
      if (this.segmentsStopFn) {
        this.segmentsStopFn();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "stopped" }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "segments not enabled" }));
      }
      return;
    }

    // Segments clean — stop + clear all segments
    if (url === "/segments/clean" && req.method === "POST") {
      if (this.segmentsStopFn && this.segmentsCleanFn) {
        this.segmentsStopFn();
        this.segmentsCleanFn();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "cleaned" }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "segments not enabled" }));
      }
      return;
    }

    // Segment resummarize — regenerate one segment summary in place
    const resummarizeMatch = url.match(/^\/segments\/(\d+)\/resummarize$/);
    if (resummarizeMatch && req.method === "POST") {
      if (!this.segmentResummarizeFn) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "segments not enabled" }));
        return;
      }
      try {
        const id = parseInt(resummarizeMatch[1] || "", 10);
        if (!Number.isFinite(id)) throw new Error("invalid segment id");
        const result = await this.segmentResummarizeFn(id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message || "resummarize failed" }));
      }
      return;
    }

    // Sessions list with stats
    if (url === "/sessions" && req.method === "GET") {
      const sessions = this.sessionListFn ? this.sessionListFn() : [];
      const currentSessionId = this.currentSessionIdFn ? this.currentSessionIdFn() : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions, currentSessionId }));
      return;
    }

    // Session activity (daily + hourly)
    const sessionActivityMatch = url.match(/^\/sessions\/([^/]+)\/activity$/);
    if (sessionActivityMatch && req.method === "GET") {
      if (!this.sessionActivityFn) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not available" }));
        return;
      }
      const data = this.sessionActivityFn(sessionActivityMatch[1]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    // Plugin routes
    for (const route of this.pluginRoutes) {
      if (req.method !== route.method) continue;
      if (typeof route.path === "string") {
        if (url === route.path) {
          await route.handler(req, res);
          return;
        }
      } else {
        const match = url.match(route.path);
        if (match) {
          await route.handler(req, res, match);
          return;
        }
      }
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}
