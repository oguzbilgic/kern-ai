#!/usr/bin/env node

/**
 * kern proxy — authenticated reverse proxy for multi-agent access.
 * Also serves the web UI static files.
 *
 * Routes:
 *   GET  /                              → web UI (index.html)
 *   GET  /api/agents                    → list of registered agents
 *   GET  /api/agents/:name/events       → SSE proxy to agent
 *   POST /api/agents/:name/message      → proxy to agent
 *   GET  /api/agents/:name/status       → proxy to agent
 *   GET  /api/agents/:name/history      → proxy to agent
 *   GET  /api/agents/:name/health       → proxy to agent
 *   GET  /api/agents/:name/segments     → proxy to agent (semantic segment DAG)
 *   POST /api/agents/:name/segments/rebuild → proxy to agent (clear + re-index)
 *   GET  /manifest.json                 → PWA manifest
 *   GET  /sw.js                         → service worker
 *   GET  /icon.svg                      → app icon
 */

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "http";
import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { homedir } from "os";

import { isProcessRunning, type AgentInfo } from "./agent-dir.js";
import { randomBytes } from "crypto";
import { appendFile } from "fs/promises";

/**
 * NOTE: the proxy is not reachable from the CLI in this version. It needs agent
 * discovery, which returns with fleet mode. Until then it sees no agents.
 */
async function loadAgents(): Promise<AgentInfo[]> {
  return [];
}

const PROXY_ENV_FILE = join(homedir(), ".kern", ".env");
const DEFAULT_PROXY_PORT = 9000;

/** Load or auto-generate the proxy auth token from ~/.kern/.env */
async function getProxyToken(): Promise<string> {
  if (existsSync(PROXY_ENV_FILE)) {
    const content = await readFile(PROXY_ENV_FILE, "utf-8");
    const match = content.match(/^KERN_PROXY_TOKEN=(.+)$/m)
      || content.match(/^KERN_WEB_TOKEN=(.+)$/m);
    if (match) return match[1].trim();
  }
  const token = randomBytes(16).toString("hex");
  await appendFile(PROXY_ENV_FILE, `${existsSync(PROXY_ENV_FILE) ? "\n" : ""}KERN_PROXY_TOKEN=${token}\n`);
  return token;
}

let proxyToken: string;

function log(msg: string) {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} [proxy] ${msg}\n`);
}

/** Proxy a request to an agent's HTTP server, injecting its auth token */
function proxyToAgent(req: IncomingMessage, res: ServerResponse, agent: AgentInfo, targetPath: string) {
  const proxyReq = httpRequest(
    {
      hostname: "127.0.0.1",
      port: agent.port,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${agent.port}`,
        authorization: agent.token ? `Bearer ${agent.token}` : "",
      },
    },
    (proxyRes) => {
      // Copy status + headers from agent response
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      // Pipe the response — works for SSE streams and regular responses
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    log(`proxy error for ${agent.name}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "agent unreachable" }));
    }
  });

  // Abort proxy request if client disconnects (important for SSE streams)
  res.on("close", () => proxyReq.destroy());

  // Pipe request body (for POST /message)
  req.pipe(proxyReq);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const rawUrl = req.url || "/";
  const url = rawUrl.split("?")[0];

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Static file serving — Next.js static export from web/out/
  const STATIC_MIME: Record<string, string> = {
    ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".txt": "text/plain", ".woff2": "font/woff2",
  };

  if (req.method === "GET" && !url.startsWith("/api/")) {
    const serveDir = join(import.meta.dirname, "..", "web", "out");

    const filePath = url === "/" ? join(serveDir, "index.html") : join(serveDir, decodeURIComponent(url));
    const resolved = resolve(filePath);
    if (!resolved.startsWith(serveDir + "/") && resolved !== serveDir) {
      res.writeHead(403); res.end(); return;
    }

    if (existsSync(filePath)) {
      const ext = filePath.substring(filePath.lastIndexOf("."));
      const contentType = STATIC_MIME[ext] ?? "application/octet-stream";
      const content = await readFile(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } else {
      // SPA fallback — serve index.html for client-side routing
      const indexPath = join(serveDir, "index.html");
      if (existsSync(indexPath)) {
        const html = await readFile(indexPath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } else {
        res.writeHead(404); res.end();
      }
    }
    return;
  }

  // Auth check — all /api/* routes require proxy token
  if (url.startsWith("/api/")) {
    const authHeader = req.headers.authorization;
    const queryToken = new URL(rawUrl, "http://localhost").searchParams.get("token");
    if (authHeader !== `Bearer ${proxyToken}` && queryToken !== proxyToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  // Agent list API — returns agents (no port/token — proxy handles auth)
  if (url === "/api/agents" && req.method === "GET") {
    const agents = await loadAgents();
    const result = agents.map((a) => ({
      name: a.name,
      running: !!(a.pid && isProcessRunning(a.pid)),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // Agent proxy — /api/agents/:name/:endpoint
  const proxyMatch = url.match(/^\/api\/agents\/([^/]+)\/(.+)$/);
  if (proxyMatch) {
    const [, agentName, endpoint] = proxyMatch;
    const agents = await loadAgents();
    const agent = agents.find((a) => a.name === agentName);

    if (!agent || !agent.port || !agent.pid || !isProcessRunning(agent.pid)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "agent not found or not running" }));
      return;
    }

    // Build target URL — preserve query string
    const queryString = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
    const targetPath = `/${endpoint}${queryString}`;

    proxyToAgent(req, res, agent, targetPath);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

async function start() {
  proxyToken = await getProxyToken();
  const portIdx = process.argv.indexOf("--port");
  const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) || DEFAULT_PROXY_PORT : DEFAULT_PROXY_PORT;
  server.listen(port, "0.0.0.0", () => {
    log(`listening on 0.0.0.0:${port}`);
  });
}

start();
