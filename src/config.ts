import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { config as loadDotenv } from "dotenv";
import { log } from "./log.js";

export type ToolScope = "full" | "write" | "read";

export interface KernConfig {
  // Core
  name: string;
  model: string;
  provider: string;
  toolScope: ToolScope;
  maxSteps: number;
  port: number;

  // Context window
  maxContextTokens: number;
  maxToolResultChars: number;
  summaryBudget: number;
  summaryModel: string;

  // Memory
  recall: boolean;
  autoRecall: boolean;

  // Media
  mediaDigest: boolean;
  mediaModel: string;
  mediaContext: number;

  // Interface
  telegramTools: boolean;

  // Runtime
  heartbeatInterval: number;

  // Timezone — IANA zone used when rendering the `time:` field in the envelope
  // the model reads. Empty string means autoresolve to host timezone. Storage
  // everywhere else (logs, recall.db, session metadata) stays UTC.
  timezone: string;

  // MCP — Model Context Protocol servers. Agent-local. See docs/mcp.md.
  mcpServers?: Record<string, McpServerConfig>;
}

export type McpServerConfig =
  | {
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

const shell = process.platform === "win32" ? "pwsh" : "bash";

const TOOL_SCOPES: Record<ToolScope, string[]> = {
  full: [shell, "read", "write", "edit", "glob", "grep", "webfetch", "websearch", "pdf", "image", "kern", "message"],
  write: ["read", "write", "edit", "glob", "grep", "webfetch", "websearch", "pdf", "image", "kern", "message"],
  read: ["read", "glob", "grep", "webfetch", "websearch", "pdf", "image", "kern"],
};

export const configDefaults: KernConfig = {
  name: "",
  model: "anthropic/claude-opus-4.7",
  provider: "openrouter",
  toolScope: "full",
  maxSteps: 30,
  port: 0,
  maxContextTokens: 100000,
  maxToolResultChars: 20000,
  summaryBudget: 0.75,
  summaryModel: "",
  recall: true,
  autoRecall: false,
  mediaDigest: true,
  mediaModel: "",
  mediaContext: 0,
  telegramTools: false,
  heartbeatInterval: 60,
  timezone: "",
};

const FIELD_TYPES: Record<string, string> = {
  name: "string",
  model: "string",
  provider: "string",
  toolScope: "string",
  maxSteps: "number",
  port: "number",
  maxContextTokens: "number",
  maxToolResultChars: "number",
  summaryBudget: "number",
  summaryModel: "string",
  recall: "boolean",
  autoRecall: "boolean",
  mediaDigest: "boolean",
  mediaModel: "string",
  mediaContext: "number",
  telegramTools: "boolean",
  heartbeatInterval: "number",
  timezone: "string",
  mcpServers: "object",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === "object") return isPlainObject(value);
  return typeof value === expected;
}

function validateConfig(userConfig: Record<string, unknown>): void {
  for (const key of Object.keys(userConfig)) {
    if (!(key in FIELD_TYPES)) {
      log.warn("config", `unknown field "${key}" — ignored`);
      continue;
    }
    const expected = FIELD_TYPES[key];
    if (!typeMatches(userConfig[key], expected)) {
      const actual = userConfig[key] === null
        ? "null"
        : Array.isArray(userConfig[key])
          ? "array"
          : typeof userConfig[key];
      log.warn("config", `"${key}" should be ${expected}, got ${actual} — using default`);
    }
  }
}

export function getToolsForScope(scope: ToolScope): string[] {
  return TOOL_SCOPES[scope] || TOOL_SCOPES.full;
}

export async function loadConfig(agentDir: string): Promise<KernConfig> {
  // Load .kern/.env
  const envPath = join(agentDir, ".kern", ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  // Load .kern/config.json
  const configPath = join(agentDir, ".kern", "config.json");
  if (!existsSync(configPath)) {
    return configDefaults;
  }

  try {
    const raw = await readFile(configPath, "utf-8");
    const userConfig = JSON.parse(raw);
    validateConfig(userConfig);

    // Filter out unknown and wrong-type fields
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(userConfig)) {
      if (key in FIELD_TYPES && typeMatches(value, FIELD_TYPES[key])) {
        cleaned[key] = value;
      }
    }

    return applyEnvOverrides({ ...configDefaults, ...cleaned });
  } catch {
    return applyEnvOverrides(configDefaults);
  }
}

/**
 * Apply KERN_* environment variable overrides to config.
 * Only a small explicit set of fields are supported.
 */
const ENV_CONFIG_MAP: Record<string, { key: keyof KernConfig; type: "string" | "number" }> = {
  KERN_NAME:     { key: "name",     type: "string" },
  KERN_PORT:     { key: "port",     type: "number" },
  KERN_MODEL:    { key: "model",    type: "string" },
  KERN_PROVIDER: { key: "provider", type: "string" },
};

function applyEnvOverrides(config: KernConfig): KernConfig {
  for (const [envKey, { key, type }] of Object.entries(ENV_CONFIG_MAP)) {
    const val = process.env[envKey];
    if (val === undefined) continue;

    if (type === "number") {
      const num = Number(val);
      if (!isNaN(num)) {
        (config as any)[key] = num;
        log("config", `${envKey} → ${key}=${num}`);
      }
    } else {
      (config as any)[key] = val;
      log("config", `${envKey} → ${key}=${val}`);
    }
  }
  return config;
}

/**
 * Write a single field into agent's .kern/config.json, preserving existing fields.
 */
export async function saveConfigField(agentDir: string, key: string, value: unknown): Promise<void> {
  const configPath = join(agentDir, ".kern", "config.json");
  let config: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {}
  config[key] = value;
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
