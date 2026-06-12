import { mkdir, writeFile, readFile } from "fs/promises";
import { join, resolve, basename } from "path";
import { existsSync } from "fs";
import { input, select, password } from "@inquirer/prompts";
import { registerAgent, findAgent, isProcessRunning, readPid, removePidFile, assignPort } from "./registry.js";
import { startAgent } from "./daemon.js";
import type { KernConfig } from "./config.js";
import { log } from "./log.js";

// Fallback models used when live fetch fails (e.g. no network, bad key)
const FALLBACK_MODELS: Record<string, { name: string; value: string }[]> = {
  openrouter: [
    { name: "Claude Opus 4.8", value: "anthropic/claude-opus-4.8" },
    { name: "Claude Fable 5", value: "anthropic/claude-fable-5" },
    { name: "Claude Sonnet 4.6", value: "anthropic/claude-sonnet-4.6" },
    { name: "GPT-5.5", value: "openai/gpt-5.5" },
    { name: "Gemini 3.5 Flash", value: "google/gemini-3.5-flash" },
  ],
  anthropic: [
    { name: "Claude Opus 4.8", value: "claude-opus-4-8" },
    { name: "Claude Fable 5", value: "claude-fable-5" },
    { name: "Claude Sonnet 4.6", value: "claude-sonnet-4-6" },
  ],
  openai: [
    { name: "GPT-5.5", value: "gpt-5.5" },
    { name: "GPT-5.5 Pro", value: "gpt-5.5-pro" },
    { name: "GPT-5.4 Mini", value: "gpt-5.4-mini" },
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

async function fetchModels(
  provider: string,
  apiKey: string,
): Promise<{ name: string; value: string }[] | null> {
  try {
    let url: string;
    const headers: Record<string, string> = {};

    switch (provider) {
      case "anthropic":
        url = "https://api.anthropic.com/v1/models";
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
        break;
      case "openrouter":
        url = "https://openrouter.ai/api/v1/models";
        // OpenRouter doesn't require auth for model listing
        break;
      case "openai":
        url = "https://api.openai.com/v1/models";
        headers["Authorization"] = `Bearer ${apiKey}`;
        break;
      case "ollama":
        url = `${apiKey || "http://localhost:11434"}/api/tags`;
        break;
      default:
        return null;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;

    const json: any = await res.json();
    const models: any[] = json.data || [];

    if (provider === "anthropic") {
      // Anthropic returns { id, display_name, created_at }
      // Sort by created_at descending (newest first)
      return models
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .map((m) => ({ name: m.display_name || m.id, value: m.id }));
    }

    if (provider === "openrouter") {
      // OpenRouter returns thousands of models — filter to well-known providers
      // and sort by context length (proxy for capability)
      const preferred = ["anthropic/", "openai/", "google/", "deepseek/", "meta-llama/"];
      return models
        .filter((m) => preferred.some((p) => m.id.startsWith(p)) && !OPENROUTER_EXCLUDE.test(m.id))
        .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
        .slice(0, 20)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
        .map((m) => ({ name: m.name || m.id, value: m.id }));
    }

    if (provider === "openai") {
      // OpenAI returns all models including fine-tunes, embeddings, etc.
      // Filter to chat-capable models
      const chatModels = models
        .filter((m) => /^(gpt-|o[0-9]|chatgpt)/.test(m.id) && !/instruct|audio|realtime|search/i.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .slice(0, 15);
      return chatModels.map((m) => ({ name: m.id, value: m.id }));
    }

    if (provider === "ollama") {
      // Ollama /api/tags returns { models: [{ name, size, ... }] }
      const ollamaModels: any[] = json.models || [];
      if (ollamaModels.length === 0) return null;
      return ollamaModels
        .sort((a, b) => (b.size || 0) - (a.size || 0))
        .map((m) => ({ name: m.name, value: m.name }));
    }

    return null;
  } catch {
    return null;
  }
}

async function getModelChoices(
  provider: string,
  apiKey: string,
): Promise<{ name: string; value: string }[]> {
  // Ollama always tries to fetch (URL is the key), others need an API key
  if (apiKey || provider === "ollama") {
    print("  Fetching models...");
    const live = await fetchModels(provider, apiKey);
    if (live && live.length > 0) return live;
    print("  Could not fetch models, using defaults");
  }
  return FALLBACK_MODELS[provider] || FALLBACK_MODELS.openrouter;
}

const PROVIDERS = [
  { name: "OpenRouter", value: "openrouter", keyLabel: "OpenRouter API key" },
  { name: "Anthropic", value: "anthropic", keyLabel: "Anthropic API key" },
  { name: "OpenAI", value: "openai", keyLabel: "OpenAI API key" },
  { name: "Ollama (local)", value: "ollama", keyLabel: "Ollama server URL" },
];

export const API_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: "OLLAMA_BASE_URL",
};

function print(text: string) {
  console.log(text);
}

async function runConfig(name: string, dir: string): Promise<void> {
  print("");
  print(`  kern config — ${name}`);
  print("");

  // Load existing config and env
  let currentConfig: Partial<KernConfig> = {};
  try {
    currentConfig = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8"));
  } catch {}

  let currentEnv: Record<string, string> = {};
  try {
    const envContent = await readFile(join(dir, ".kern", ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      if (line.trim() && !line.startsWith("#")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          currentEnv[line.slice(0, eq)] = line.slice(eq + 1);
        }
      }
    }
  } catch {}

  // Provider
  const provider = await select({
    message: "Provider",
    choices: PROVIDERS.map((p) => ({ name: p.name, value: p.value })),
    default: currentConfig.provider || "openrouter",
  });

  // API key or URL
  const providerInfo = PROVIDERS.find((p) => p.value === provider)!;
  const envVar = API_KEY_ENV[provider];
  const currentKey = currentEnv[envVar];
  const maskedKey = currentKey ? `****${currentKey.slice(-4)}` : "";

  let apiKey: string;
  if (provider === "ollama") {
    // Ollama needs a server URL, not an API key
    apiKey = await input({
      message: "Ollama server URL",
      default: currentKey || "http://localhost:11434",
    });
  } else {
    const apiKeyMsg = maskedKey ? `${providerInfo.keyLabel} (${maskedKey}, enter to keep)` : providerInfo.keyLabel;
    apiKey = await password({
      message: apiKeyMsg,
      mask: "*",
    });
  }

  // Model — fetch live from provider, fall back to defaults
  const keyForFetch = !apiKey ? currentKey : apiKey;
  const modelChoices = await getModelChoices(provider, keyForFetch || "");
  const currentModel = currentConfig.model || modelChoices[0].value;
  const model = await select({
    message: "Model",
    choices: modelChoices,
    default: currentModel,
  });

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

  // Build new config
  const config: Partial<KernConfig> = {
    name,
    model,
    provider,
    toolScope: currentConfig.toolScope || "full",
  };
  // Build new env
  const envLines: string[] = [];
  const actualKey = !apiKey ? currentKey : apiKey;
  if (actualKey) {
    envLines.push(`${envVar}=${actualKey}`);
  } else {
    envLines.push(`# ${envVar}=`);
  }
  const actualTg = !telegramToken ? currentTgToken : telegramToken;
  if (actualTg) {
    envLines.push(`TELEGRAM_BOT_TOKEN=${actualTg}`);
  } else {
    envLines.push(`# TELEGRAM_BOT_TOKEN=`);
  }
  const actualSlackBot = !slackBotToken ? currentSlackBot : slackBotToken;
  if (actualSlackBot) {
    envLines.push(`SLACK_BOT_TOKEN=${actualSlackBot}`);
  } else {
    envLines.push(`# SLACK_BOT_TOKEN=`);
  }
  const actualSlackApp = !slackAppToken ? currentSlackApp : slackAppToken;
  if (actualSlackApp) {
    envLines.push(`SLACK_APP_TOKEN=${actualSlackApp}`);
  } else {
    envLines.push(`# SLACK_APP_TOKEN=`);
  }

  // Write
  await writeFile(join(dir, ".kern", "config.json"), JSON.stringify(config, null, 2) + "\n");
  await writeFile(join(dir, ".kern", ".env"), envLines.join("\n") + "\n");
  print("");
  print("  ✓ Config updated");

  // Restart if running, otherwise start
  const agent = findAgent(name);
  if (agent) {
    const pid = readPid(agent.path);
    if (pid && isProcessRunning(pid)) {
      process.kill(pid, "SIGTERM");
      await removePidFile(agent.path);
      print("  ✓ Stopped");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  print("  ✓ Starting...");
  print("");
  await startAgent(name);
}

export async function runInit(targetArg?: string, flags?: Record<string, string>): Promise<void> {
  // Check if target is an existing agent — go straight to config
  if (targetArg && !flags) {
    const registered = findAgent(targetArg);
    const dir = registered ? registered.path : resolve(targetArg);
    if (existsSync(dir) && (existsSync(join(dir, "AGENTS.md")) || existsSync(join(dir, ".kern")))) {
      await runConfig(registered?.name || targetArg, dir);
      return;
    }
  }

  // Non-interactive mode
  if (flags && flags["api-key"]) {
    const name = targetArg;
    if (!name) {
      console.error("Usage: kern init <name> --api-key <key>");
      process.exit(1);
    }

    const provider = flags.provider || "openrouter";
    const apiKey = flags["api-key"];
    let model = flags.model;
    if (!model) {
      const choices = await getModelChoices(provider, apiKey);
      model = choices[0]?.value || "anthropic/claude-opus-4.8";
    }
    const envVar = API_KEY_ENV[provider] || "OPENROUTER_API_KEY";
    const telegramToken = flags["telegram-token"] || "";
    const slackBotToken = flags["slack-bot-token"] || "";
    const slackAppToken = flags["slack-app-token"] || "";
    const dir = resolve(name);

    await scaffoldAgent({
      name, dir, provider, model, apiKey, envVar,
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
    default: targetArg,
    required: true,
  });

  const dir = resolve(targetArg || name);

  // Provider
  const provider = await select({
    message: "Provider",
    choices: PROVIDERS.map((p) => ({ name: p.name, value: p.value })),
    default: "openrouter",
  });

  // API key
  const providerInfo = PROVIDERS.find((p) => p.value === provider)!;
  const envVar = API_KEY_ENV[provider];
  const apiKey = await password({
    message: providerInfo.keyLabel,
    mask: "*",
  });

  // Model — fetch live from provider, fall back to defaults
  const modelChoices = await getModelChoices(provider, apiKey);
  const model = await select({
    message: "Model",
    choices: modelChoices,
    default: modelChoices[0].value,
  });

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
    name, dir, provider, model, apiKey, envVar,
    telegramToken, slackBotToken, slackAppToken,
  });
}

export interface ScaffoldOpts {
  name: string;
  dir: string;
  provider: string;
  model: string;
  apiKey: string;
  envVar: string;
  telegramToken: string;
  slackBotToken: string;
  slackAppToken: string;
  skipStart?: boolean;
}

export async function scaffoldAgent(opts: ScaffoldOpts): Promise<void> {
  const { name, dir, provider, model, apiKey, envVar, telegramToken, slackBotToken, slackAppToken, skipStart } = opts;

  const dirExists = existsSync(dir);
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

  // .kern/config.json
  const config: Partial<KernConfig> = {
    name,
    model,
    provider,
    toolScope: "full",
    port: await assignPort(),
  };
  // .kern/.env
  const envLines: string[] = [];
  if (apiKey) {
    envLines.push(`${envVar}=${apiKey}`);
  } else {
    envLines.push(`# ${envVar}=`);
  }
  if (telegramToken) {
    envLines.push(`TELEGRAM_BOT_TOKEN=${telegramToken}`);
  } else {
    envLines.push(`# TELEGRAM_BOT_TOKEN=`);
  }
  if (slackBotToken) {
    envLines.push(`SLACK_BOT_TOKEN=${slackBotToken}`);
  } else {
    envLines.push(`# SLACK_BOT_TOKEN=`);
  }
  if (slackAppToken) {
    envLines.push(`SLACK_APP_TOKEN=${slackAppToken}`);
  } else {
    envLines.push(`# SLACK_APP_TOKEN=`);
  }

  // .gitignore
  const gitignore = `.kern/.env
.kern/agent.pid
.kern/sessions/
.kern/media/
.kern/logs/
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
  await writeFile(join(dir, ".kern", "config.json"), JSON.stringify(config, null, 2) + "\n");
  print("  + .kern/config.json");

  await writeFile(join(dir, ".kern", ".env"), envLines.join("\n") + "\n");
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

  // Register and start
  await registerAgent(dir);

  if (!skipStart) {
    print("");
    print("  ✓ Starting...");
    print("");
    await startAgent(name);
    print("");
    print("  Next steps:");
    print(`    \x1b[36mkern tui\x1b[0m            terminal chat`);
    print(`    \x1b[36mkern web start\x1b[0m      browser chat`);
    print(`    \x1b[36mkern install ${name}\x1b[0m     auto-restart + boot persistence (systemd)`);
    print("");
  }
}

