import { Bot, InputFile } from "grammy";
import type { Attachment, Interface, StartOptions } from "./types.js";
import type { PairingManager } from "../pairing.js";
import { log } from "../log.js";
import { isNoReply } from "../util.js";
import { BARE_MENTION_TEXT, MentionGate, SentIds, escapeRegex } from "../mentions.js";
import { synthesizeSpeech, stripForSpeech, ttsAvailable } from "../tts.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function mdToHtml(text: string): string {
  let html = text;

  // Code blocks first — protect from other replacements
  html = html.replace(/```\w*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>");

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold: **...** → <b>...</b>
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *...* (but not inside bold)
  html = html.replace(/(?<![*<])(\*)(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$2</i>");

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Lists: - item → • item
  html = html.replace(/^- /gm, "• ");

  // Blockquotes: > line
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  return html;
}

function stripMarkdown(text: string): string {
  let plain = text;
  plain = plain.replace(/```\w*\n([\s\S]*?)```/g, "$1");
  plain = plain.replace(/`([^`]+)`/g, "$1");
  plain = plain.replace(/\*\*(.+?)\*\*/g, "$1");
  plain = plain.replace(/(?<![*])(\*)(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$2");
  plain = plain.replace(/~~(.+?)~~/g, "$1");
  plain = plain.replace(/^- /gm, "• ");
  plain = plain.replace(/^> /gm, "");
  return plain;
}

/** Resolve MIME type from a Telegram file name or fall back to generic type */
function guessMime(filename?: string, fallback = "application/octet-stream"): string {
  if (!filename) return fallback;
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", webm: "video/webm",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv", txt: "text/plain", json: "application/json", md: "text/markdown",
  };
  return map[ext || ""] || fallback;
}

/** Best available human-readable label for a Telegram sender. */
function senderName(from: { username?: string; first_name?: string; id: number }): string {
  if (from.username) return `@${from.username}`;
  if (from.first_name) return from.first_name;
  return String(from.id);
}

/** Text and caption entities on a message, as one list. */
export function mentionEntities(msg: any): any[] {
  if (!msg) return [];
  return [...(msg.entities || []), ...(msg.caption_entities || [])];
}

/**
 * Patterns that match our own handle in message text.
 *
 * Plain `@name\b` is too loose: `\b` fires on `.` and `/`, so it matches
 * inside `https://x.com/@name/status/1` and `ops@name.example.com`. The first
 * pattern therefore requires a real boundary before the `@` and rejects a
 * trailing word char or dot. The second covers `/command@name`, where the `@`
 * legitimately follows word characters.
 */
function mentionPatterns(username: string, flags = "i"): { inline: RegExp; command: RegExp } {
  const u = escapeRegex(username);
  return {
    inline: new RegExp(`(^|[^\\w@/.])@${u}(?![\\w.])[ \\t]?`, flags),
    command: new RegExp(`^(/[A-Za-z0-9_]+)@${u}(?![\\w.])[ \\t]?`, flags),
  };
}

/**
 * Whether a group message is addressed to this bot.
 *
 * Entities are authoritative when Telegram sends them: a `mention` entity
 * equal to our handle, a `bot_command` entity carrying our `@handle` suffix, or
 * a `text_mention` pointing at our user id (how clients link a bot with no
 * public username). Captions and forwards don't always carry entities, so we
 * fall back to matching the raw text. A reply to one of our own messages counts
 * regardless.
 */
export function isAddressedTo(
  msg: any,
  botId: number,
  botUsername: string,
): boolean {
  if (!msg) return false;

  // Reply to something we said
  if (botId && msg.reply_to_message?.from?.id === botId) return true;

  const body: string = msg.text || msg.caption || "";
  const entities = mentionEntities(msg);
  const handle = botUsername ? `@${botUsername}`.toLowerCase() : "";

  for (const e of entities) {
    if (e.type === "text_mention" && botId && e.user?.id === botId) return true;
    if (!handle || typeof e.offset !== "number" || typeof e.length !== "number") continue;
    const slice = body.slice(e.offset, e.offset + e.length).toLowerCase();
    if (e.type === "mention" && slice === handle) return true;
    if (e.type === "bot_command" && slice.endsWith(handle)) return true;
  }

  if (!botUsername) return false;
  const { inline, command } = mentionPatterns(botUsername);
  return inline.test(body) || command.test(body);
}

/**
 * Remove our own handle from a message we were addressed in, so the model reads
 * the request rather than its own name, and `/status@bot` reaches the command
 * router as `/status`.
 *
 * Entity offsets are used when available (they never misfire on URLs), with the
 * bounded text patterns as the fallback. Each removal swallows one following
 * space so `hey @bot check` doesn't become `hey  check`; nothing else about the
 * text is normalized, because newlines and indentation are load-bearing in the
 * logs, YAML and code people paste at their agents.
 */
export function stripBotMention(text: string, entities: any[], botUsername: string): string {
  if (!text) return "";
  const handle = botUsername ? `@${botUsername}`.toLowerCase() : "";
  if (!handle) return text.trim();

  if (entities.length) {
    const cuts: Array<[number, number]> = [];
    for (const e of entities) {
      if (typeof e.offset !== "number" || typeof e.length !== "number") continue;
      const end = e.offset + e.length;
      const slice = text.slice(e.offset, end).toLowerCase();
      if (e.type === "mention" && slice === handle) {
        cuts.push([e.offset, end]);
      } else if (e.type === "bot_command" && slice.endsWith(handle)) {
        cuts.push([end - handle.length, end]);
      }
    }
    // Right to left, so earlier offsets stay valid.
    cuts.sort((a, b) => b[0] - a[0]);
    let out = text;
    for (const [from, to] of cuts) {
      const end = " \t".includes(out[to]) ? to + 1 : to;
      out = out.slice(0, from) + out.slice(end);
    }
    return out.trim();
  }

  const { inline, command } = mentionPatterns(botUsername, "gi");
  return text.replace(inline, "$1").replace(command, "$1").trim();
}

export class TelegramInterface implements Interface {
  private bot: Bot;
  private pairing: PairingManager | null;
  private showTools: boolean;
  private gate: MentionGate | null;
  /** Our own @username, resolved at start. Empty if getMe failed. */
  private botUsername = "";
  /** Our own numeric user id, used to spot replies to our messages. */
  private botId = 0;
  /** Albums (media groups) we were addressed by, so their other files count. */
  private addressedAlbums = new SentIds(50);
  private _status: "connected" | "disconnected" | "error" = "disconnected";
  private _statusDetail?: string;

  constructor(token: string, pairing?: PairingManager, showTools = false, gate?: MentionGate) {
    this.bot = new Bot(token);
    this.pairing = pairing || null;
    this.showTools = showTools;
    this.gate = gate || null;
  }

  get status() { return this._status; }
  get statusDetail() { return this._statusDetail; }

  async start({ onMessage }: StartOptions): Promise<void> {
    // Resolve our own identity so we can tell when a group message is for us
    try {
      const me = await this.bot.api.getMe();
      this.botUsername = me.username || "";
      this.botId = me.id;
    } catch (err: any) {
      log.warn("telegram", `getMe failed, mention detection degraded: ${err.message || err}`);
    }

    // Register bot commands with Telegram
    this.bot.api.setMyCommands([
      { command: "status", description: "Show agent status" },
      { command: "restart", description: "Restart the agent" },
    ]).catch(() => {});

    // Handle all message types that may contain media
    this.bot.on("message", async (ctx) => {
      const userId = ctx.from.id;
      const chatId = ctx.chat.id.toString();
      const isGroup = ctx.chat.type !== "private";

      // Extract text from message (could be caption for media messages)
      const rawText = ctx.message.text || ctx.message.caption || "";
      let text = rawText;

      // Skip messages with no text and no media
      const hasMedia = !!(
        ctx.message.photo ||
        ctx.message.document ||
        ctx.message.voice ||
        ctx.message.audio ||
        ctx.message.video ||
        ctx.message.video_note ||
        ctx.message.sticker
      );
      if (!text && !hasMedia) return;

      log("telegram", `message from ${userId}: ${(text || "[media]").slice(0, 50)}`);

      // Group chats: only speak when addressed — an @mention of our username,
      // a text_mention pointing at us, or a reply to one of our messages.
      // Anything else is observed and folded into the next addressed turn, so
      // we keep the conversation without answering messages meant for others.
      //
      // This runs before the pairing check on purpose: an unaddressed message
      // from an unpaired group member should produce nothing at all, not a
      // public pairing code for a message that wasn't for us.
      const channelKey = `telegram:${chatId}`;
      const album = ctx.message.media_group_id as string | undefined;
      let addressed = true;
      if (isGroup) {
        // An album arrives as one message per file and only one of them carries
        // the caption, so the rest look like room traffic. If we were addressed
        // by any part of this album, the whole album is for us.
        addressed = this.isAddressed(ctx.message) || (!!album && this.addressedAlbums.has(album));
        // If getMe failed we cannot tell a mention from room chatter. Failing
        // closed would make the agent mute in every group, so pass everything
        // through instead — the prompt's NO_REPLY convention still applies.
        const canDetect = Boolean(this.botId || this.botUsername);
        if (this.gate?.active && canDetect && !addressed) {
          const sender = senderName(ctx.from);
          this.gate.observe(channelKey, sender, text || "[media]");
          log("telegram", `not addressed in ${chatId}, observing (${this.gate.pending(channelKey)} buffered)`);
          return;
        }
        if (addressed) {
          if (album) this.addressedAlbums.add(album);
          if (this.gate?.active) {
            // Strip our @username so the model reads the request, not its own
            // name. Also normalizes `/status@bot` to `/status` for the slash
            // command handler. Only under gating — with `mentionsOnly: false`
            // the text reaches the model exactly as it always did.
            text = stripBotMention(text, mentionEntities(ctx.message), this.botUsername)
              || (hasMedia ? "" : BARE_MENTION_TEXT);
          }
        }
      }

      // Check pairing
      if (this.pairing && !this.pairing.isPaired(userId.toString())) {
        // Auto-pair first user ever — they become the operator
        if (!this.pairing.hasAnyPairedUsers()) {
          await this.pairing.autoPairFirst(userId.toString(), "telegram", chatId);
          // Fall through to normal message handling
        } else {
          const code = await this.pairing.getOrCreateCode(
            userId.toString(),
            "telegram",
            `telegram:${chatId}`,
          );
          await ctx.reply(
            `You're not paired with this agent.\n\nYour pairing code: <b>${code}</b>\n\nShare this code with the agent's operator to get access.`,
            { parse_mode: "HTML" },
          );
          return;
        }
      }

      // Download attachments (each type has its own try/catch so one failure doesn't skip the rest)
      const attachments: Attachment[] = [];

      if (ctx.message.photo) {
        try {
          const photo = ctx.message.photo[ctx.message.photo.length - 1];
          const file = await ctx.api.getFile(photo.file_id);
          const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
          const resp = await fetch(url);
          const buffer = Buffer.from(await resp.arrayBuffer());
          if (buffer.length > MAX_FILE_SIZE) {
            log.warn("telegram", `photo too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB), skipping`);
          } else {
            attachments.push({
              type: "image",
              data: buffer,
              mimeType: guessMime(file.file_path, "image/jpeg"),
              filename: file.file_path?.split("/").pop(),
              size: buffer.length,
            });
          }
        } catch (err: any) {
          log.warn("telegram", `failed to download photo: ${err.message}`);
        }
      }

      if (ctx.message.document) {
        try {
          const doc = ctx.message.document;
          if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
            log.warn("telegram", `document too large (${(doc.file_size / 1024 / 1024).toFixed(1)}MB), skipping`);
          } else {
            const file = await ctx.api.getFile(doc.file_id);
            const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
            const resp = await fetch(url);
            const buffer = Buffer.from(await resp.arrayBuffer());
            const mime = doc.mime_type || guessMime(doc.file_name);
            const type = mime.startsWith("image/") ? "image"
              : mime.startsWith("video/") ? "video"
              : mime.startsWith("audio/") ? "audio"
              : "document";
            attachments.push({
              type,
              data: buffer,
              mimeType: mime,
              filename: doc.file_name,
              size: buffer.length,
            });
          }
        } catch (err: any) {
          log.warn("telegram", `failed to download document: ${err.message}`);
        }
      }

      if (ctx.message.voice || ctx.message.audio) {
        try {
          const audio = ctx.message.voice || ctx.message.audio!;
          const file = await ctx.api.getFile(audio.file_id);
          const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
          const resp = await fetch(url);
          const buffer = Buffer.from(await resp.arrayBuffer());
          if (buffer.length > MAX_FILE_SIZE) {
            log.warn("telegram", `audio too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB), skipping`);
          } else {
            attachments.push({
              type: "audio",
              data: buffer,
              mimeType: ("mime_type" in audio && audio.mime_type) || guessMime(file.file_path, "audio/ogg"),
              filename: file.file_path?.split("/").pop(),
              size: buffer.length,
            });
          }
        } catch (err: any) {
          log.warn("telegram", `failed to download audio: ${err.message}`);
        }
      }

      if (ctx.message.video || ctx.message.video_note) {
        try {
          const video = ctx.message.video || ctx.message.video_note!;
          const file = await ctx.api.getFile(video.file_id);
          const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
          const resp = await fetch(url);
          const buffer = Buffer.from(await resp.arrayBuffer());
          if (buffer.length > MAX_FILE_SIZE) {
            log.warn("telegram", `video too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB), skipping`);
          } else {
            attachments.push({
              type: "video",
              data: buffer,
              mimeType: ("mime_type" in video && video.mime_type) || guessMime(file.file_path, "video/mp4"),
              filename: file.file_path?.split("/").pop(),
              size: buffer.length,
            });
          }
        } catch (err: any) {
          log.warn("telegram", `failed to download video: ${err.message}`);
        }
      }

      if (ctx.message.sticker && !ctx.message.sticker.is_animated && !ctx.message.sticker.is_video) {
        try {
          const sticker = ctx.message.sticker;
          const file = await ctx.api.getFile(sticker.file_id);
          const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
          const resp = await fetch(url);
          const buffer = Buffer.from(await resp.arrayBuffer());
          attachments.push({
            type: "image",
            data: buffer,
            mimeType: guessMime(file.file_path, "image/webp"),
            filename: file.file_path?.split("/").pop(),
            size: buffer.length,
          });
        } catch (err: any) {
          log.warn("telegram", `failed to download sticker: ${err.message}`);
        }
      }

      // Keep typing indicator alive every 4s (Telegram expires it after 5s)
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);
      await ctx.replyWithChatAction("typing");
      const reply = await ctx.reply("...");

      let lastEditTime = 0;
      let currentText = "";
      let toolLines: string[] = [];
      let streaming = false;
      let activeMessageId = reply.message_id;
      let textBlocks: string[] = [];
      let pendingNewMessage: Promise<void> | null = null;

      try {
        const response = await onMessage(
          {
            text: (isGroup ? this.gate?.withContext(channelKey, text) : undefined) || text || "",
            userId: userId.toString(),
            chatId,
            interface: "telegram",
            channel: `telegram:${chatId}`,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
          (event) => {
            const now = Date.now();
            if (event.type === "tool-call") {
              // If we had text streaming, finalize that message and start new one for next text
              if (streaming && currentText) {
                this.editMessage(ctx, activeMessageId, currentText).catch(() => {});
                textBlocks.push(currentText);
                streaming = false;
                currentText = "";
                toolLines = [];
                // New message for next text block
                pendingNewMessage = ctx.reply("...").then((msg) => {
                  activeMessageId = msg.message_id;
                  pendingNewMessage = null;
                }).catch(() => { pendingNewMessage = null; });
              }
              if (!this.showTools) return;
              const detail = event.toolDetail ? ` ${event.toolDetail}` : "";
              toolLines.push(`⚙ ${event.toolName}${detail}`);
              if (now - lastEditTime > 500 && !pendingNewMessage) {
                lastEditTime = now;
                this.editMessage(ctx, activeMessageId, toolLines.join("\n"), false).catch(() => {});
              }
            } else if (event.type === "text-delta") {
              if (!streaming) {
                streaming = true;
                currentText = "";
                toolLines = [];
              }
              currentText += event.text || "";
              if (now - lastEditTime > 1000 && !pendingNewMessage) {
                lastEditTime = now;
                this.editMessage(ctx, activeMessageId, currentText).catch(() => {});
              }
            }
          }
        );

        clearInterval(typingInterval);
        if (pendingNewMessage) await pendingNewMessage;
        // Final edit — overwrite tools with text on the last message
        const lastText = (currentText || response || "").trim();
        if (isNoReply(lastText)) {
          // Suppress — delete the placeholder message
          try { await ctx.api.deleteMessage(ctx.chat.id, activeMessageId); } catch {}
          // Delete any earlier placeholder too
          if (activeMessageId !== reply.message_id) {
            try { await ctx.api.deleteMessage(ctx.chat.id, reply.message_id); } catch {}
          }
        } else if (ctx.message.voice && ttsAvailable()) {
          // Voice in → voice out: reply with a voice note only. The streamed
          // text placeholder is deleted once the voice note is sent. Falls
          // back to the text reply if synthesis fails.
          try {
            await this.sendVoiceReply(ctx, lastText);
            try { await ctx.api.deleteMessage(ctx.chat.id, activeMessageId); } catch {}
          } catch (err: any) {
            log.warn("telegram", `voice reply failed, falling back to text: ${err.message}`);
            await this.editMessage(ctx, activeMessageId, lastText);
          }
        } else {
          await this.editMessage(ctx, activeMessageId, lastText);
        }
      } catch (error: any) {
        clearInterval(typingInterval);
        await this.editMessage(ctx, reply.message_id, `Error: ${error.message}`);
      }
    });

    // Catch polling errors — prevent unhandled exceptions from crashing the process
    this.bot.catch((err) => {
      log.error("telegram", `bot error: ${err.message || err}`);
    });

    log("telegram", "connected");
    this.startPolling();
  }

  private isAddressed(msg: any): boolean {
    return isAddressedTo(msg, this.botId, this.botUsername);
  }

  private startPolling(): void {
    this.bot.start({
      onStart: () => {
        this._status = "connected";
        this._statusDetail = undefined;
        log("telegram", "polling started");
      },
    }).catch((err) => {
      const msg = err?.message || String(err);
      if (msg.includes("409") || msg.includes("Conflict")) {
        this._status = "error";
        this._statusDetail = "409 conflict, retrying";
        log.warn("telegram", "409 conflict — retrying in 5s");
        setTimeout(() => this.startPolling(), 5000);
      } else {
        this._status = "error";
        this._statusDetail = msg;
        log.error("telegram", `polling failed: ${msg}`);
      }
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendToUser(chatId: string, text: string): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(chatId, text);
      return true;
    } catch {
      return false;
    }
  }

  /** Synthesize the reply text and send it as a Telegram voice note. */
  private async sendVoiceReply(ctx: any, text: string): Promise<void> {
    await ctx.replyWithChatAction("record_voice").catch(() => {});
    const audio = await synthesizeSpeech(stripForSpeech(text));
    if (!audio) throw new Error("speech synthesis unavailable");
    await ctx.replyWithVoice(new InputFile(audio.data, audio.filename));
  }

  private async editMessage(
    ctx: any,
    messageId: number,
    text: string,
    useHtml = true,
  ): Promise<void> {
    const truncated =
      text.length > 4000 ? text.slice(-4000) + "\n...(truncated)" : text;
    const content = truncated || "...";
    if (!useHtml) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, messageId, content);
      } catch { /* ignore */ }
      return;
    }
    try {
      await ctx.api.editMessageText(ctx.chat.id, messageId, mdToHtml(content), { parse_mode: "HTML" });
    } catch {
      try {
        await ctx.api.editMessageText(ctx.chat.id, messageId, stripMarkdown(content));
      } catch { /* ignore */ }
    }
  }
}
