import { DiscordInterface } from "./interfaces/discord.js";
import { Runtime, type StreamEvent } from "./runtime.js";
import { updateKernel } from "./kernel.js";
import { TelegramInterface } from "./interfaces/telegram.js";
import { SlackInterface } from "./interfaces/slack.js";
import { MatrixInterface } from "./interfaces/matrix.js";
import { NostrInterface, parseRelayList } from "./interfaces/nostr.js";
import { IrcInterface, parseIrcUrls } from "./interfaces/irc.js";
import { CliInterface } from "./interfaces/cli.js";
import { loadConfig, saveConfigField, type KernConfig } from "./config.js";
import { isRoot, isSystemManaged } from "./global-config.js";
import { readFile, appendFile } from "fs/promises";
import { join, basename } from "path";
import { randomBytes } from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import type { Interface, MessageHandler } from "./interfaces/types.js";
import type { TurnOrigin } from "./plugins/types.js";
import { registerAgent, writePidFile, removePidFile, assignPort } from "./registry.js";
import { AgentServer } from "./server.js";
import { PairingManager } from "./pairing.js";
import { setMessageSender } from "./tools/message.js";
import { setIrcInterface } from "./plugins/irc/tools.js";
import { SegmentIndex } from "./segments.js";
import { MemoryDB } from "./memory.js";
import { MessageQueue, type QueuedMessage } from "./queue.js";
import { getStatusData as getStatusDataFn, setQueueStatusFn, setInterfaceStatusFn, setSegmentStatsFn, setPluginStatusFn, type InterfaceStatus } from "./tools/kern.js";
import { plugins, type PluginContext } from "./plugins/index.js";
import { setSubAgentAnnouncer, formatAnnounce } from "./plugins/subagents/plugin.js";
import { formatLocalISO, resolveHostTimezone } from "./util.js";
import { log } from "./log.js";

let _pluginCtx: PluginContext | null = null;
let _runtime: Runtime | null = null;
let _config: KernConfig | null = null;

async function handleSlashCommand(cmd: string, userId: string, iface: string, agentName: string, agentDir: string): Promise<string | null> {
  switch (cmd) {
    case "/restart": {
      log("kern", `restart requested by ${userId} via ${iface}`);
      // If running inside systemd, exit cleanly with 0 and let systemd Restart=always bring it back up
      if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) {
        setTimeout(() => process.exit(0), 100);
        return "Restart initiated.";
      }
      // Managed host, but started with `kern start`: the agent runs as its own
      // user and `kern restart` requires root there. Nothing would relaunch us
      // after exit either, so say so instead of failing with an authority error.
      if (isSystemManaged() && !isRoot()) {
        return `Restart from chat is unavailable for agents started with \`kern start\` on a managed host.\n` +
          `Run \`sudo kern restart ${agentName}\`, or \`sudo kern install ${agentName}\` so systemd supervises it.`;
      }
      // Re-exec the same runtime that is running us. Spawning a bare `kern`
      // depends on PATH, which is not guaranteed for the agent's environment.
      const { spawn } = await import("child_process");
      const kernEntry = join(import.meta.dirname, "index.js");
      const child = spawn(process.execPath, ["--no-deprecation", kernEntry, "restart", agentName], { stdio: "pipe" });

      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        child.on("close", (code) => resolve({ code, stderr: stderr.trim() }));
        child.on("error", (err) => resolve({ code: 1, stderr: err.message }));
      });

      if (result.code === 0) {
        return "Restart initiated.";
      }

      return `Restart failed: ${result.stderr || `exit code ${result.code}`}`;
    }

    case "/status": {
      const { formatStatus } = await import("./tools/kern.js");
      return formatStatus(getStatusDataFn());
    }

    case "/wyd": {
      const snapshot = _runtime?.getCurrentTurnSnapshot();
      if (!snapshot) {
        return "> Idle — waiting for input.";
      }
      if (_config) {
        const { narrateTurnStatus } = await import("./narration.js");
        return await narrateTurnStatus("wyd", snapshot, _config);
      }
      const { buildFallbackNarration } = await import("./narration.js");
      return buildFallbackNarration("wyd", snapshot);
    }

    case "/plugins": {
      if (!_pluginCtx) return "```yaml\nplugins: {}\n```";
      const status = plugins.collectStatus(_pluginCtx);
      const lines = ["```yaml", "plugins:"];
      for (const [name, val] of Object.entries(status)) {
        if (typeof val === "object" && val !== null) {
          lines.push(`  ${name}:`);
          for (const [subKey, subVal] of Object.entries(val)) {
            const formatted = typeof subVal === "string" ? subVal : JSON.stringify(subVal);
            lines.push(`    ${subKey}: ${formatted}`);
          }
        } else {
          const formatted = typeof val === "string" ? val : JSON.stringify(val);
          lines.push(`  ${name}: ${formatted}`);
        }
      }
      lines.push("```");
      return lines.join("\n");
    }

    case "/help": {
      const cmds: Record<string, string> = {
        status: "show agent status, uptime, token usage",
        wyd: "show what the agent is currently working on",
        plugins: "show detailed plugin status and metrics",
        restart: "restart the agent process",
      };
      const pluginCmds = plugins.collectCommandDescriptions();
      for (const [cmd, desc] of Object.entries(pluginCmds)) {
        const cleanCmd = cmd.replace(/^\//, "");
        cmds[cleanCmd] = desc;
      }
      cmds["help"] = "show this help";

      const lines = ["```yaml", "commands:"];
      for (const [name, desc] of Object.entries(cmds)) {
        lines.push(`  ${name}: ${desc}`);
      }
      lines.push("```");
      return lines.join("\n");
    }

    default: {
      // Check plugin commands before falling through to LLM
      const pluginCmd = plugins.getCommand(cmd);
      if (pluginCmd) return pluginCmd.handler(_pluginCtx!);
      return null;
    }
  }
}

export async function startApp(agentDir: string, forceCli = false): Promise<void> {
  // Update kernel if newer version available
  await updateKernel(agentDir);

  const config = await loadConfig(agentDir);

  // Auto-generate auth token if missing
  if (!process.env.KERN_AUTH_TOKEN) {
    const envPath = join(agentDir, ".kern", ".env");
    let existingToken: string | null = null;
    try {
      const envContent = await readFile(envPath, "utf-8");
      const match = envContent.match(/^KERN_AUTH_TOKEN=(.+)$/m);
      if (match) existingToken = match[1].trim();
    } catch {}

    if (existingToken) {
      process.env.KERN_AUTH_TOKEN = existingToken;
    } else {
      const token = randomBytes(16).toString("hex");
      await appendFile(envPath, `\nKERN_AUTH_TOKEN=${token}\n`);
      process.env.KERN_AUTH_TOKEN = token;
      log("kern", `generated auth token: ${token.slice(0, 8)}...`);
    }
  }

  const runtime = new Runtime(agentDir);
  _runtime = runtime;
  _config = config;

  // Probe embedding model dimensions before creating DB
  const embeddingDims = await MemoryDB.detectEmbeddingDimensions(config);

  // Initialize memory DB before runtime.init() so media sidecar can backfill
  const memoryDB = new MemoryDB(agentDir, embeddingDims);
  runtime.setMemoryDB(memoryDB);

  await runtime.init();

  // Initialize semantic segments (uses embeddings for context summarization)
  let segmentIndex: SegmentIndex | null = null;
  let segmentRunning = false;
  if (embeddingDims > 0) {
    try {
      segmentIndex = new SegmentIndex(memoryDB, config);
      runtime.setSegmentIndex(segmentIndex);
      setSegmentStatsFn(() => segmentIndex ? segmentIndex.getStats() : null);
    } catch (err: any) {
      log.error("segments", `init failed: ${err.message} — segments disabled`);
    }
  }

  // Auto-migrate name into config if missing
  if (!config.name) {
    config.name = basename(agentDir);
    await saveConfigField(agentDir, "name", config.name);
    log("kern", `assigned name: ${config.name}`);
  }

  const agentName = config.name;
  process.chdir(agentDir);

  // Resolve envelope timezone once. Config override (IANA string) wins, else
  // autoresolve to host. Storage everywhere else stays UTC — this only affects
  // the human-readable `time:` field the model reads in each envelope.
  const envelopeTimezone = config.timezone || resolveHostTimezone();
  log("kern", `envelope timezone: ${envelopeTimezone}`);

  // Initialize pairing
  const pairing = new PairingManager(agentDir);
  await pairing.load();

  // Pass pairing manager to runtime so kern tool can use it
  runtime.setPairingManager(pairing);

  // Log + start
  let version = "unknown";
  try {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf-8"));
    version = pkg.version;
  } catch {}
  const hb = config.heartbeatInterval > 0 ? `, heartbeat:${config.heartbeatInterval}min` : "";
  log("kern", `starting ${agentName} — v${version}, ${config.model}, tools:${config.toolScope}${hb}`);

  // Start HTTP server
  const server = new AgentServer();
  server.setAgentDir(agentDir);

  // Origin of the turn currently being processed, scoped to the turn's async
  // context. Read by plugins (via ctx.origin()) when they spawn async work so
  // its completion can be routed back to the same conversation. Async-local
  // rather than a module variable so a turn abandoned by the idle timeout
  // (which keeps running) can neither read nor clobber the next turn's origin.
  const turnOrigin = new AsyncLocalStorage<TurnOrigin>();
  // Real implementation installed once the queue and interfaces exist.
  let announceImpl: (text: string, origin: TurnOrigin) => Promise<string> = async () => {
    throw new Error("announce not available before startup completes");
  };

  // Load plugins
  const pluginCtx: PluginContext = {
    agentDir,
    config,
    db: memoryDB,
    sessionId: () => runtime.getSessionId(),
    origin: () => turnOrigin.getStore() ?? null,
    announce: (text, origin) => announceImpl(text, origin),
  };
  _pluginCtx = pluginCtx;
  const loadedPlugins = await plugins.load(pluginCtx);
  setPluginStatusFn(() => plugins.collectStatus(pluginCtx));

  // Register plugin tools and descriptions with runtime
  const pluginTools = plugins.collectTools();
  if (Object.keys(pluginTools).length > 0) {
    runtime.addTools(pluginTools);
  }
  runtime.setPluginToolDescriptions(plugins.collectToolDescriptions());

  // Register plugin routes with server
  const pluginRoutes = loadedPlugins.flatMap((p) => p.routes || []);
  if (pluginRoutes.length > 0) {
    server.setPluginRoutes(pluginRoutes);
  }

  // Wire plugin context injections into runtime
  runtime.setContextInjectionFn((info) => plugins.collectContextInjections(info, pluginCtx));

  // Wire plugin onToolResult dispatch into runtime
  runtime.onToolResult = (toolName, result, emit) => {
    plugins.dispatchToolResult(toolName, result, emit, pluginCtx);
  };

  // Wire plugin message lifecycle hooks
  runtime.onProcessAttachments = (attachments, userMessage) => {
    return plugins.dispatchProcessAttachments(attachments, userMessage, pluginCtx);
  };
  runtime.onResolveMessages = (messages) => {
    return plugins.dispatchResolveMessages(messages, pluginCtx);
  };

  // Message queue — serializes messages, same-channel injection
  const queue = new MessageQueue();
  setQueueStatusFn(() => queue.getStatus());

  // Sub-agent announces: when a child finishes, enqueue its result as a new
  // turn so the parent can react to it. Channel is "subagent" so it doesn't
  // collide with same-channel injection for human interfaces.
  setSubAgentAnnouncer((id, record) => {
    const text = formatAnnounce(record);
    queue.enqueue({
      text,
      userId: "subagent",
      interface: "subagent",
      channel: `subagent:${id}`,
    }).catch((e) => log.error("subagent", `announce enqueue failed for ${id}: ${e.message}`));
  });

  // Idle-timeout notices get the same narration treatment as step-limit notices
  // The snapshot is captured before the abort fires — the runtime nulls it on abort.
  queue.setTimeoutNarrator({
    capture: () => runtime.getCurrentTurnSnapshot(),
    narrate: async (snapshot) => {
      const { narrateTurnStatus, buildFallbackNarration } = await import("./narration.js");
      if (!snapshot) return `⏱️ Idle timeout reached. Reply "continue" to resume.`;
      return narrateTurnStatus("timeout", snapshot, config).catch(() => buildFallbackNarration("timeout", snapshot));
    },
  });

  queue.setHandler(async (msg, getPendingMessages, signal) => {
    const origin: TurnOrigin = { interface: msg.interface, channel: msg.channel, chatId: msg.chatId, userId: msg.userId };
    return turnOrigin.run(origin, () => handleTurn(msg, getPendingMessages, signal));
  });

  const handleTurn = async (msg: QueuedMessage, getPendingMessages: () => QueuedMessage[], signal: AbortSignal): Promise<string> => {

    const time = formatLocalISO(new Date(), envelopeTimezone);
    const context = `[via ${msg.interface}${msg.channel ? `, ${msg.channel}` : ""}, user: ${msg.userId}, time: ${time}]\n${msg.text}`;

    // Broadcast incoming to other clients.
    // Messages from /message POST (web, tui) are already broadcast by the server
    // with sender exclusion. Only broadcast here for adapter interfaces
    // (Telegram, Slack) which don't go through the HTTP endpoint.
    // Announce turns never went through the HTTP endpoint, so broadcast
    // them regardless of interface or web/TUI users see a reply to nothing.
    const httpInterfaces = ["web", "tui"];
    if (!msg.isHeartbeat && (msg.isAnnounce || !httpInterfaces.includes(msg.interface))) {
      server.broadcast({
        type: "incoming" as any,
        text: msg.text,
        fromInterface: msg.interface,
        fromUserId: msg.userId,
        fromChannel: msg.channel,
      });
    }

    // Set up prepareStep injection for same-channel messages
    runtime.setPendingInjections(() => {
      const pending = getPendingMessages();
      return pending.map((p) => ({
        role: "user",
        content: `[via ${p.interface}${p.channel ? `, ${p.channel}` : ""}, user: ${p.userId}, time: ${formatLocalISO(new Date(), envelopeTimezone)}]\n${p.text}`,
      }));
    });

    const result = await runtime.handleMessage(context, (event: StreamEvent) => {
      queue.touch(); // stream activity — reset the idle timeout
      server.broadcast(event);
      msg.onEvent?.(event);
    }, msg.attachments, signal);

    // Post-turn: let plugins index new messages (async, non-blocking)
    const sessionId = runtime.getSessionId();
    if (sessionId) {
      plugins.dispatchTurnFinish(sessionId, pluginCtx).catch((err) => {
        log.error("plugin", `turn finish error: ${err.message}`);
      });
      // Segments not yet a plugin — index directly
      if (segmentIndex) {
        segmentIndex.indexSession(sessionId).catch((err) => {
          log.error("segments", `indexing failed: ${err.message}`);
        });
      }
    }

    return result;
  };

  // Helper to enqueue from any interface
  const enqueueMessage = async (text: string, userId: string, iface: string, channel: string, onEvent?: (e: StreamEvent) => void, attachments?: import("./interfaces/types.js").Attachment[], chatId?: string) => {
    // Commands (/ or !) bypass the queue — instant response even if queue is busy
    const trimmed = text.trim();
    if (trimmed.startsWith("/") || trimmed.startsWith("!")) {
      const canonicalCmd = trimmed.startsWith("!") ? "/" + trimmed.slice(1) : trimmed;
      const result = await handleSlashCommand(canonicalCmd, userId, iface, agentName, agentDir);
      if (result !== null) {
        server.broadcast({
          type: "command-result" as any,
          text: result,
          command: trimmed,
        });
        return result;
      }
    }
    return queue.enqueue({ text, userId, interface: iface, channel, chatId, attachments }, onEvent);
  };

  server.setStatusFn(() => {
    return getStatusDataFn();
  });

  server.setCommandsFn(() => {
    const cmds: Record<string, string> = {
      "/status": "show agent status, uptime, token usage",
      "/wyd": "show what the agent is currently working on",
      "/restart": "restart the agent process",
    };
    const pluginCmds = plugins.collectCommandDescriptions();
    for (const [cmd, desc] of Object.entries(pluginCmds)) {
      cmds[cmd] = desc;
    }
    cmds["/help"] = "show this help";
    return cmds;
  });

  server.setMessageHandler(async (text, userId, iface, channel, attachments) => {
    await enqueueMessage(text, userId, iface, channel, undefined, attachments);
  });

  // History: return messages from session, paginated
  server.setHistoryFn((limit: number, before?: number) => {
    const msgs = runtime.getMessages();
    const end = before !== undefined ? before : msgs.length;
    const start = Math.max(0, end - limit);
    return msgs.slice(start, end).map((m: any, i: number) => ({
      index: start + i,
      ...m,
    }));
  });

  server.setSystemPromptFn(async () => {
    return { system: await runtime.getSystemPrompt() };
  });

  server.setContextSegmentsFn(async () => {
    const built = await runtime.buildPromptContext();
    return {
      tokenCount: built.stats.summaryTokens,
      segments: built.stats.summarySegments,
    };
  });

  server.setSegmentsFn((sessionId?: string) => {
    if (!segmentIndex) return { segments: [], stats: { segments: 0, level0: 0 } };
    return segmentIndex.getSegments(sessionId);
  });

  server.setSegmentsRebuildFn(async () => {
    if (!segmentIndex) throw new Error("segments not enabled");
    if (segmentRunning) {
      log("segments", "rebuild already running");
      return { status: "already running" };
    }
    const sessionId = runtime.getSessionId();
    if (!sessionId) throw new Error("no session");

    segmentRunning = true;
    try {
      segmentIndex.clear();
      log("segments", "cleared — starting rebuild");
      const created = await segmentIndex.indexSession(sessionId);
      log("segments", `rebuild complete: ${created} segments`);
      return { status: "done", segments: created };
    } finally {
      segmentRunning = false;
    }
  });

  server.setSegmentsStopFn(() => {
    if (!segmentIndex) return;
    segmentIndex.stop();
    segmentRunning = false;
  });

  server.setSegmentsCleanFn(() => {
    if (!segmentIndex) return;
    segmentIndex.clear();
  });

  server.setSegmentsStartFn(async () => {
    if (!segmentIndex) throw new Error("segments not enabled");
    if (segmentRunning) return { status: "already running" };
    const sessionId = runtime.getSessionId();
    if (!sessionId) throw new Error("no session");

    segmentRunning = true;
    try {
      const created = await segmentIndex.indexSession(sessionId);
      log("segments", `indexed ${created} new segments`);
      return { status: "done", segments: created };
    } finally {
      segmentRunning = false;
    }
  });

  server.setSegmentResummarizeFn(async (id: number) => {
    if (!segmentIndex) throw new Error("segments not enabled");
    return segmentIndex.resummarizeSegment(id);
  });

  // Sessions API
  server.setSessionListFn(() => {
    return memoryDB.getSessionList();
  });

  server.setCurrentSessionIdFn(() => {
    return runtime.getSessionId();
  });

  server.setSessionActivityFn((sessionId: string) => {
    return {
      daily: memoryDB.getSessionActivity(sessionId),
      hourly: memoryDB.getSessionHourlyActivity(sessionId),
    };
  });

  // Assign a sticky port if none configured
  if (!config.port) {
    config.port = await assignPort();
    if (config.port > 0) {
      await saveConfigField(agentDir, "port", config.port);
      log("kern", `assigned sticky port :${config.port}`);
    }
  }

  const port = await server.start("0.0.0.0", config.port);
  await registerAgent(agentDir);
  await writePidFile(agentDir, process.pid);

  // Start Telegram if configured
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  let telegramBot: TelegramInterface | null = null;
  if (!forceCli && telegramToken) {
    telegramBot = new TelegramInterface(telegramToken, pairing, config.telegramTools);
    await telegramBot.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", onEvent, msg.attachments, msg.chatId);
      },
    });
  }

  // Start Slack if configured
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  let slackBot: SlackInterface | null = null;
  if (!forceCli && slackBotToken && slackAppToken) {
    slackBot = new SlackInterface(slackBotToken, slackAppToken, pairing);
    await slackBot.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", undefined, msg.attachments, msg.chatId);
      },
    });
  }

  // Start Matrix if configured
  const matrixHomeserver = process.env.MATRIX_HOMESERVER;
  const matrixUserId = process.env.MATRIX_USER_ID;
  const matrixToken = process.env.MATRIX_ACCESS_TOKEN;
  let matrixBot: MatrixInterface | null = null;
  if (!forceCli && matrixHomeserver && matrixUserId && matrixToken) {
    matrixBot = new MatrixInterface(matrixHomeserver, matrixUserId, matrixToken, pairing);
    // start() is non-blocking — the sync loop handles connection errors and
    // auth failures internally and reports via status/statusDetail.
    await matrixBot.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", onEvent, msg.attachments, msg.chatId);
      },
    });
  }

  // Start Nostr if configured
  const nostrNsec = process.env.NOSTR_NSEC;
  let nostrBot: NostrInterface | null = null;
  if (!forceCli && nostrNsec) {
    // NOSTR_RELAYS (comma-separated) overrides config.nostrRelays; empty → defaults
    const relays = parseRelayList(process.env.NOSTR_RELAYS);
    nostrBot = new NostrInterface(nostrNsec, relays.length ? relays : config.nostrRelays, pairing);
    // start() is non-blocking — per-relay loops handle connection errors
    // and report via status/statusDetail.
    await nostrBot.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", onEvent, undefined, msg.chatId);
      },
    });
  }

  // Start Discord if configured
  const discordToken = process.env.DISCORD_TOKEN;
  let discordBot: DiscordInterface | null = null;
  if (!forceCli && discordToken) {
    const mentionOnly = process.env.DISCORD_MENTION_ONLY !== undefined
      ? process.env.DISCORD_MENTION_ONLY === "true" || process.env.DISCORD_MENTION_ONLY === "1"
      : config.discordMentionOnly ?? true;
    discordBot = new DiscordInterface(discordToken, pairing, mentionOnly);
    // start() is non-blocking — retries login with backoff on failure
    await discordBot.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", onEvent, msg.attachments, msg.chatId);
      },
    }).catch(() => {});
  }

  // Start IRC if configured — IRC_URL overrides config.irc
  const ircUrls = parseIrcUrls(process.env.IRC_URL || config.irc);
  let ircBot: IrcInterface | null = null;
  if (!forceCli && ircUrls.length) {
    ircBot = new IrcInterface(ircUrls, pairing);
    setIrcInterface(ircBot);
    // start() is non-blocking — each connection retries on its own and
    // reports via status/statusDetail.
    await ircBot.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", onEvent, undefined, msg.chatId);
      },
    });
  }

  // Register interface status reporting
  setInterfaceStatusFn(() => {
    const statuses: InterfaceStatus[] = [];
    if (telegramBot) {
      statuses.push({ name: "telegram", status: telegramBot.status, detail: telegramBot.statusDetail });
    }
    if (slackBot) {
      statuses.push({ name: "slack", status: slackBot.status, detail: slackBot.statusDetail });
    }
    if (matrixBot) {
      statuses.push({ name: "matrix", status: matrixBot.status, detail: matrixBot.statusDetail });
    }
    if (nostrBot) {
      statuses.push({ name: "nostr", status: nostrBot.status, detail: nostrBot.statusDetail });
    }
    if (discordBot) {
      statuses.push({ name: "discord", status: discordBot.status, detail: discordBot.statusDetail });
    }
    if (ircBot) {
      statuses.push({ name: "irc", status: ircBot.status, detail: ircBot.statusDetail });
    }
    return statuses;
  });

  // Send text to a platform conversation by its chatId. Shared by the
  // message tool (which resolves chatId from pairing) and by announce()
  // (which uses the chatId captured at the origin of the turn).
  const sendToChat = async (iface: string, chatId: string, text: string): Promise<boolean> => {
    switch (iface) {
      case "telegram": return telegramBot ? telegramBot.sendToUser(chatId, text) : false;
      case "slack": return slackBot ? slackBot.sendToUser(chatId, text) : false;
      case "matrix": return matrixBot ? matrixBot.sendToUser(chatId, text) : false;
      case "nostr": return nostrBot ? nostrBot.sendToUser(chatId, text) : false;
      case "discord": return discordBot ? discordBot.sendToUser(chatId, text) : false;
      case "irc": return ircBot ? ircBot.sendToUser(chatId, text) : false;
      default: return false;
    }
  };

  // Wire message tool — agent can send messages to users
  setMessageSender(async (userId: string, iface: string, text: string) => {
    let chatId: string;
    if (iface === "nostr") {
      chatId = userId;
    } else if (iface === "irc") {
      // chatId is "<host>/<nick-or-channel>" — fall back to a bare userId of
      // the same shape so the agent can address a channel it hasn't paired.
      chatId = pairing.getChatId(userId) || userId.replace(/^irc:/, "");
    } else {
      chatId = pairing.getChatId(userId) || userId;
    }
    const sent = await sendToChat(iface, chatId, text);
    if (sent) {
      server.broadcast({
        type: "outgoing" as any,
        text,
        fromInterface: iface,
        fromUserId: userId,
      });
    }
    return sent;
  });

  // Async completions (background jobs, ...) — enqueue as a turn stamped with
  // the origin envelope so the queue routes it like a message from that
  // conversation, then deliver the agent's reply to the origin chat. Web/TUI
  // clients already receive the reply over SSE; adapter interfaces need an
  // explicit send because nobody is awaiting this turn.
  const isSilentReply = (reply: string) => {
    const t = reply.trim();
    return !t || t === "(no text response)" || t.endsWith("NO_REPLY");
  };
  announceImpl = async (text: string, origin: TurnOrigin) => {
    const target = origin.chatId || origin.userId;
    let reply: string;
    try {
      reply = await queue.enqueue({
        text,
        userId: origin.userId,
        interface: origin.interface,
        channel: origin.channel,
        chatId: origin.chatId,
        isAnnounce: true,
      });
    } catch (err: any) {
      // Same as adapters do for a failed user turn: the chat hears about it.
      await sendToChat(origin.interface, target, `⚠️ ${String(err?.message || err).slice(0, 300)}`).catch(() => false);
      throw err;
    }
    if (isSilentReply(reply)) return reply;
    const sent = await sendToChat(origin.interface, target, reply);
    if (sent) {
      server.broadcast({
        type: "outgoing" as any,
        text: reply,
        fromInterface: origin.interface,
        fromUserId: origin.userId,
      });
    } else if (!["web", "tui", "cli", "system"].includes(origin.interface)) {
      log.warn("kern", `announce reply not delivered to ${origin.interface}:${origin.channel}`);
    }
    return reply;
  };

  log("kern", `started ${agentName}`);

  // If forceCli, start CLI interface connected to same runtime (also goes through queue)
  if (forceCli) {
    const cli = new CliInterface();
    await cli.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", undefined, undefined, msg.chatId);
      },
      history: runtime.getMessages(),
    });
  }

  // Heartbeat — goes through queue as low priority
  if (config.heartbeatInterval > 0) {
    const intervalMs = config.heartbeatInterval * 60 * 1000;
    setInterval(async () => {
      try {
        const tuiStatus = server.hasConnectedClients() ? "connected" : "disconnected";
        const heartbeatText = `[heartbeat, tui: ${tuiStatus}]`;

        server.broadcast({
          type: "heartbeat" as any,
          text: heartbeatText,
        });

        await queue.enqueue({
          text: heartbeatText,
          userId: "system",
          interface: "system",
          channel: "heartbeat",
          isHeartbeat: true,
        });
      } catch (e: any) {
        process.stderr.write(`[kern] heartbeat error: ${e.message}\n`);
      }
    }, intervalMs);
  }

  // Graceful shutdown
  const shutdown = async () => {
    log("kern", `stopping ${agentName}`);
    if (telegramBot) await telegramBot.stop().catch(() => {});
    if (slackBot) await slackBot.stop().catch(() => {});
    if (matrixBot) await matrixBot.stop().catch(() => {});
    if (nostrBot) await nostrBot.stop().catch(() => {});
    if (discordBot) await discordBot.stop().catch(() => {});
    if (ircBot) await ircBot.stop().catch(() => {});
    await plugins.shutdown(pluginCtx);
    server.stop();
    memoryDB.close();
    await removePidFile(agentDir);
    log("kern", `stopped ${agentName}`);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
