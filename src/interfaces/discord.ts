import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message as DiscordMessage,
  type TextBasedChannel,
} from "discord.js";
import type { Attachment, Interface, StartOptions } from "./types.js";
import type { PairingManager } from "../pairing.js";
import { log } from "../log.js";
import { isNoReply } from "../util.js";
import { setDiscordClient } from "../plugins/discord/plugin.js";

const MAX_DISCORD_MSG_LENGTH = 2000;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

function mimeToType(mime: string): Attachment["type"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Split text into chunks that fit Discord's 2000 character limit.
 * Tries to split on line breaks, then spaces, then hard cut.
 */
export function chunkMessage(text: string, limit = MAX_DISCORD_MSG_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try finding last newline before limit
    let splitIdx = remaining.lastIndexOf("\n", limit);
    if (splitIdx <= 0 || splitIdx < limit * 0.5) {
      // If no good newline, try space
      splitIdx = remaining.lastIndexOf(" ", limit);
    }
    if (splitIdx <= 0 || splitIdx < limit * 0.5) {
      // Fallback: hard cut
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.filter(c => c.length > 0);
}

export class DiscordInterface implements Interface {
  private client: Client;
  private pairing: PairingManager | null;
  private token: string;
  private mentionOnly: boolean;
  private botUserId: string = "";
  private _status: "connected" | "disconnected" | "error" = "disconnected";
  private _statusDetail?: string;
  private sentCodes = new Set<string>();
  private running: boolean = false;
  private retryTimeout?: NodeJS.Timeout;

  constructor(token: string, pairing?: PairingManager, mentionOnly: boolean = true) {
    this.token = token;
    this.pairing = pairing || null;
    this.mentionOnly = mentionOnly;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [
        Partials.Channel, // Required to receive DMs
        Partials.Message,
      ],
    });
  }

  get status() { return this._status; }
  get statusDetail() { return this._statusDetail; }

  async start({ onMessage }: StartOptions): Promise<void> {
    this.running = true;

    this.client.once("ready", (c) => {
      this.botUserId = c.user.id;
      this._status = "connected";
      this._statusDetail = undefined;
      setDiscordClient(this.client);
      if (this.retryTimeout) {
        clearTimeout(this.retryTimeout);
        this.retryTimeout = undefined;
      }
      log("discord", `connected as ${c.user.tag} (${c.user.id})`);
    });

      this.client.on("error", (err) => {
        log.error("discord", `client error: ${err.message || err}`);
        this._status = "error";
        this._statusDetail = err.message || String(err);
      });

      this.client.on("messageCreate", async (message: DiscordMessage) => {
        // Ignore own messages or bot messages
        if (message.author.bot || message.author.id === this.botUserId) return;

        const isDM = message.channel.type === ChannelType.DM;
        const mentionsUser = this.botUserId ? message.mentions.users.has(this.botUserId) : false;
        // Check if any role mentioned is a role the bot has in this guild
        const botMember = message.guild?.members.me;
        const mentionsRole = botMember && message.mentions.roles.size > 0
          ? message.mentions.roles.some((_, roleId) => botMember.roles.cache.has(roleId))
          : false;
        const isMentioned = mentionsUser || mentionsRole;

        log.debug("discord", `msg received (dm=${isDM}, mentioned=${isMentioned}, channel=${message.channel.id}, author=${message.author.id}): "${message.content}"`);

        // In channels/guilds, check mentionOnly policy
        if (!isDM && this.mentionOnly && !isMentioned) return;

        // Clean text: strip bot mention prefix like <@123456789> or role mentions
        let cleanText = message.content;
        if (this.botUserId) {
          cleanText = cleanText.replace(new RegExp(`<@!?${this.botUserId}>`, "g"), "").trim();
        }
        if (botMember) {
          for (const roleId of botMember.roles.cache.keys()) {
            cleanText = cleanText.replace(new RegExp(`<@&${roleId}>`, "g"), "").trim();
          }
        }

        // Process attachments
        const attachments: Attachment[] = [];
        for (const [, att] of message.attachments) {
          if (att.size > MAX_FILE_SIZE) continue;
          try {
            const res = await fetch(att.url);
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const mimeType = att.contentType || "application/octet-stream";
            attachments.push({
              type: mimeToType(mimeType),
              data: buf,
              mimeType,
              filename: att.name || "attachment",
              size: att.size,
            });
          } catch (err: any) {
            log.warn("discord", `failed to download attachment ${att.name}: ${err.message || err}`);
          }
        }

        if (!cleanText && attachments.length === 0) return;

        const senderId = message.author.id;
        const channelId = message.channel.id;
        const channelLabel = isDM
          ? `discord:dm:${message.author.username}`
          : `discord:#${(message.channel as any).name || channelId}`;

        // Pairing logic
        if (isDM && this.pairing && !this.pairing.isPaired(senderId)) {
          if (!this.pairing.hasAnyPairedUsers()) {
            await this.pairing.autoPairFirst(senderId, "discord", channelId);
          } else {
            if (this.sentCodes.has(senderId)) return;
            this.sentCodes.add(senderId);
            const code = await this.pairing.getOrCreateCode(senderId, "discord", `discord:${channelId}`);
            await message.reply(
              `You are not paired with this agent.\n\nPairing code: \`${code}\`\n\nShare this code with the operator to approve access.`
            );
            return;
          }
        }

        // Send typing indicator periodically
        const sendTyping = () => {
          if ("sendTyping" in message.channel) {
            (message.channel as any).sendTyping?.().catch(() => {});
          }
        };
        sendTyping();
        const typingInterval = setInterval(sendTyping, 8000);

        try {
          const response = await onMessage(
            {
              text: cleanText,
              userId: senderId,
              chatId: channelId,
              interface: "discord",
              channel: channelLabel,
              attachments: attachments.length > 0 ? attachments : undefined,
            },
            () => {},
          );

          clearInterval(typingInterval);

          const reply = (response || "").trim();
          if (isNoReply(reply)) return;

          const chunks = chunkMessage(reply);
          for (let i = 0; i < chunks.length; i++) {
            if (i === 0 && !isDM) {
              await message.reply({ content: chunks[i], allowedMentions: { repliedUser: false } });
            } else {
              await (message.channel as any).send({ content: chunks[i] });
            }
          }
        } catch (err: any) {
          clearInterval(typingInterval);
          const reason = String(err?.message || err || "Error processing message.");
          log.error("discord", `turn failed: ${reason}`);
          const displayErr = `⚠️ ${reason.slice(0, 300)}`;
          const errorMsg = { content: displayErr, allowedMentions: { repliedUser: false } };
          if (isDM) {
            await (message.channel as any).send({ content: displayErr }).catch(() => {});
          } else {
            await message.reply(errorMsg).catch(() => {});
          }
        }
      });

    const tryLogin = (backoff = 2000) => {
      if (!this.running) return;
      this.client.login(this.token).catch((err) => {
        if (!this.running) return;
        this._status = "error";
        this._statusDetail = err.message || String(err);
        log.error("discord", `login failed: ${err.message || err}`);
        const nextBackoff = Math.min(backoff * 1.5, 60000);
        log("discord", `retrying login in ${Math.round(backoff / 1000)}s`);
        this.retryTimeout = setTimeout(() => tryLogin(nextBackoff), backoff);
      });
    };

    tryLogin();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = undefined;
    }
    this._status = "disconnected";
    setDiscordClient(null);
    try {
      this.client.destroy();
    } catch {}
  }

  async sendToUser(targetId: string, text: string): Promise<boolean> {
    try {
      // First try fetching as a channel (DM or guild channel)
      let target: any = await this.client.channels.fetch(targetId).catch(() => null);

      // If not a channel, try fetching as a user to create DM
      if (!target) {
        const user = await this.client.users.fetch(targetId).catch(() => null);
        if (user) {
          target = await user.createDM().catch(() => null);
        }
      }

      if (!target || !("send" in target)) {
        log.warn("discord", `cannot send: target "${targetId}" not found`);
        return false;
      }

      const chunks = chunkMessage(text);
      for (const chunk of chunks) {
        await target.send({ content: chunk });
      }
      return true;
    } catch (err: any) {
      log.warn("discord", `sendToUser failed: ${err.message || err}`);
      return false;
    }
  }
}
