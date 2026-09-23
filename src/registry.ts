import { writeFile, mkdir, unlink } from "fs/promises";
import { join, basename } from "path";
import { existsSync, readFileSync } from "fs";
import { createServer } from "net";
import { parse as parseDotenv } from "dotenv";
import {
  loadGlobalConfig,
  loadGlobalConfigSync,
  saveGlobalConfig,
  getAgentWorkspace,
  getAgentUser,
  isSystemManaged,
  AgentEntry,
} from "./global-config.js";
import { log } from "./log.js";

/**
 * Agent registry backed by ~/.kern/config.json or /etc/kern/config.json `agents` field.
 * All agent runtime state (port, token, PID) lives in the agent's own .kern/ directory.
 */

export interface AgentInfo {
  name: string;
  path: string;
  user: string | null;
  port: number;
  token: string | null;
  pid: number | null;
}

// --- Registry: reads/writes config.agents ---

export async function loadRegistry(): Promise<string[]> {
  const config = await loadGlobalConfig();
  return config.agents.map(getAgentWorkspace);
}

export async function loadRegistryEntries(): Promise<AgentEntry[]> {
  const config = await loadGlobalConfig();
  return config.agents;
}

export async function registerAgent(path: string, user?: string): Promise<void> {
  // On managed hosts (/etc/kern/config.json), agents are registered explicitly by root during setup.
  // Runtime foreground processes (kern run) should not self-mutate /etc/kern/config.json.
  if (isSystemManaged()) {
    const config = await loadGlobalConfig();
    const alreadyRegistered = config.agents.some((entry) => getAgentWorkspace(entry) === path);
    if (!alreadyRegistered) {
      log.debug("registry", `system-managed host: skipping self-registration for ${path}`);
    }
    return;
  }

  const config = await loadGlobalConfig();
  const exists = config.agents.some((entry) => getAgentWorkspace(entry) === path);
  if (!exists) {
    if (user) {
      config.agents.push({ user, workspace: path });
    } else {
      config.agents.push(path);
    }
    await saveGlobalConfig(config);
  }
}

export async function removeAgent(nameOrPath: string): Promise<boolean> {
  const config = await loadGlobalConfig();
  let idx = -1;

  for (let i = 0; i < config.agents.length; i++) {
    const entry = config.agents[i];
    const ws = getAgentWorkspace(entry);
    if (ws === nameOrPath) {
      idx = i;
      break;
    }
    const info = readAgentInfo(ws);
    if (info && info.name === nameOrPath) {
      idx = i;
      break;
    }
  }

  if (idx < 0) return false;
  config.agents.splice(idx, 1);
  await saveGlobalConfig(config);
  return true;
}

// --- Agent info: read from agent's own .kern/ directory ---

export function readAgentInfo(agentPath: string, user: string | null = null): AgentInfo | null {
  if (!existsSync(agentPath)) return null;

  const configPath = join(agentPath, ".kern", "config.json");
  const envPath = join(agentPath, ".kern", ".env");
  const pidPath = join(agentPath, ".kern", "agent.pid");

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

  // Read PID
  let pid: number | null = null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    pid = parseInt(raw, 10);
    if (isNaN(pid)) pid = null;
  } catch {}

  return { name, path: agentPath, user, port, token, pid };
}

export function findAgent(nameOrPath: string): AgentInfo | null {
  const config = loadGlobalConfigSync();

  for (const entry of config.agents) {
    const ws = getAgentWorkspace(entry);
    const user = getAgentUser(entry);
    const info = readAgentInfo(ws, user);
    if (!info) continue;
    if (info.name === nameOrPath || info.path === nameOrPath || ws === nameOrPath || user === nameOrPath) {
      return info;
    }
  }
  return null;
}

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
 * Assign a sticky port to an agent. Picks from 4100-4999, skipping registry-known ports
 * and bind-checking to avoid cross-user collisions.
 */
export async function assignPort(): Promise<number> {
  const config = loadGlobalConfigSync();
  const knownPorts = new Set<number>();
  for (const entry of config.agents) {
    const ws = getAgentWorkspace(entry);
    const info = readAgentInfo(ws);
    if (info && info.port > 0) knownPorts.add(info.port);
  }

  for (let port = 4100; port <= 4999; port++) {
    if (knownPorts.has(port)) continue;
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

export function readPid(agentDir: string): number | null {
  const pidPath = join(agentDir, ".kern", "agent.pid");
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- PID file management ---

export async function writePidFile(agentDir: string, pid: number): Promise<void> {
  const pidPath = join(agentDir, ".kern", "agent.pid");
  await mkdir(join(agentDir, ".kern"), { recursive: true });
  await writeFile(pidPath, String(pid), "utf-8");
}

export async function removePidFile(agentDir: string): Promise<void> {
  const pidPath = join(agentDir, ".kern", "agent.pid");
  try {
    await unlink(pidPath);
  } catch {}
}
