import type { Interface, StartOptions } from "./types.js";
import type { PairingManager } from "../pairing.js";
import { log } from "../log.js";
import { isNoReply } from "../util.js";

/**
 * Matrix interface — long-polls /sync, accepts invites, replies via /send.
 *
 * MVP scope:
 * - Text messages in/out
 * - Typing indicators while the agent is thinking
 * - Auto-accept invites (any inviter; pairing still gates message handling)
 * - Pairing enforced in every room (DM and group) before messages are processed
 * - No E2E encryption, no media, no reactions
 *
 * Config via env:
 *   MATRIX_HOMESERVER     e.g. http://matrix:8008
 *   MATRIX_USER_ID        e.g. @vega:matrix
 *   MATRIX_ACCESS_TOKEN   from login/register
 */
export class MatrixInterface implements Interface {
  private homeserver: string;
  private userId: string;
  private token: string;
  private pairing: PairingManager | null;
  private nextBatch: string | null = null;
  private running = false;
  private abort: AbortController | null = null;
  private _status: "connected" | "disconnected" | "error" = "disconnected";
  private _statusDetail?: string;
  // Gate pairing-code messages so we only send once per (user, room) per process.
  // Prevents agent-to-agent loops in shared rooms.
  private sentCodes = new Set<string>();

  constructor(
    homeserver: string,
    userId: string,
    token: string,
    pairing?: PairingManager,
  ) {
    // Strip trailing slash for clean URL joins
    this.homeserver = homeserver.replace(/\/$/, "");
    this.userId = userId;
    this.token = token;
    this.pairing = pairing || null;
  }

  get status() { return this._status; }
  get statusDetail() { return this._statusDetail; }

  async start({ onMessage }: StartOptions): Promise<void> {
    // Don't block startup on homeserver availability. The sync loop will
    // prime nextBatch on its first successful poll and recover from any
    // initial outage on its own.
    this.running = true;
    this.syncLoop(onMessage).catch((err) => {
      log.error("matrix", `sync loop crashed: ${err.message || err}`);
      this._status = "error";
      this._statusDetail = err.message || String(err);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this._status = "disconnected";
  }

  async sendToUser(roomId: string, text: string): Promise<boolean> {
    try {
      await this.sendMessage(roomId, text);
      return true;
    } catch (err: any) {
      log.warn("matrix", `sendToUser failed: ${err.message || err}`);
      return false;
    }
  }

  private async syncLoop(
    onMessage: StartOptions["onMessage"],
  ): Promise<void> {
    let backoff = 1000;
    const maxBackoff = 60000;

    while (this.running) {
      this.abort = new AbortController();
      try {
        // If we don't have a cursor yet (first connect or recovered after
        // total outage), prime with timeout=0 and SKIP processing events —
        // the initial sync returns recent room history which would replay
        // as incoming messages. Only events arriving after the cursor is
        // established should be delivered.
        const cursor = this.nextBatch;
        const priming = cursor == null;
        const path = priming
          ? `/_matrix/client/v3/sync?timeout=0`
          : `/_matrix/client/v3/sync?since=${encodeURIComponent(cursor!)}&timeout=30000`;

        const sync = await this.api<MatrixSync>("GET", path, undefined, this.abort.signal);
        const wasDown = this._status !== "connected";
        this.nextBatch = sync.next_batch;
        this._status = "connected";
        this._statusDetail = undefined;
        if (wasDown) {
          log("matrix", `connected as ${this.userId}`);
        }
        backoff = 1000;

        // Accept invites — always, even during priming. Sync only reports
        // invites in the delta, so if we skipped them on first connect, any
        // invites that arrived while offline would be missed until the inviter
        // retries.
        const invites = sync.rooms?.invite || {};
        for (const roomId of Object.keys(invites)) {
          try {
            await this.api("POST", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`);
            log("matrix", `joined ${roomId}`);
          } catch (err: any) {
            log.warn("matrix", `failed to join ${roomId}: ${err.message || err}`);
          }
        }

        // Skip timeline processing on the priming sync — it would replay
        // recent room history as incoming messages. Only events arriving
        // after the cursor is established should be delivered.
        if (priming) continue;

        // Process new messages in joined rooms
        const joins = sync.rooms?.join || {};
        for (const [roomId, room] of Object.entries(joins)) {
          const events = room.timeline?.events || [];
          for (const ev of events) {
            if (ev.type !== "m.room.message") continue;
            if (ev.sender === this.userId) continue; // our own sends
            if (ev.content?.msgtype !== "m.text") continue; // skip media for MVP
            const body = ev.content.body || "";
            if (!body) continue;
            // Fire and forget — don't block the sync loop on a long turn
            this.handleIncoming(roomId, ev.sender, body, onMessage).catch((err) => {
              log.error("matrix", `handle incoming failed: ${err.message || err}`);
            });
          }
        }
      } catch (err: any) {
        if (err.name === "AbortError" || !this.running) break;
        this._status = "error";
        this._statusDetail = err.message || String(err);

        // Fatal auth errors — token revoked, wrong homeserver, etc. No point retrying.
        const msg = this._statusDetail || "";
        if (/\b(401|403)\b/.test(msg) || /M_UNKNOWN_TOKEN|M_MISSING_TOKEN|M_FORBIDDEN/.test(msg)) {
          log.error("matrix", `auth failed, stopping sync loop: ${msg}`);
          this.running = false;
          break;
        }

        // Exponential backoff with jitter. Resets to 1s after any successful sync.
        const jitter = 0.75 + Math.random() * 0.5; // ±25%
        const wait = Math.min(backoff * jitter, maxBackoff);
        log.warn("matrix", `sync error, retrying in ${Math.round(wait)}ms: ${msg}`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  private async handleIncoming(
    roomId: string,
    sender: string,
    text: string,
    onMessage: StartOptions["onMessage"],
  ): Promise<void> {
    log("matrix", `message from ${sender} in ${roomId}: ${text.slice(0, 80)}`);

    // Pairing: auto-pair first user, gate others
    if (this.pairing && !this.pairing.isPaired(sender)) {
      if (!this.pairing.hasAnyPairedUsers()) {
        await this.pairing.autoPairFirst(sender, "matrix", roomId);
      } else {
        // Both Matrix user IDs and room IDs contain colons, so use a
        // structured key to avoid delimiter collisions.
        const key = JSON.stringify([sender, roomId]);
        if (this.sentCodes.has(key)) return;
        this.sentCodes.add(key);
        const code = await this.pairing.getOrCreateCode(sender, "matrix", `matrix:${roomId}`);
        await this.sendMessage(
          roomId,
          `${sender} is not paired with this agent.\n\nPairing code: ${code}\n\nShare this code with the agent's operator to approve access.`,
        );
        return;
      }
    }

    // Keep typing indicator alive while the turn runs. Matrix clients like Cinny
    // clear the typing indicator if not refreshed within ~10 seconds.
    const typingInterval = setInterval(() => {
      this.setTyping(roomId, true).catch(() => {});
    }, 6000);
    await this.setTyping(roomId, true).catch(() => {});

    try {
      const response = await onMessage(
        {
          text,
          userId: sender,
          chatId: roomId,
          interface: "matrix",
          channel: `matrix:${roomId}`,
        },
        // Ignore stream events for MVP — reply with final text only
        () => {},
      );

      clearInterval(typingInterval);
      await this.setTyping(roomId, false).catch(() => {});

      const reply = (response || "").trim();
      if (isNoReply(reply)) return;
      await this.sendMessage(roomId, reply);
    } catch (err: any) {
      clearInterval(typingInterval);
      await this.setTyping(roomId, false).catch(() => {});
      const reason = String(err?.message || err || "Error processing message.");
      log.error("matrix", `turn failed in ${roomId}: ${reason}`);
      await this.sendMessage(roomId, `⚠️ ${reason.slice(0, 300)}`).catch(() => {});
    }
  }

  private async sendMessage(roomId: string, body: string): Promise<void> {
    const txnId = `kern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const formatted = mdToMatrixHtml(body);
    const payload: Record<string, unknown> = {
      msgtype: "m.text",
      body,
    };
    if (formatted) {
      payload.format = "org.matrix.custom.html";
      payload.formatted_body = formatted;
    }

    await this.api(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      payload,
    );
  }

  private async setTyping(roomId: string, typing: boolean): Promise<void> {
    await this.api(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId)}`,
      typing ? { typing: true, timeout: 30000 } : { typing: false },
    );
  }

  private async api<T = any>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.homeserver}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`matrix ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert markdown to Matrix-compliant HTML (`org.matrix.custom.html`).
 * Returns undefined if no markdown constructs are detected.
 */
export function mdToMatrixHtml(text: string): string | undefined {
  if (!/[*_`~#\[\]>-]/.test(text)) {
    return undefined;
  }

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escapedCode = escapeHtml(code.replace(/\n$/, ""));
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    const placeholder = `\x00BLOCK_${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${langAttr}>${escapedCode}</code></pre>`);
    return placeholder;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`\n]+)`/g, (_, code) => {
    const placeholder = `\x00INLINE_${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // 3. Escape raw HTML entities in remaining text
  html = escapeHtml(html);

  // 4. Headers: # Heading -> <h1>Heading</h1>
  html = html.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  html = html.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // 5. Blockquotes: &gt; line (since &gt; was escaped from >)
  html = html.replace(/^&gt;\s*(.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "<br />");

  // 6. Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // 7. Bold: **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__(.+?)__/g, "<strong>$1</strong>");

  // 8. Italic: *text* or _text_
  html = html.replace(/(?<![*<])\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");

  // 9. Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // 10. Unordered lists: - item or * item
  html = html.replace(/^[*-]\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>(\n|$))+/g, (match) => `<ul>\n${match.trimEnd()}\n</ul>\n`);

  // 11. Restore inline code and code blocks
  inlineCodes.forEach((code, i) => {
    html = html.replace(`\x00INLINE_${i}\x00`, code);
  });
  codeBlocks.forEach((block, i) => {
    html = html.replace(`\x00BLOCK_${i}\x00`, block);
  });

  // 12. Convert newlines to <br /> outside pre/ul/blockquote/h1-6 tags
  const parts = html.split(
    /(<pre>[\s\S]*?<\/pre>|<ul>[\s\S]*?<\/ul>|<h[1-6]>[\s\S]*?<\/h[1-6]>|<blockquote>[\s\S]*?<\/blockquote>)/g,
  );
  html = parts
    .map((part) => {
      if (
        part.startsWith("<pre>") ||
        part.startsWith("<ul>") ||
        part.startsWith("<h") ||
        part.startsWith("<blockquote>")
      ) {
        return part;
      }
      return part.replace(/\n/g, "<br />");
    })
    .join("");

  return html;
}

// Minimal typings for the parts of /sync we care about
interface MatrixSync {
  next_batch: string;
  rooms?: {
    invite?: Record<string, unknown>;
    join?: Record<string, {
      timeline?: { events?: MatrixEvent[] };
    }>;
  };
}

interface MatrixEvent {
  type: string;
  sender: string;
  content?: {
    msgtype?: string;
    body?: string;
  };
}
