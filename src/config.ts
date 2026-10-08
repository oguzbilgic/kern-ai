import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { config as loadDotenv } from "dotenv";
import { log } from "./log.js";
import { validateModelRoutes } from "./model.js";

export type ToolScope = "full" | "write" | "read";

export const PROVIDER_IDS = ["openrouter", "anthropic", "openai", "ollama", "openai-compatible"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

/** API root (including /v1 when required); credentials stay in .env. */
export interface ModelConnection {
  provider: string;
  baseURL?: string;
  apiKeyEnv?: string;
  auth?: "none";
  api?: "chat" | "responses";
}

export interface ModelSpec extends Partial<ModelConnection> {
  model: string;
  /** Requested output size, only valid for embeddingModel. */
  dimensions?: number;
}

/** A bare ID inherits the main connection. An object can override it. */
export type ModelRef = string | ModelSpec;

export interface KernConfig extends ModelConnection {
  /** Package version of the last successful file migration. */
  version?: string;
  // Core
  name: string;
  model: string;
  toolScope: ToolScope;
  maxSteps: number;
  port: number;

  // Context window
  maxContextTokens: number;
  maxToolResultChars: number;
  summaryBudget: number;
  summaryModel: ModelRef;

  // Sub-agents
  subAgentModel: ModelRef;

  // Memory
  embeddingModel: ModelRef | false;
  recall: boolean;
  autoRecall: boolean;

  // Media
  mediaDigest: boolean;
  mediaModel: ModelRef;
  audioModel: ModelRef;
  mediaContext: number;

  // Interface
  telegramTools: boolean;
  discordMentionOnly: boolean;
  /** Nostr relay URLs. Empty array = built-in public defaults. Overridable via NOSTR_RELAYS. */
  nostrRelays: string[];
  /**
   * IRC connection URL(s): `irc://nick@host:6667/#chan` or
   * `ircs://nick:pass@host:6697/#a,#b`. Whitespace-separate for multiple
   * servers. Empty = IRC disabled. Overridable via IRC_URL.
   */
  irc: string;

  // Runtime
  stripAnsi: boolean;
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
  full: [shell, "read", "write", "edit", "glob", "grep", "webfetch", "websearch", "pdf", "image", "audio", "kern", "message"],
  write: ["read", "write", "edit", "glob", "grep", "webfetch", "websearch", "pdf", "image", "audio", "kern", "message"],
  read: ["read", "glob", "grep", "webfetch", "websearch", "pdf", "image", "audio", "kern"],
};

export const configDefaults: KernConfig = {
  name: "",
  model: "google/gemini-3.8-flash",
  provider: "openrouter",
  toolScope: "full",
  maxSteps: 30,
  port: 0,
  maxContextTokens: 100000,
  maxToolResultChars: 20000,
  summaryBudget: 0.75,
  summaryModel: "",
  subAgentModel: "",
  embeddingModel: "",
  recall: true,
  autoRecall: false,
  mediaDigest: true,
  mediaModel: "",
  audioModel: "",
  mediaContext: 0,
  telegramTools: false,
  discordMentionOnly: true,
  nostrRelays: [],
  irc: "",
  stripAnsi: true,
  heartbeatInterval: 60,
  timezone: "",
};

const FIELD_TYPES: Record<string, string> = {
  version: "string",
  name: "string",
  model: "string",
  provider: "string",
  baseURL: "string",
  apiKeyEnv: "string",
  auth: "string",
  api: "string",
  embeddingModel: "embedding-ref",
  toolScope: "string",
  maxSteps: "number",
  port: "number",
  maxContextTokens: "number",
  maxToolResultChars: "number",
  summaryBudget: "number",
  summaryModel: "model-ref",
  subAgentModel: "model-ref",
  recall: "boolean",
  autoRecall: "boolean",
  mediaDigest: "boolean",
  mediaModel: "model-ref",
  audioModel: "model-ref",
  mediaContext: "number",
  telegramTools: "boolean",
  discordMentionOnly: "boolean",
  nostrRelays: "string[]",
  irc: "string",
  stripAnsi: "boolean",
  heartbeatInterval: "number",
  timezone: "string",
  mcpServers: "object",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === "model-ref" || expected === "embedding-ref") {
    return typeof value === "string" || isPlainObject(value) || (expected === "embedding-ref" && value === false);
  }
  if (expected === "object") return isPlainObject(value);
  if (expected === "string[]") return Array.isArray(value) && value.every((v) => typeof v === "string");
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

/** Model configuration errors are fatal: never silently select a different route. */
export function validateModelConfig(config: KernConfig): void {
  const validateConnection = (value: Record<string, unknown>, label: string) => {
    if (value.provider !== undefined && !PROVIDER_IDS.includes(value.provider as ProviderId)) {
      throw new Error(`${label}.provider: unknown provider "${value.provider}"`);
    }
    for (const key of ["baseURL", "apiKeyEnv"]) {
      if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key].trim())) {
        throw new Error(`${label}.${key}: expected a non-empty string`);
      }
    }
    if (value.baseURL !== undefined) {
      const url = URL.parse(value.baseURL as string);
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(`${label}.baseURL: use an HTTP(S) API root without credentials, query, or fragment`);
      }
    }
    if (value.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv as string)) {
      throw new Error(`${label}.apiKeyEnv: expected an environment variable name`);
    }
    if (value.auth !== undefined && value.auth !== "none") throw new Error(`${label}.auth: expected "none"`);
    if (value.auth === "none" && value.apiKeyEnv !== undefined) throw new Error(`${label}: choose auth or apiKeyEnv, not both`);
    if (value.api !== undefined && value.api !== "chat" && value.api !== "responses") {
      throw new Error(`${label}.api: expected "chat" or "responses"`);
    }
  };
  validateConnection(config as unknown as Record<string, unknown>, "model");
  if (typeof config.model !== "string" || !config.model.trim()) throw new Error("model: expected a non-empty model ID");
  for (const key of ["embeddingModel", "summaryModel", "subAgentModel", "mediaModel", "audioModel"] as const) {
    const ref = config[key];
    if (typeof ref === "string" || (key === "embeddingModel" && ref === false)) continue;
    if (!isPlainObject(ref)) throw new Error(`${key}: expected a model ID or model object`);
    const allowed = ["model", "provider", "baseURL", "apiKeyEnv", "auth", "api", ...(key === "embeddingModel" ? ["dimensions"] : [])];
    for (const field of Object.keys(ref)) {
      if (!allowed.includes(field)) throw new Error(`${key}.${field}: unknown field`);
    }
    if (typeof ref.model !== "string" || !ref.model.trim()) throw new Error(`${key}.model: expected a non-empty model ID`);
    validateConnection(ref, key);
    if (ref.dimensions !== undefined && (!Number.isSafeInteger(ref.dimensions) || (ref.dimensions as number) <= 0)) {
      throw new Error(`${key}.dimensions: expected a positive integer`);
    }
  }
}

/** Parse stored configuration without loading environment overrides or writing files. */
export function parseConfig(userConfig: unknown): KernConfig {
  if (!isPlainObject(userConfig)) throw new Error("config.json must contain an object");
  validateConfig(userConfig);
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(userConfig)) {
    if (!(key in FIELD_TYPES)) continue;
    if (typeMatches(value, FIELD_TYPES[key])) cleaned[key] = value;
    else if (["model", "provider", "baseURL", "apiKeyEnv", "auth", "api", "embeddingModel", "summaryModel", "subAgentModel", "mediaModel", "audioModel"].includes(key)) {
      throw new Error(`${key}: invalid model configuration`);
    }
  }
  const config = { ...configDefaults, ...cleaned };
  validateModelConfig(config);
  return config;
}

export async function loadConfig(agentDir: string): Promise<KernConfig> {
  const envPath = join(agentDir, ".kern", ".env");
  if (existsSync(envPath)) loadDotenv({ path: envPath, override: true, quiet: true });
  const configPath = join(agentDir, ".kern", "config.json");
  const userConfig = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf-8")) : {};
  return resolveConfig(userConfig);
}

/** Shared by startup, setup, and migrations; does not mutate raw config or env. */
export function resolveConfig(userConfig: unknown, env: NodeJS.ProcessEnv = process.env): KernConfig {
  const config = applyEnvOverrides(parseConfig(userConfig), env);
  validateModelConfig(config);
  validateModelRoutes(config);
  return config;
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
  KERN_BASE_URL: { key: "baseURL", type: "string" },
  KERN_EMBEDDING_MODEL: { key: "embeddingModel", type: "string" },
  KERN_SUMMARY_MODEL: { key: "summaryModel", type: "string" },
};

function applyEnvOverrides(config: KernConfig, env: NodeJS.ProcessEnv): KernConfig {
  for (const [envKey, { key, type }] of Object.entries(ENV_CONFIG_MAP)) {
    const val = env[envKey];
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
/** Known fields in their documented order (version and name first), then anything else as found. */
export function serializeConfig(config: object): string {
  const entries = Object.entries(config);
  const rank = (key: string) => Object.keys(FIELD_TYPES).indexOf(key) >>> 0; // unknown keys sort last, keeping their order
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => rank(a) - rank(b))), null, 2) + "\n";
}

export async function saveConfigField(agentDir: string, key: string, value: unknown): Promise<void> {
  const configPath = join(agentDir, ".kern", "config.json");
  let config: Record<string, unknown> = {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {}
  config[key] = value;
  await writeFile(configPath, serializeConfig(config), "utf-8");
}
