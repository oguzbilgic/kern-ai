import { mkdir, writeFile, readFile } from "fs/promises";
import { join, resolve, basename, relative } from "path";
import { existsSync } from "fs";
import { input, select, password } from "@inquirer/prompts";
import { isAgentDir, readLivePid } from "./agent-dir.js";
import { startAgent, stopAgent } from "./daemon.js";
import { configDefaults, resolveConfig, serializeConfig, type KernConfig, type ModelConnection, type ModelRef } from "./config.js";
import { resolveModel, configureConnection, connectionSettings } from "./model.js";
import { migrateAgentFiles } from "./migrations/index.js";
import { PACKAGE_VERSION } from "./package-version.js";
import { parse as parseEnv } from "dotenv";
import { log } from "./log.js";

// Default models per provider
export const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  openrouter: "google/gemini-3.8-flash",
  anthropic: "claude-opus-5-5",
  openai: "gpt-6-sol",
  ollama: "gemma4:31b",
};

// Fallback models used when live fetch fails (e.g. no network, bad key)
const FALLBACK_MODELS: Record<string, { name: string; value: string }[]> = {
  openrouter: [
    { name: "Gemini 3.8 Flash", value: "google/gemini-3.8-flash" },
    { name: "Claude Opus 5.5", value: "anthropic/claude-opus-5.5" },
    { name: "Claude Fable 5.1", value: "anthropic/claude-fable-5.1" },
    { name: "Claude Sonnet 5", value: "anthropic/claude-sonnet-5" },
    { name: "GPT-6 Sol", value: "openai/gpt-6-sol" },
    { name: "Qwen 3.8 27B", value: "qwen/qwen3.8-27b" },
  ],
  anthropic: [
    { name: "Claude Opus 5.5", value: "claude-opus-5-5" },
    { name: "Claude Fable 5.1", value: "claude-fable-5-1" },
    { name: "Claude Sonnet 5", value: "claude-sonnet-5" },
  ],
  openai: [
    { name: "GPT-6 Sol", value: "gpt-6-sol" },
    { name: "GPT-6 Sol Pro", value: "gpt-6-sol-pro" },
    { name: "GPT-6 Luna", value: "gpt-6-luna" },
    { name: "GPT-6 Astra", value: "gpt-6-astra" },
  ],
  ollama: [
    { name: "Gemma 4 31B", value: "gemma4:31b" },
    { name: "Qwen 3.6 35B", value: "qwen3.6:35b" },
    { name: "Qwen 3.5 27B", value: "qwen3.5:27b" },
    { name: "GPT-OSS 20B", value: "gpt-oss:20b" },
    { name: "Mistral Small 3.2 24B", value: "mistral-small3.2:24b" },
  ],
};

// Models to exclude from OpenRouter (embeddings, moderation, old versions, etc.)
const OPENROUTER_EXCLUDE = /embed|moderat|whisper|tts|dall-e|vision-preview/i;
const OPENROUTER_PREFERRED = /^(anthropic|openai|google|deepseek|meta-llama)\//;

interface HostedModel { id: string; display_name?: string; name?: string; created?: number; created_at?: string; context_length?: number }

/** Hosted catalogs are large and unordered; show the newest or most capable models first. Custom endpoints are never filtered. */
function shapeHostedCatalog(provider: string, models: HostedModel[]): HostedModel[] {
  switch (provider) {
    case "anthropic": return models.sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
    case "openai": return models.filter(m => /^(gpt-|o[0-9]|chatgpt)/.test(m.id) && !/instruct|audio|realtime|search|embed/i.test(m.id)).sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).slice(0, 15);
    case "openrouter": return models.filter(m => OPENROUTER_PREFERRED.test(m.id) && !OPENROUTER_EXCLUDE.test(m.id)).sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0)).slice(0, 20);
    default: return models;
  }
}

/** Model discovery uses the same connection as inference. */
export async function fetchModels(connection: ModelConnection, key?: string, embedding = false): Promise<{ name: string; value: string }[] | null> {
  const resolved = resolveModel({ ...configDefaults, ...connection, model: "discovery" });
  const headers: Record<string, string> = {};
  if (key && resolved.auth !== "none") {
    if (resolved.provider === "anthropic") headers["x-api-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  if (resolved.provider === "anthropic") headers["anthropic-version"] = "2023-06-01";
  try {
    const res = await fetch(`${resolved.baseURL}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json() as { data?: HostedModel[] };
    let models = (json.data ?? []).filter(m => typeof m.id === "string");
    if (!connection.baseURL && !embedding) models = shapeHostedCatalog(connection.provider, models);
    return models.map(m => ({ name: m.display_name || m.name || m.id, value: m.id }));
  } catch { return null; }
}

async function getModelChoices(connection: ModelConnection, key = "", embedding = false): Promise<{ name: string; value: string }[]> {
  print("  Fetching models...");
  const live = await fetchModels(connection, key, embedding);
  if (live?.length) return live;
  print("  Could not fetch models; you can enter a model ID manually");
  // Never suggest hosted IDs for a custom endpoint.
  return connection.baseURL || connection.provider === "openai-compatible" || embedding ? [] : FALLBACK_MODELS[connection.provider] || [];
}

async function chooseModel(connection: ModelConnection, key: string, current = "", embedding = false): Promise<string> {
  const choices = await getModelChoices(connection, key, embedding);
  if (current && !choices.some(c => c.value === current)) choices.unshift({ name: current, value: current });
  const manual = "__kern_manual__";
  const chosen = choices.length ? await select({ message: embedding ? "Embedding model" : "Model", choices: [...choices, { name: "Enter model ID manually", value: manual }], default: current || choices[0].value }) : manual;
  return chosen === manual ? input({ message: "Model ID", default: current, required: true }) : chosen;
}

/** Preserve unrelated variables, comments, and formatting, and quote new secrets correctly. */
export function mergeEnvText(text: string, updates: Record<string, string>): string {
  const pending = new Map(Object.entries(updates));
  const output: string[] = [];
  // dotenv permits quoted multiline values; preserve their entire source spans.
  const assignment = /(^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|[^\r\n]*)(?:[^\r\n]*))/gm;
  let cursor = 0;
  for (const match of text.matchAll(assignment)) {
    output.push(text.slice(cursor, match.index));
    const key = match[2];
    if (key in updates) {
      if (pending.has(key)) output.push(`${key}=${encodeEnvValue(updates[key])}`);
      pending.delete(key);
    } else output.push(match[0]);
    cursor = match.index! + match[0].length;
  }
  output.push(text.slice(cursor));
  let result = output.join("").replace(/\n*$/, "\n");
  for (const [key, value] of pending) result += `${key}=${encodeEnvValue(value)}\n`;
  return result;
}

function encodeEnvValue(value: string): string {
  if (!/[\s#'"`\\]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error("Secret contains all quote styles; set it directly in .kern/.env");
}

async function saveEnvUpdates(dir: string, updates: Record<string, string>, template = ""): Promise<void> {
  const path = join(dir, ".kern", ".env");
  const text = existsSync(path) ? await readFile(path, "utf-8") : template;
  await writeFile(path, mergeEnvText(text, updates));
}

interface ConnectionPrompt {
  connection: ModelConnection;
  apiKey: string;
  envVar: string;
}

async function promptConnection(current: Partial<KernConfig>, env: Record<string, string>): Promise<ConnectionPrompt> {
  const previous = configureConnection(connectionSettings(current), {});
  const provider = await select({ message: "Provider", choices: PROVIDERS.map(p => ({ name: p.name, value: p.value })), default: previous.provider });
  const same = provider === previous.provider;
  const custom = provider === "ollama" || provider === "openai-compatible" || (same && !!previous.baseURL);
  const baseURL = custom ? await input({ message: "API root URL (include /v1)", default: same && previous.baseURL ? previous.baseURL : provider === "ollama" ? "http://localhost:11434/v1" : "http://localhost:1234/v1", required: true }) : undefined;
  const connection = configureConnection(previous, { provider, baseURL });
  const resolved = resolveModel({ ...configDefaults, ...connection, model: "setup" });
  const defaultEnvVar = resolved.apiKeyEnv || API_KEY_ENV[provider];
  const authenticate = custom ? await select({ message: "Authentication", choices: [{ name: "None", value: false }, { name: "API key", value: true }], default: !!resolved.apiKeyEnv && resolved.auth !== "none" }) : true;
  const envVar = authenticate ? await input({ message: "API key environment variable", default: defaultEnvVar, required: true }) : defaultEnvVar;
  const currentKey = env[envVar] || "";
  const supplied = authenticate ? await password({ message: currentKey ? "API key (Enter to keep existing)" : "API key", mask: "*" }) : "";
  const apiKey = supplied || (authenticate ? currentKey : "");
  return { connection: configureConnection(connection, { apiKeyEnv: authenticate ? envVar : undefined, auth: authenticate ? undefined : "none" }), apiKey, envVar };
}

async function promptEmbedding(config: KernConfig, env: Record<string, string>): Promise<{ ref: ModelRef | false; updates: Record<string, string> }> {
  const selection = await select({ message: "Embeddings for memory", choices: [{ name: "Keep current / provider default", value: "keep" }, { name: "Choose model on this connection", value: "same" }, { name: "Use another connection", value: "other" }, { name: "Disable", value: "off" }] });
  if (selection === "keep") return { ref: config.embeddingModel, updates: {} };
  if (selection === "off") return { ref: false, updates: {} };
  if (selection === "same") {
    const connection = resolveModel(config);
    const ref = await chooseModel(connection, connection.apiKeyEnv ? env[connection.apiKeyEnv] || "" : "", typeof config.embeddingModel === "string" ? config.embeddingModel : "", true);
    return { ref, updates: {} };
  }
  const prompt = await promptConnection({}, env);
  const model = await chooseModel(prompt.connection, prompt.apiKey, "", true);
  return { ref: { ...prompt.connection, model }, updates: prompt.apiKey ? { [prompt.envVar]: prompt.apiKey } : {} };
}

const PROVIDERS = [
  { name: "OpenRouter", value: "openrouter", keyLabel: "OpenRouter API key" },
  { name: "Anthropic", value: "anthropic", keyLabel: "Anthropic API key" },
  { name: "OpenAI", value: "openai", keyLabel: "OpenAI API key" },
  { name: "Ollama (local)", value: "ollama", keyLabel: "Ollama API key" },
  { name: "OpenAI-compatible server (local / gateway)", value: "openai-compatible", keyLabel: "Server API key" },
];

export const API_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: "OLLAMA_API_KEY",
  "openai-compatible": "LOCAL_MODEL_API_KEY",
};

function print(text: string) {
  console.log(text);
}

async function runConfig(dir: string): Promise<void> {
  await migrateAgentFiles(dir);
  // Load existing config and env
  let currentConfig: Partial<KernConfig> = {};
  try {
    currentConfig = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8"));
  } catch {}
  const name = currentConfig.name || basename(dir);

  print("");
  print(`  kern config — ${name}`);
  print(`  ${dir}`);
  print("");

  const envPath = join(dir, ".kern", ".env");
  const currentEnv = existsSync(envPath) ? parseEnv(await readFile(envPath, "utf-8")) : {};
  const { connection, apiKey, envVar } = await promptConnection(currentConfig, currentEnv);
  const model = await chooseModel(connection, apiKey, currentConfig.model || "");
  const pendingConfig = { ...configDefaults, ...configureConnection(currentConfig, connection), model };
  const embedding = await promptEmbedding(pendingConfig, { ...currentEnv, [envVar]: apiKey });

  // Telegram
  const currentTgToken = currentEnv["TELEGRAM_BOT_TOKEN"];
  const maskedTg = currentTgToken ? `****${currentTgToken.slice(-4)}` : "";
  const tgMsg = maskedTg ? `Telegram bot token (${maskedTg}, enter to keep)` : "Telegram bot token";
  const telegramToken = await password({
    message: tgMsg,
    mask: "*",
  });

  // Slack
  const currentSlackBot = currentEnv["SLACK_BOT_TOKEN"];
  const maskedSlackBot = currentSlackBot ? `****${currentSlackBot.slice(-4)}` : "";
  const slackBotMsg = maskedSlackBot ? `Slack bot token (${maskedSlackBot}, enter to keep)` : "Slack bot token (xoxb-...)";
  const slackBotToken = await password({
    message: slackBotMsg,
    mask: "*",
  });

  const currentSlackApp = currentEnv["SLACK_APP_TOKEN"];
  const maskedSlackApp = currentSlackApp ? `****${currentSlackApp.slice(-4)}` : "";
  let slackAppToken = "";
  if (slackBotToken || currentSlackBot) {
    const slackAppMsg = maskedSlackApp ? `Slack app token (${maskedSlackApp}, enter to keep)` : "Slack app token (xapp-...)";
    slackAppToken = await password({
      message: slackAppMsg,
      mask: "*",
    });
  }

  // Build new config (keep the sticky port and any other fields as they are)
  const config = configureConnection({
    ...currentConfig,
    name,
    model,
    embeddingModel: embedding.ref,
    toolScope: currentConfig.toolScope || "full",
  }, connection);
  const updates: Record<string, string> = { ...embedding.updates };
  if (apiKey) updates[envVar] = apiKey;
  if (telegramToken) updates.TELEGRAM_BOT_TOKEN = telegramToken;
  if (slackBotToken) updates.SLACK_BOT_TOKEN = slackBotToken;
  if (slackAppToken) updates.SLACK_APP_TOKEN = slackAppToken;
  resolveConfig(config, { ...process.env, ...currentEnv, ...updates });
  await writeFile(join(dir, ".kern", "config.json"), serializeConfig(config));
  await saveEnvUpdates(dir, updates);
  print("");
  print("  ✓ Config updated");

  // Restart if running, otherwise start
  if (await readLivePid(dir)) {
    await stopAgent(dir);
  }

  print("  ✓ Starting...");
  print("");
  await startAgent(dir);
}

/**
 * Where `kern init [path]` scaffolds: `path` as given (default `.`), or
 * `./<name>` when a bare name is given and no such directory exists.
 */
export function resolveInitDir(targetArg?: string): string {
  return resolve(targetArg ?? ".");
}

export async function runInit(targetArg?: string, flags?: Record<string, string>): Promise<void> {
  const dir = resolveInitDir(targetArg);

  // Existing agent (has .kern/) — go straight to config. A directory that only
  // has AGENTS.md is adopted by the scaffold below.
  if (!flags && isAgentDir(dir)) {
    await runConfig(dir);
    return;
  }

  // Non-interactive mode
  if (flags && Object.keys(flags).length) {
    const name = basename(dir);

    await migrateAgentFiles(dir);
    const configPath = join(dir, ".kern", "config.json");
    const previous = configureConnection<Partial<KernConfig>>(existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf-8")) : {}, {});
    const envPath = join(dir, ".kern", ".env");
    const env = { ...process.env, ...(existsSync(envPath) ? parseEnv(await readFile(envPath, "utf-8")) : {}) };
    const provider = flags.provider || previous.provider;
    const apiKey = flags["api-key"] || "";
    const envVar = flags["api-key-env"] || (provider === previous.provider ? previous.apiKeyEnv : undefined) || API_KEY_ENV[provider];
    const connection = configureConnection(previous, {
      provider,
      baseURL: flags["base-url"],
      api: flags.api as "chat" | "responses" | undefined,
      ...(apiKey || flags["api-key-env"] ? { apiKeyEnv: envVar } : {}),
    });
    let model = flags.model || (provider === previous.provider ? previous.model : undefined);
    if (!model) {
      const choices = await getModelChoices(connection, apiKey || env[envVar] || "");
      model = choices[0]?.value || (!connection.baseURL ? DEFAULT_PROVIDER_MODELS[provider] : undefined);
      if (!model) throw new Error("This connection requires --model with a model ID hosted by the server");
    }
    const telegramToken = flags["telegram-token"] || "";
    const slackBotToken = flags["slack-bot-token"] || "";
    const slackAppToken = flags["slack-app-token"] || "";

    await scaffoldAgent({
      name, dir, provider, model, apiKey, envVar, connection,
      embeddingModel: flags["embedding-model"] === "off" ? false : flags["embedding-model"],
      summaryModel: flags["summary-model"],
      telegramToken, slackBotToken, slackAppToken,
    });
    return;
  }

  // Interactive mode
  print("");
  print("  kern init");
  print("");

  // Agent name
  const name = await input({
    message: "Agent name",
    default: basename(dir),
    required: true,
  });

  const { connection, apiKey, envVar } = await promptConnection({}, {});
  const provider = connection.provider;
  const model = await chooseModel(connection, apiKey);
  const embedding = await promptEmbedding({ ...configDefaults, ...connection, model }, { [envVar]: apiKey });

  // Telegram bot token (optional)
  const telegramToken = await password({
    message: "Telegram bot token (optional)",
    mask: "*",
  });

  // Slack (optional)
  const slackBotToken = await password({
    message: "Slack bot token (optional, xoxb-...)",
    mask: "*",
  });

  let slackAppToken = "";
  if (slackBotToken) {
    slackAppToken = await password({
      message: "Slack app token (xapp-...)",
      mask: "*",
    });
  }

  await scaffoldAgent({
    name, dir, provider, model, apiKey, envVar, connection, embeddingModel: embedding.ref,
    extraEnv: embedding.updates,
    telegramToken, slackBotToken, slackAppToken,
  });
}

export interface ScaffoldOpts {
  connection?: Partial<ModelConnection>;
  embeddingModel?: ModelRef | false;
  summaryModel?: ModelRef;
  extraEnv?: Record<string, string>;
  name: string;
  dir: string;
  provider: string;
  model: string;
  apiKey: string;
  envVar: string;
  telegramToken: string;
  slackBotToken: string;
  slackAppToken: string;
  matrixHomeserver?: string;
  matrixUserId?: string;
  matrixAccessToken?: string;
  discordToken?: string;
  nostrNsec?: string;
  nostrRelays?: string;
  ircUrl?: string;
  skipStart?: boolean;
}

export async function scaffoldAgent(opts: ScaffoldOpts): Promise<void> {
  const {
    name, dir, provider, model, apiKey, envVar,
    telegramToken, slackBotToken, slackAppToken,
    matrixHomeserver, matrixUserId, matrixAccessToken,
    discordToken, nostrNsec, nostrRelays, ircUrl,
    skipStart,
  } = opts;

  const dirExists = existsSync(dir);
  await migrateAgentFiles(dir);
  print("");
  print(dirExists ? `  Adding kern to ${dir}/...` : `  Creating ${dir}/...`);

  // Create directories
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "knowledge"), { recursive: true });
  await mkdir(join(dir, "notes"), { recursive: true });
  await mkdir(join(dir, ".kern", "sessions"), { recursive: true });

  // Load bundled templates
  const templatesDir = join(import.meta.dirname, "..", "templates");
  const agentsMd = await readFile(join(templatesDir, "AGENTS.md"), "utf-8");
  const identityMd = await readFile(join(templatesDir, "IDENTITY.md"), "utf-8");
  const knowledgeMd = await readFile(join(templatesDir, "KNOWLEDGE.md"), "utf-8");
  const usersMd = await readFile(join(templatesDir, "USERS.md"), "utf-8");

  // .kern/config.json — no port yet: the first start assigns one from live
  // state, so two agents scaffolded while nothing runs don't both get 4100
  const configPath = join(dir, ".kern", "config.json");
  const previous = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf-8")) : {};
  const config = configureConnection({
    ...previous, version: previous.version ?? PACKAGE_VERSION,
    name: previous.name ?? name, model, toolScope: previous.toolScope || "full",
    ...(opts.embeddingModel !== undefined ? { embeddingModel: opts.embeddingModel } : {}),
    ...(opts.summaryModel !== undefined ? { summaryModel: opts.summaryModel } : {}),
  }, { provider, ...opts.connection, ...(apiKey ? { apiKeyEnv: opts.connection?.apiKeyEnv ?? envVar } : {}) });
  const envPath = join(dir, ".kern", ".env");
  const env = { ...process.env, ...(existsSync(envPath) ? parseEnv(await readFile(envPath, "utf-8")) : {}), ...opts.extraEnv, ...(apiKey ? { [envVar]: apiKey } : {}) };
  resolveConfig(config, env);
  // .kern/.env — a fresh file lists the common secrets as commented placeholders
  const tokens: Record<string, string | undefined> = {
    [envVar]: apiKey, TELEGRAM_BOT_TOKEN: telegramToken, SLACK_BOT_TOKEN: slackBotToken, SLACK_APP_TOKEN: slackAppToken,
    MATRIX_HOMESERVER: matrixHomeserver, MATRIX_USER_ID: matrixUserId, MATRIX_ACCESS_TOKEN: matrixAccessToken,
    DISCORD_TOKEN: discordToken, NOSTR_NSEC: nostrNsec, NOSTR_RELAYS: nostrRelays, IRC_URL: ircUrl, ...opts.extraEnv,
  };
  const envUpdates = Object.fromEntries(Object.entries(tokens).filter((entry): entry is [string, string] => !!entry[1]));
  const envTemplate = [envVar, "TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"].filter(key => !envUpdates[key]).map(key => `# ${key}=\n`).join("");

  // .gitignore
  const gitignore = `.kern/.env
.kern/agent.pid
.kern/sessions/
.kern/media/
.kern/logs/
.kern/backups/
.kern/*.db
node_modules/
`;

  // Write files — only create if they don't exist (except .kern/ which always gets written)
  if (!existsSync(join(dir, "AGENTS.md"))) {
    await writeFile(join(dir, "AGENTS.md"), agentsMd);
    print("  + AGENTS.md");
  } else {
    print("  ○ AGENTS.md (exists)");
  }

  if (!existsSync(join(dir, "IDENTITY.md"))) {
    await writeFile(join(dir, "IDENTITY.md"), identityMd);
    print("  + IDENTITY.md");
  } else {
    print("  ○ IDENTITY.md (exists)");
  }

  if (!existsSync(join(dir, "KNOWLEDGE.md"))) {
    await writeFile(join(dir, "KNOWLEDGE.md"), knowledgeMd);
    print("  + KNOWLEDGE.md");
  } else {
    print("  ○ KNOWLEDGE.md (exists)");
  }

  if (!existsSync(join(dir, "USERS.md"))) {
    await writeFile(join(dir, "USERS.md"), usersMd);
    print("  + USERS.md");
  } else {
    print("  ○ USERS.md (exists)");
  }

  // .kern/ config always written (new agent or adopt)
  await writeFile(join(dir, ".kern", "config.json"), serializeConfig(config));
  print("  + .kern/config.json");

  await saveEnvUpdates(dir, envUpdates, envTemplate);
  print("  + .kern/.env");

  if (!existsSync(join(dir, ".gitignore"))) {
    await writeFile(join(dir, ".gitignore"), gitignore);
    print("  + .gitignore");
  } else {
    print("  ○ .gitignore (exists)");
  }

  // Git init only for new repos
  if (!existsSync(join(dir, ".git"))) {
    const { execSync } = await import("child_process");
    try {
      execSync("git init", { cwd: dir, stdio: "ignore" });
      execSync("git add -A", { cwd: dir, stdio: "ignore" });
      execSync('git commit -m "initial agent setup"', { cwd: dir, stdio: "ignore" });
      print("  + git init + first commit");
    } catch {
      print("  (git init skipped)");
    }
  } else {
    print("  ○ git repo (exists)");
  }

  if (!skipStart) {
    print("");
    print("  ✓ Starting...");
    print("");
    await startAgent(dir);
    const rel = relative(resolve("."), dir);
    const here = rel === "" ? "" : ` ${rel.startsWith("..") ? dir : rel}/`;
    print("");
    print("  Next steps:");
    print(`    \x1b[36mkern tui${here}\x1b[0m            terminal chat`);
    print(`    \x1b[36mkern web start\x1b[0m      browser chat`);
    print(`    \x1b[36mkern status${here}\x1b[0m         agent status`);
    print("");
  }
}
