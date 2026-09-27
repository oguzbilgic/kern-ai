import { writeFile, mkdir, unlink } from "fs/promises";
import { join, basename, resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createServer } from "net";
import { parse as parseDotenv } from "dotenv";
import { saveConfigField } from "./config.js";
import { log } from "./log.js";

/**
 * An agent is a directory containing `.kern/`. There is no registry: every
 * command takes a `[path]` (default `.`) and everything the CLI needs is read
 * from `<path>/.kern/`.
 */

export interface AgentInfo {
  name: string;
  path: string;
  port: number;
  token: string | null;
  pid: number | null;
}

export class AgentDirError extends Error {
  constructor(dir: string) {
    super(`no agent in ${dir} (no .kern/ directory). Run 'kern init' there first.`);
    this.name = "AgentDirError";
  }
}

/** True when `dir` contains a `.kern/` directory. */
export function isAgentDir(dir: string): boolean {
  return existsSync(join(dir, ".kern"));
}

/**
 * Resolve `[path]` (default `.`) to an absolute agent directory.
 * Throws AgentDirError when the directory has no `.kern/`.
 */
export function resolveAgentDir(arg?: string): string {
  const dir = resolve(arg ?? ".");
  if (!isAgentDir(dir)) throw new AgentDirError(dir);
  return dir;
}

// --- Agent info: read from agent's own .kern/ directory ---

export function readAgentInfo(agentPath: string): AgentInfo | null {
  if (!existsSync(agentPath)) return null;

  const configPath = join(agentPath, ".kern", "config.json");
  const envPath = join(agentPath, ".kern", ".env");

  // Read config for name and port
  let name = basename(agentPath);
  let port = 0;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    if (config.name) name = config.name;
    if (config.port) port = config.port;
  } catch {}

  // Read token from .env
  let token: string | null = null;
  try {
    const envRaw = readFileSync(envPath, "utf-8");
    const env = parseDotenv(envRaw);
    token = env.KERN_AUTH_TOKEN || null;
  } catch {}

  return { name, port, token, pid: readPid(agentPath), path: agentPath };
}

// --- Ports ---

/**
 * Check if a port is available by attempting to bind it.
 */
function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "0.0.0.0", () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Pick a sticky port for an agent from 4100-4999 by live bind checking.
 * Returns 0 (OS-assigned) when the whole range is busy.
 */
export async function assignPort(): Promise<number> {
  for (let port = 4100; port <= 4999; port++) {
    if (await checkPort(port)) {
      if (port > 4100) {
        log("kern", `assigned port ${port} (${port - 4100} skipped)`);
      }
      return port;
    }
    log.debug("kern", `port ${port} in use, trying ${port + 1}`);
  }

  log.warn("kern", "port range 4100-4999 exhausted, falling back to OS-assigned port");
  return 0;
}

/** The subset of AgentServer that port binding needs. */
export interface BindableServer {
  start(host: string, port: number): Promise<number>;
}

/**
 * Bind the agent server on its sticky port. If that port is still busy after
 * the server's own EADDRINUSE retries, pick a fresh port, save it to
 * `.kern/config.json`, and bind there instead.
 *
 * A port pinned by `KERN_PORT` is never reassigned: the environment owns it,
 * so the original bind error is rethrown.
 */
export async function bindAgentServer(
  server: BindableServer,
  agentDir: string,
  port: number,
  opts: { host?: string; pinned?: boolean } = {},
): Promise<number> {
  const host = opts.host ?? "0.0.0.0";
  const pinned = opts.pinned ?? process.env.KERN_PORT !== undefined;
  try {
    return await server.start(host, port);
  } catch (err: any) {
    if (err?.code !== "EADDRINUSE" || port === 0 || pinned) throw err;
    const next = await assignPort();
    if (next > 0) await saveConfigField(agentDir, "port", next);
    log("kern", `port :${port} in use, reassigned :${next || "os-assigned"}`);
    return server.start(host, next);
  }
}

// --- Processes ---

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * argv for restarting the agent in `agentDir` from inside its own process:
 * the running node binary and this package's entry point, never `PATH`.
 */
export function restartArgv(agentDir: string): string[] {
  return [process.execPath, join(import.meta.dirname, "index.js"), "restart", agentDir];
}

// --- PID file management ---

export async function writePidFile(agentDir: string, pid: number): Promise<void> {
  const pidPath = join(agentDir, ".kern", "agent.pid");
  await mkdir(join(agentDir, ".kern"), { recursive: true });
  await writeFile(pidPath, String(pid), "utf-8");
}

/**
 * Remove the PID file. With `onlyIfPid`, remove it only while it still names
 * that PID, so a process shutting down late never deletes its successor's file.
 */
export async function removePidFile(agentDir: string, onlyIfPid?: number): Promise<void> {
  const pidPath = join(agentDir, ".kern", "agent.pid");
  if (onlyIfPid !== undefined && readPid(agentDir) !== onlyIfPid) return;
  try {
    await unlink(pidPath);
  } catch {}
}

/** Poll until `pid` is gone. Resolves true when it exited, false on timeout. */
export async function waitForExit(pid: number, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return true;
}

export function readPid(agentDir: string): number | null {
  const pidPath = join(agentDir, ".kern", "agent.pid");
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Read the PID file and clear it when the process is gone.
 * Returns the live PID or null.
 */
export async function readLivePid(agentDir: string): Promise<number | null> {
  const pid = readPid(agentDir);
  if (!pid) return null;
  if (isProcessRunning(pid)) return pid;
  await removePidFile(agentDir);
  return null;
}
