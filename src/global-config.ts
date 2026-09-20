import { readFile, writeFile, mkdir, unlink, appendFile } from "fs/promises";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { log } from "./log.js";

export type AgentEntry = string | { user: string; workspace: string };

export interface GlobalConfig {
  web_port: number;
  web_host: string;
  proxy_port: number;
  agents: AgentEntry[];
}

const defaults: GlobalConfig = {
  web_port: 8080,
  web_host: "0.0.0.0",
  proxy_port: 9000,
  agents: [],
};

const SYSTEM_CONFIG_FILE = "/etc/kern/config.json";
const KERN_DIR = join(homedir(), ".kern");
const USER_CONFIG_FILE = join(KERN_DIR, "config.json");
const LEGACY_AGENTS_FILE = join(KERN_DIR, "agents.json");

/**
 * Check if the machine is configured as a system-wide managed agent host (/etc/kern/config.json).
 */
export function isSystemManaged(): boolean {
  return existsSync(SYSTEM_CONFIG_FILE);
}

/**
 * Returns true if running as root (POSIX UID 0).
 */
export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Guard for mutating fleet commands. If /etc/kern/config.json exists, mutating fleet
 * operations must be run by root to prevent rogue local configs or permission corruption.
 */
export function assertFleetAuthority(action: string): void {
  if (isSystemManaged() && !isRoot()) {
    console.error(`\x1b[31mError:\x1b[0m This host is managed via ${SYSTEM_CONFIG_FILE}.`);
    console.error(`Fleet command '${action}' must be run as root (or via sudo).`);
    process.exit(1);
  }
}

/**
 * Resolve the active global config path:
 * - /etc/kern/config.json if it exists
 * - ~/.kern/config.json otherwise
 */
export function getGlobalConfigPath(): string {
  if (isSystemManaged()) {
    return SYSTEM_CONFIG_FILE;
  }
  return USER_CONFIG_FILE;
}

/**
 * Helper to extract workspace path from string or object AgentEntry.
 */
export function getAgentWorkspace(entry: AgentEntry): string {
  return typeof entry === "string" ? entry : entry.workspace;
}

/**
 * Helper to extract optional declared user from AgentEntry.
 */
export function getAgentUser(entry: AgentEntry): string | null {
  return typeof entry === "string" ? null : entry.user;
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const configFile = getGlobalConfigPath();

  // Migrate legacy agents.json → config.json on first load if using user config
  if (!isSystemManaged()) {
    await migrateLegacyAgents();
  }

  if (!existsSync(configFile)) return { ...defaults };
  try {
    const raw = await readFile(configFile, "utf-8");
    const userConfig = JSON.parse(raw);
    return { ...defaults, ...userConfig };
  } catch {
    return { ...defaults };
  }
}

export function loadGlobalConfigSync(): GlobalConfig {
  const configFile = getGlobalConfigPath();
  if (!existsSync(configFile)) return { ...defaults };
  try {
    const raw = readFileSync(configFile, "utf-8");
    const userConfig = JSON.parse(raw);
    return { ...defaults, ...userConfig };
  } catch {
    return { ...defaults };
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  if (isSystemManaged()) {
    if (!isRoot()) {
      throw new Error(`Permission denied: cannot write to ${SYSTEM_CONFIG_FILE} without root privileges.`);
    }
    await mkdir("/etc/kern", { recursive: true });
    await writeFile(SYSTEM_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return;
  }

  await mkdir(KERN_DIR, { recursive: true });
  await writeFile(USER_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Migrate legacy ~/.kern/agents.json (array of objects) into config.json agents field.
 * Runs once — deletes agents.json after migration.
 */
async function migrateLegacyAgents(): Promise<void> {
  if (!existsSync(LEGACY_AGENTS_FILE)) return;
  try {
    const raw = await readFile(LEGACY_AGENTS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;

    // Extract paths from legacy object entries
    const paths: string[] = parsed.map((entry: any) => entry.path).filter(Boolean);

    // Load existing config and merge agents
    let config = { ...defaults };
    if (existsSync(USER_CONFIG_FILE)) {
      try {
        const configRaw = await readFile(USER_CONFIG_FILE, "utf-8");
        config = { ...defaults, ...JSON.parse(configRaw) };
      } catch {}
    }
    config.agents = paths;

    await saveGlobalConfig(config);
    await unlink(LEGACY_AGENTS_FILE);
    log("config", `migrated ${paths.length} agent(s) from agents.json → config.json`);
  } catch (err) {
    log.warn("config", `agents.json migration failed: ${err}`);
  }
}

const ENV_FILE = join(homedir(), ".kern", ".env");

/** Load or auto-generate the proxy auth token from ~/.kern/.env */
export async function getProxyToken(): Promise<string> {
  if (existsSync(ENV_FILE)) {
    const content = await readFile(ENV_FILE, "utf-8");
    // Check new name first, fall back to legacy KERN_WEB_TOKEN
    const match = content.match(/^KERN_PROXY_TOKEN=(.+)$/m)
      || content.match(/^KERN_WEB_TOKEN=(.+)$/m);
    if (match) return match[1].trim();
  }
  const token = randomBytes(16).toString("hex");
  await appendFile(ENV_FILE, `${existsSync(ENV_FILE) ? "\n" : ""}KERN_PROXY_TOKEN=${token}\n`);
  log("proxy", `generated proxy token: ${token.slice(0, 8)}...`);
  return token;
}
