// @ts-ignore — bolt CJS/ESM interop
import { App as SlackApp } from "@slack/bolt";
import type { Attachment, Interface, StartOptions } from "./types.js";
import type { PairingManager } from "../pairing.js";
import { log } from "../log.js";
import { isNoReply } from "../util.js";
import { BARE_MENTION_TEXT, MentionGate, SentIds } from "../mentions.js";
import { synthesizeSpeech, stripForSpeech, ttsAvailable } from "../tts.js";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function mdToSlack(text: string): string {
  let s = text;
  // Code blocks — leave as-is, Slack supports ```
  // Bold: **text** → *text*
  s = s.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Italic: *text* → _text_ (but not inside bold)
  // Skip — after converting **→*, single * is now bold in Slack
  // Strikethrough: ~~text~~ → ~text~
  s = s.replace(/~~(.+?)~~/g, "~$1~");
  // Lists: - item stays as-is, Slack renders them
  return s;
}

/** Map MIME type to attachment type */
function mimeToType(mime: string): Attachment["type"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export class SlackInterface implements Interface {
  private app: InstanceType<typeof SlackApp>;
  private pairing: PairingManager | null;
  private botUserId: string = "";
  private botToken: string;
  private gate: MentionGate | null;
  /** `ts` of messages we posted, so thread replies to them read as addressed. */
  private sentTs = new SentIds();
  private _status: "connected" | "disconnected" | "error" = "disconnected";
  private _statusDetail?: string;

  constructor(botToken: string, appToken: string, pairing?: PairingManager, gate?: MentionGate) {
    this.app = new SlackApp({
      token: botToken,
      appToken,
      socketMode: true,
    });
    this.botToken = botToken;
    this.pairing = pairing || null;
    this.gate = gate || null;
  }

  get status() { return this._status; }
  get statusDetail() { return this._statusDetail; }

  async start({ onMessage }: StartOptions): Promise<void> {
    // Get bot's own user ID so we can detect @mentions and ignore own messages
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string || "";
      // logged below with started
    } catch {}

    // Listen to all messages
    this.app.message(async ({ message, say, client }: any) => {
      // Skip bot messages, message_changed events, and messages with no content
      const hasUser = "user" in message;
      const hasText = "text" in message && message.text !== undefined;
      const hasFiles = "files" in message;
      if (!hasUser || (!hasText && !hasFiles)) return;
      if (message.user === this.botUserId) return;

      const userId = message.user;
      // Use blocks text if available (richer), fall back to message.text
      let text = message.text || "";
      if (message.blocks) {
        try {
          const blockText = message.blocks
            .filter((b: any) => b.type === "rich_text")
            .flatMap((b: any) => b.elements || [])
            .flatMap((e: any) => e.elements || [])
            .filter((e: any) => e.type === "text" || e.type === "link" || e.type === "user")
            .map((e: any) => {
              if (e.type === "text") return e.text;
              if (e.type === "link") return e.url;
              if (e.type === "user") return `<@${e.user_id}>`;
              return "";
            })
            .join("");
          if (blockText.length > text.length) text = blockText;
        } catch {}
      }
      const channelId = message.channel;
      const threadTs = ("thread_ts" in message ? message.thread_ts : undefined) as string | undefined;

      // Download file attachments
      const attachments: Attachment[] = [];
      if (message.files && Array.isArray(message.files)) {
        for (const file of message.files) {
          try {
            if (file.size && file.size > MAX_FILE_SIZE) {
              log.warn("slack", `file too large (${(file.size / 1024 / 1024).toFixed(1)}MB), skipping: ${file.name}`);
              continue;
            }
            const url = file.url_private_download || file.url_private;
            if (!url) continue;
            const resp = await fetch(url, {
              headers: { Authorization: `Bearer ${this.botToken}` },
            });
            if (!resp.ok) {
              log.warn("slack", `file download failed: ${resp.status} for ${file.name}`);
              continue;
            }
            const buffer = Buffer.from(await resp.arrayBuffer());
            const mime = file.mimetype || "application/octet-stream";
            attachments.push({
              type: mimeToType(mime),
              data: buffer,
              mimeType: mime,
              filename: file.name,
              size: buffer.length,
            });
          } catch (err: any) {
            log.warn("slack", `file download error: ${err.message}`);
          }
        }
      }

      const hasContent = text || attachments.length > 0;
      if (!hasContent) return;

      log("slack", `message from ${userId} in ${channelId}: ${(text || "[media]").slice(0, 50)}${attachments.length ? ` +${attachments.length} file(s)` : ""}`);

      // Determine if DM or channel
      let channelName = channelId;
      let isDM = false;
      // Whether we actually know which it is. A failed lookup used to only
      // mislabel the channel; under gating it would silently mute a DM, so the
      // unknown case passes through ungated.
      let kindKnown = false;
      try {
        const info = await client.conversations.info({ channel: channelId });
        if (info.channel) {
          isDM = info.channel.is_im || false;
          channelName = isDM ? `slack-dm:${userId}` : `#${info.channel.name || channelId}`;
          kindKnown = true;
        }
      } catch (err: any) {
        log.warn("slack", `conversations.info failed for ${channelId}, not gating: ${err.message || err}`);
      }

      // Check pairing for DMs
      if (isDM && this.pairing && !this.pairing.isPaired(userId)) {
        if (!this.pairing.hasAnyPairedUsers()) {
          await this.pairing.autoPairFirst(userId, "slack", channelId);
        } else {
          const code = await this.pairing.getOrCreateCode(userId, "slack", channelName);
          await say(`You're not paired with this agent.\n\nYour pairing code: *${code}*\n\nShare this code with the agent's operator to get access.`);
          return;
        }
      }

      // Detect @mention
      const isMentioned = text.includes(`<@${this.botUserId}>`);
      // A thread reply under one of our own messages is addressed to us even
      // without a mention. `parent_user_id` is set by Slack on thread replies;
      // `sentTs` covers threads we rooted in this process as a fallback.
      const isReplyToUs =
        ("parent_user_id" in message && message.parent_user_id === this.botUserId) ||
        this.sentTs.has(threadTs);
      const addressed = isMentioned || isReplyToUs;
      // Clean @mention from text
      let cleanText = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();

      // If just a bare mention with no text and no files, skip
      if (!cleanText && !isMentioned && attachments.length === 0) return;
      // If mentioned with no text, use "hello" as default
      if (!cleanText && isMentioned && attachments.length === 0) cleanText = BARE_MENTION_TEXT;

      // Build channel label
      const channelLabel = isDM ? `slack-dm` : channelName;
      const channelKey = `slack:${channelId}`;

      // Channels: stay quiet unless addressed. The message is still observed
      // and folded into the next addressed turn, so we keep the thread of the
      // conversation without speaking in it uninvited.
      // `botUserId` empty means auth.test() failed and we cannot recognize our
      // own mentions — pass everything through rather than going mute.
      if (!isDM && kindKnown && this.gate?.active && this.botUserId && !addressed) {
        this.gate.observe(channelKey, `<@${userId}>`, cleanText || "[media]");
        log("slack", `not addressed in ${channelName}, observing (${this.gate.pending(channelKey)} buffered)`);
        return;
      }

      // We're taking a turn on this message. If it's in a thread, remember the
      // thread — our reply goes to the channel, not the thread, so without this
      // an in-thread follow-up would look unaddressed.
      if (threadTs) this.sentTs.add(threadTs);

      // Fold anything observed in this channel since we last spoke into the
      // message the model sees.
      const outboundText = isDM
        ? cleanText || ""
        : this.gate?.withContext(channelKey, cleanText || "") || cleanText || "";

      try {
        const response = await onMessage(
          {
            text: outboundText,
            userId,
            chatId: channelId,
            interface: "slack",
            channel: channelLabel,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
          () => {}, // events handled by SSE broadcast in app.ts
        );

        // NO_REPLY suppression — matches empty, "(no text response)", or any
        // reply ending with NO_REPLY (model explaining then suppressing).
        if (!isNoReply(response)) {
          // Voice in → voice out: if the user sent an audio clip, reply with
          // synthesized audio instead of text. Falls back to text on failure
          // (e.g. missing files:write scope or no TTS provider).
          const voiceIn = attachments.some((a) => a.type === "audio");
          if (voiceIn && ttsAvailable()) {
            try {
              const audio = await synthesizeSpeech(stripForSpeech(response));
              if (!audio) throw new Error("synthesis unavailable");
              await client.files.uploadV2({
                channel_id: channelId,
                thread_ts: threadTs,
                file: audio.data,
                filename: audio.filename,
                title: "Voice reply",
              });
            } catch (err: any) {
              log.warn("slack", `voice reply failed, falling back to text: ${err.message}`);
              this.sentTs.add((await say(mdToSlack(response)))?.ts as string | undefined);
            }
          } else {
            this.sentTs.add((await say(mdToSlack(response)))?.ts as string | undefined);
          }
        }
      } catch (error: any) {
        if (isDM) {
          await say(`Error: ${error.message}`);
        }
      }
    });

    await this.app.start();
    this._status = "connected";
    log("slack", `connected (${this.botUserId})`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  async sendToUser(channelId: string, text: string): Promise<boolean> {
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text,
      });
      return true;
    } catch {
      return false;
    }
  }
}
