#!/usr/bin/env node

/**
 * kern web — minimal static file server for the web UI.
 * No auth, no proxy, no agent discovery. Port and host come from argv
 * (`--port`, `--host`), never from a config file.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { parseWebFlags } from "./web-daemon.js";

function log(msg: string) {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} [web] ${msg}\n`);
}

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".txt": "text/plain", ".woff2": "font/woff2",
};

const staticFiles: Record<string, { file: string; contentType: string }> = {
  "/manifest.json": { file: "manifest.json", contentType: "application/manifest+json" },
  "/sw.js": { file: "sw.js", contentType: "application/javascript" },
  "/icon.svg": { file: "icon.svg", contentType: "image/svg+xml" },
};

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = (req.url || "/").split("?")[0];

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }

  const serveDir = join(import.meta.dirname, "..", "web", "out");

  // Known static files
  if (staticFiles[url]) {
    const sf = staticFiles[url];
    const fp = join(serveDir, sf.file);
    if (existsSync(fp)) {
      res.writeHead(200, { "Content-Type": sf.contentType });
      res.end(await readFile(fp));
      return;
    }
  }

  // Static file or SPA fallback
  const filePath = url === "/" ? join(serveDir, "index.html") : join(serveDir, decodeURIComponent(url));
  const resolved = resolve(filePath);
  if (!resolved.startsWith(serveDir + "/") && resolved !== serveDir) {
    res.writeHead(403);
    res.end();
    return;
  }

  if (existsSync(filePath)) {
    const ext = filePath.substring(filePath.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": STATIC_MIME[ext] ?? "application/octet-stream" });
    res.end(await readFile(filePath));
  } else {
    // SPA fallback
    const indexPath = join(serveDir, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(await readFile(indexPath));
    } else {
      res.writeHead(404);
      res.end();
    }
  }
});

function start() {
  let flags;
  try {
    flags = parseWebFlags(process.argv.slice(2));
  } catch (err: any) {
    log(`error: ${err.message}`);
    process.exit(1);
  }
  const { port, host } = flags;
  server.on("error", (err: any) => {
    log(`error: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    log(`listening on ${host}:${port}`);
  });
}

start();
