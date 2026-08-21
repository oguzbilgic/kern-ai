import { Runtime, type StreamEvent } from "./runtime.js";
import { updateKernel } from "./kernel.js";
import { TelegramInterface } from "./interfaces/telegram.js";
import { SlackInterface } from "./interfaces/slack.js";
import { MatrixInterface } from "./interfaces/matrix.js";
import { CliInterface } from "./interfaces/cli.js";
import { loadConfig, saveConfigField } from "./config.js";
import { readFile, appendFile } from "fs/promises";
import { join, basename } from "path";
import { randomBytes } from "crypto";
import type { Interface, MessageHandler } from "./interfaces/types.js";
import { registerAgent, writePidFile, removePidFile, assignPort } from "./registry.js";
import { AgentServer } from "./server.js";
import { PairingManager } from "./pairing.js";
import { setMessageSender } from "./tools/message.js";
import { SegmentIndex } from "./segments.js";
import { MemoryDB } from "./memory.js";
import { MessageQueue } from "./queue.js";
import { getStatusData as getStatusDataFn, setQueueStatusFn, setInterfaceStatusFn, setSegmentStatsFn, setPluginStatusFn, type InterfaceStatus } from "./tools/kern.js";
import { plugins, type PluginContext } from "./plugins/index.js";
import { setSubAgentAnnouncer, formatAnnounce } from "./plugins/subagents/plugin.js";
import { formatLocalISO, resolveHostTimezone } from "./util.js";
import { log } from "./log.js";

let _pluginCtx: PluginContext | null = null;

async function handleSlashCommand(cmd: string, userId: string, iface: string, agentName: string, agentDir: string): Promise<string | null> {
  switch (cmd) {
    case "/restart": {
      log("kern", `restart requested by ${userId} via ${iface}`);
      const { spawn } = await import("child_process");
      const child = spawn("kern", ["restart", agentName], { stdio: "pipe" });

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

    case "/help": {
      const builtins = [
        "/status   — show agent status, uptime, token usage",
        "/restart  — restart the agent process",
      ];
      const pluginCmds = plugins.collectCommandDescriptions();
      for (const [cmd, desc] of Object.entries(pluginCmds)) {
        builtins.push(`${cmd.padEnd(10)} — ${desc}`);
      }
      builtins.push("/help     — show this help");
      return builtins.join("\n");
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

  // Load plugins
  const pluginCtx: PluginContext = {
    agentDir,
    config,
    db: memoryDB,
    sessionId: () => runtime.getSessionId(),
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

  queue.setHandler(async (msg, getPendingMessages, signal) => {

    const time = formatLocalISO(new Date(), envelopeTimezone);
    const context = `[via ${msg.interface}${msg.channel ? `, ${msg.channel}` : ""}, user: ${msg.userId}, time: ${time}]\n${msg.text}`;

    // Broadcast incoming to other clients.
    // Messages from /message POST (web, tui) are already broadcast by the server
    // with sender exclusion. Only broadcast here for adapter interfaces
    // (Telegram, Slack) which don't go through the HTTP endpoint.
    const httpInterfaces = ["web", "tui"];
    if (!msg.isHeartbeat && !httpInterfaces.includes(msg.interface)) {
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
  });

  // Helper to enqueue from any interface
  const enqueueMessage = async (text: string, userId: string, iface: string, channel: string, onEvent?: (e: StreamEvent) => void, attachments?: import("./interfaces/types.js").Attachment[]) => {
    // Slash commands bypass the queue — instant response even if queue is busy
    const cmd = text.trim();
    if (cmd.startsWith("/")) {
      const result = await handleSlashCommand(cmd, userId, iface, agentName, agentDir);
      if (result !== null) {
        server.broadcast({
          type: "command-result" as any,
          text: result,
          command: cmd,
        });
        return result;
      }
    }
    return queue.enqueue({ text, userId, interface: iface, channel, attachments }, onEvent);
  };

  server.setStatusFn(() => {
    return getStatusDataFn();
  });

  server.setCommandsFn(() => {
    const cmds: Record<string, string> = {
      "/status": "show agent status, uptime, token usage",
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
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", onEvent, msg.attachments);
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
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", undefined, msg.attachments);
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
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "", onEvent);
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
    return statuses;
  });

  // Wire message tool — agent can send messages to users
  setMessageSender(async (userId: string, iface: string, text: string) => {
    if (iface === "telegram" && telegramBot) {
      const chatId = pairing.getChatId(userId) || userId;
      const sent = await telegramBot.sendToUser(chatId, text);
      if (sent) {
        server.broadcast({
          type: "outgoing" as any,
          text,
          fromInterface: iface,
          fromUserId: userId,
        });
      }
      return sent;
    }
    if (iface === "slack" && slackBot) {
      const chatId = pairing.getChatId(userId) || userId;
      const sent = await slackBot.sendToUser(chatId, text);
      if (sent) {
        server.broadcast({
          type: "outgoing" as any,
          text,
          fromInterface: iface,
          fromUserId: userId,
        });
      }
      return sent;
    }
    if (iface === "matrix" && matrixBot) {
      const chatId = pairing.getChatId(userId) || userId;
      const sent = await matrixBot.sendToUser(chatId, text);
      if (sent) {
        server.broadcast({
          type: "outgoing" as any,
          text,
          fromInterface: iface,
          fromUserId: userId,
        });
      }
      return sent;
    }
    return false;
  });

  log("kern", `started ${agentName}`);

  // If forceCli, start CLI interface connected to same runtime (also goes through queue)
  if (forceCli) {
    const cli = new CliInterface();
    await cli.start({
      onMessage: async (msg, onEvent) => {
        return enqueueMessage(msg.text, msg.userId, msg.interface, msg.channel || "");
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
