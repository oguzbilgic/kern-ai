import { createConnection, type Socket } from "net";
import { connect as tlsConnect } from "tls";
import type { Interface, StartOptions } from "./types.js";
import type { PairingManager } from "../pairing.js";
import { log } from "../log.js";
import { isNoReply } from "../util.js";

/**
 * IRC interface — plain TCP or TLS, IRCv3 message tags, DMs and channels.
 *
 * Configured with a single connection URL:
 *
 *   irc://vega@irc.example.com:6667/#homelab
 *   ircs://vega:password@irc.example.com:6697/#homelab,#agents
 *
 * Multiple servers: whitespace-separate several URLs (channels inside a URL
 * are comma-separated, so commas can't also separate URLs).
 *
 * Identity and spoofing
 * ---------------------
 * IRC nicks are not identities — anyone can `/nick oguz`. So the sender is
 * keyed on the *authenticated account* from the IRCv3 `account-tag`, not the
 * nick:
 *
 *   irc:<host>/<account>    authenticated (server-verified account)
 *   irc:<host>/~<nick>      unauthenticated (nick only, tilde-prefixed)
 *
 * Unauthenticated senders are never auto-paired — they always have to go
 * through a pairing code.
 *
 * Behaviour
 * ---------
 * - DMs are gated by the pairing manager, like Telegram/Slack/Matrix.
 * - Channels are open, but the agent only answers when its nick is mentioned.
 *   Everything else returns NO_REPLY, so agents don't talk over each other.
 * - Outbound text is converted to IRC formatting codes, wrapped to fit the
 *   512-byte line limit, and rate-limited to avoid flood kicks.
 *
 * Not implemented: SASL, CTCP beyond ACTION, DCC, media.
 */

/** One IRC server connection, parsed from a URL. */
export interface IrcServerConfig {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  password?: string;
  channels: string[];
}

/** A parsed IRC protocol line. */
export interface IrcLine {
  tags: Record<string, string>;
  prefix?: string;
  nick?: string;
  command: string;
  params: string[];
}

/** IRCv3 capabilities we ask for. All optional — we degrade gracefully. */
const WANTED_CAPS = ["account-tag", "message-tags", "server-time", "extended-join"];

/**
 * Max bytes of message text per PRIVMSG. The IRC line limit is 512 bytes
 * including `PRIVMSG <target> :` and CRLF; 400 leaves generous headroom for
 * long channel names and server-side prefix rewriting.
 */
const MAX_TEXT_BYTES = 400;

/** Max lines per reply before truncating, to stay clear of flood limits. */
const MAX_REPLY_LINES = 50;

/** Delay between outbound lines (ms). ~4 lines/sec. */
const SEND_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single `irc://` or `ircs://` URL.
 *
 * Channels come from the path, the fragment, or both — `#` starts a URL
 * fragment, so `irc://host/#a,#b` puts the channels in `hash` while
 * `irc://host/a,b` puts them in `pathname`. Both forms work, and a leading
 * `#` is added when missing.
 */
export function parseIrcUrl(raw: string): IrcServerConfig {
  const u = new URL(raw.trim());
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "irc" && scheme !== "ircs") {
    throw new Error(`unsupported scheme "${scheme}" (expected irc:// or ircs://)`);
  }
  if (!u.hostname) throw new Error("missing host");

  const tls = scheme === "ircs";
  // Channels may arrive in the path (`/a,b`), the fragment (`/#a,#b`), or both.
  // Strip each part's own leading marker before joining, so a URL carrying both
  // doesn't fuse the last path channel to the first fragment one ("b#c").
  const pathPart = u.pathname.replace(/^\//, "");
  const hashPart = u.hash.replace(/^#/, "");
  const chanPart = [pathPart, hashPart].filter(Boolean).join(",");
  const channels = chanPart
    .split(",")
    .map((c) => decodeURIComponent(c.trim()))
    .filter(Boolean)
    .map((c) => (/^[#&]/.test(c) ? c : `#${c}`));

  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : tls ? 6697 : 6667,
    tls,
    nick: decodeURIComponent(u.username) || "kern",
    password: u.password ? decodeURIComponent(u.password) : undefined,
    channels,
  };
}

/**
 * Best-effort redaction of a server password before an IRC URL reaches the log.
 * Applied to raw strings that may have failed to parse, so it cannot rely on
 * `new URL()` and works on the `scheme://user:pass@` prefix textually.
 */
export function redactIrcUrl(raw: string): string {
  return raw.replace(/^([a-z]+:\/\/[^/@:]*):[^/@]*@/i, "$1:***@");
}

/** Parse a whitespace-separated list of IRC URLs. Invalid entries are skipped. */
export function parseIrcUrls(raw?: string): IrcServerConfig[] {
  if (!raw) return [];
  const out: IrcServerConfig[] = [];
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    try {
      out.push(parseIrcUrl(part));
    } catch (err: any) {
      log.warn("irc", `ignoring invalid URL "${redactIrcUrl(part)}": ${err.message || err}`);
    }
  }
  return out;
}

/**
 * IRC is a line protocol, so a target containing whitespace or a CR/LF would
 * let a crafted `message` tool call append arbitrary commands to the line.
 * Targets are nicks or channels: no spaces, no control bytes, no leading ":"
 * (which would be read as a trailing parameter).
 */
export function isValidIrcTarget(target: string): boolean {
  if (!target || target.length > 200) return false;
  if (target.startsWith(":")) return false;
  return !/[\s\0\r\n,]/.test(target);
}

// ---------------------------------------------------------------------------
// Protocol line parsing
// ---------------------------------------------------------------------------

function unescapeTagValue(v: string): string {
  return v.replace(/\\(.)/g, (_, c) => {
    switch (c) {
      case ":": return ";";
      case "s": return " ";
      case "r": return "\r";
      case "n": return "\n";
      case "\\": return "\\";
      default: return c;
    }
  });
}

/**
 * Parse an IRC line: `[@tags] [:prefix] COMMAND [params] [:trailing]`.
 * Returns null for blank or malformed lines.
 */
export function parseIrcLine(line: string): IrcLine | null {
  let rest = line.replace(/[\r\n]+$/, "");
  const tags: Record<string, string> = {};

  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    for (const pair of rest.slice(1, sp).split(";")) {
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq < 0) tags[pair] = "";
      else tags[pair.slice(0, eq)] = unescapeTagValue(pair.slice(eq + 1));
    }
    rest = rest.slice(sp + 1).replace(/^ +/, "");
  }

  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).replace(/^ +/, "");
  }
  if (!rest) return null;

  const parts: string[] = [];
  while (rest.length) {
    if (rest.startsWith(":")) {
      parts.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(" ");
    if (sp < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1).replace(/^ +/, "");
  }

  const command = (parts.shift() || "").toUpperCase();
  if (!command) return null;

  return { tags, prefix, nick: prefix ? prefix.split("!")[0] : undefined, command, params: parts };
}

// ---------------------------------------------------------------------------
// Outbound formatting
// ---------------------------------------------------------------------------

const BOLD = "\x02";
const ITALIC = "\x1d";
const MONO = "\x11";

/**
 * Convert markdown to IRC formatting codes and drop constructs IRC can't
 * render (headers become bold, tables lose their separator rows, fences and
 * horizontal rules are dropped).
 */
function markdownToIrc(text: string): string {
  const out: string[] = [];
  let inFence = false;

  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r/g, "");

    // Code fences: drop the delimiter, keep the body verbatim.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Horizontal rules and table separator rows carry no information.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    if (/^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(line) && line.includes("-")) continue;

    // Headers become bold.
    line = line.replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/, `${BOLD}$1${BOLD}`);
    // Bullets become a real bullet character.
    line = line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    // Blockquotes lose the marker.
    line = line.replace(/^\s*>\s?/, "");
    // Links: keep the label, keep the URL visible.
    line = line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 <$2>");
    // Inline styling → IRC control codes.
    line = line.replace(/`([^`\n]+)`/g, `${MONO}$1${MONO}`);
    line = line.replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${BOLD}`);
    line = line.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,!?;:])/g, `$1${ITALIC}$2${ITALIC}`);

    out.push(line);
  }

  return out.join("\n");
}

/** Split a line into chunks of at most `max` bytes, preferring word breaks. */
function wrapToBytes(line: string, max: number): string[] {
  if (Buffer.byteLength(line) <= max) return [line];

  const out: string[] = [];
  let cur = "";

  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };

  for (const word of line.split(" ")) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (Buffer.byteLength(candidate) <= max) {
      cur = candidate;
      continue;
    }
    flush();
    if (Buffer.byteLength(word) <= max) {
      cur = word;
      continue;
    }
    // A single word longer than the limit — hard split on code points so we
    // never cut a multi-byte character in half.
    for (const ch of word) {
      if (Buffer.byteLength(cur + ch) > max) flush();
      cur += ch;
    }
  }

  flush();
  return out;
}

/**
 * Turn an agent reply into a list of PRIVMSG-safe lines.
 * Exported for tests.
 */
export function formatForIrc(text: string, maxLines = MAX_REPLY_LINES): string[] {
  const lines: string[] = [];
  for (const raw of markdownToIrc(text).split("\n")) {
    // IRC has no blank lines and no control characters other than formatting.
    const line = raw.replace(/[\x00\r\n]/g, "").trimEnd();
    if (!line.trim()) continue;
    lines.push(...wrapToBytes(line, MAX_TEXT_BYTES));
  }

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept.push(`[... ${lines.length - maxLines} more lines truncated]`);
    return kept;
  }
  return lines;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

type ConnStatus = "connected" | "disconnected" | "error";

class IrcConnection {
  readonly config: IrcServerConfig;
  private pairing: PairingManager | null;
  private onMessage: StartOptions["onMessage"] | null = null;

  private socket: Socket | null = null;
  private buffer = "";
  private running = false;
  private registered = false;
  private nick: string;
  private nickAttempt = 0;
  private caps = new Set<string>();

  private sendQueue: string[] = [];

  // One pairing code per (user, target) per process, so a shared channel or a
  // chatty client can't be used to spam codes.
  private sentCodes = new Set<string>();

  status: ConnStatus = "disconnected";
  statusDetail?: string;

  constructor(config: IrcServerConfig, pairing: PairingManager | null) {
    this.config = config;
    this.pairing = pairing;
    this.nick = config.nick;
  }

  get host(): string {
    return this.config.host;
  }

  start(onMessage: StartOptions["onMessage"]): void {
    this.onMessage = onMessage;
    this.running = true;
    this.connectLoop().catch((err) => {
      log.error("irc", `${this.host}: connect loop crashed: ${err.message || err}`);
      this.status = "error";
      this.statusDetail = err.message || String(err);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write("QUIT :kern shutting down\r\n");
      } catch {}
      this.socket.destroy();
    }
    this.socket = null;
    this.status = "disconnected";
  }

  /** Send text to a nick or channel. Returns false if not connected. */
  send(target: string, text: string): boolean {
    if (!this.socket || !this.registered) {
      // Dropping outbound text silently makes delivery unanswerable from the
      // log, which is exactly the failure mode this logging exists to close.
      log.warn(
        "irc",
        `${this.host}: dropped message to ${target} — not registered (${text.length} chars)`,
      );
      return false;
    }
    const lines = formatForIrc(text);
    for (const line of lines) {
      this.enqueue(`PRIVMSG ${target} :${line}`);
    }
    log("irc", `${this.host}: -> ${target}: ${lines.length} line(s), ${text.length} chars`);
    return true;
  }

  // -- connection lifecycle -------------------------------------------------

  private async connectLoop(): Promise<void> {
    let backoff = 1000;
    const maxBackoff = 60000;

    while (this.running) {
      try {
        await this.connectOnce();
        // connectOnce resolves when the socket closes. A connection that
        // survived registration gets a fresh backoff budget.
        if (this.registered) backoff = 1000;
      } catch (err: any) {
        this.status = "error";
        this.statusDetail = err.message || String(err);
        log.warn("irc", `${this.host}: ${this.statusDetail}`);
      }

      this.registered = false;
      this.caps.clear();
      if (!this.running) break;

      const jitter = 0.75 + Math.random() * 0.5;
      const wait = Math.min(backoff * jitter, maxBackoff);
      log("irc", `${this.host}: reconnecting in ${Math.round(wait)}ms`);
      await sleep(wait);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { host, port, tls } = this.config;
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        this.stopDrain();
        if (err) reject(err);
        else resolve();
      };

      const socket = tls
        ? tlsConnect({ host, port, servername: host })
        : createConnection({ host, port });

      this.socket = socket;
      this.buffer = "";
      this.nick = this.config.nick;
      this.nickAttempt = 0;

      socket.setTimeout(300000); // no traffic at all for 5min → treat as dead
      socket.on("timeout", () => {
        log.warn("irc", `${host}: socket timeout`);
        socket.destroy();
      });

      socket.on(tls ? "secureConnect" : "connect", () => {
        log("irc", `${host}:${port} socket open, registering as ${this.nick}`);
        this.startDrain();
        // CAP first so the server holds registration until CAP END.
        this.enqueue("CAP LS 302");
        if (this.config.password) this.enqueue(`PASS ${this.config.password}`);
        this.enqueue(`NICK ${this.nick}`);
        this.enqueue(`USER ${this.nick} 0 * :kern agent`);
      });

      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("error", (err: Error) => {
        this.status = "error";
        this.statusDetail = err.message;
        done(err);
      });
      socket.on("close", () => {
        // Don't stomp an "error" status set by the error handler — it's the
        // useful one, and it has to survive the whole reconnect backoff.
        if (this.status === "connected") this.status = "disconnected";
        done();
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    // Guard against a server that never sends a newline.
    if (this.buffer.length > 1_000_000) this.buffer = "";

    const lines = this.buffer.split("\r\n");
    this.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      if (!raw) continue;
      const line = parseIrcLine(raw);
      if (line) this.handleLine(line);
    }
  }

  // -- outbound queue ------------------------------------------------------

  private drainTimer: ReturnType<typeof setInterval> | null = null;

  private startDrain(): void {
    this.stopDrain();
    this.drainTimer = setInterval(() => {
      if (!this.socket || this.socket.destroyed) return;
      const line = this.sendQueue.shift();
      if (line === undefined) return;
      try {
        this.socket.write(`${line}\r\n`);
      } catch (err: any) {
        log.warn("irc", `${this.host}: write failed: ${err.message || err}`);
      }
    }, SEND_INTERVAL_MS);
  }

  private stopDrain(): void {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.sendQueue = [];
  }

  private enqueue(line: string): void {
    this.sendQueue.push(line);
  }

  /** PONG and other protocol replies jump the queue — they're latency-critical. */
  private sendNow(line: string): void {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(`${line}\r\n`);
    } catch {}
  }

  // -- protocol handling ---------------------------------------------------

  private handleLine(line: IrcLine): void {
    switch (line.command) {
      case "PING":
        this.sendNow(`PONG :${line.params[0] ?? ""}`);
        return;

      case "CAP": {
        // params: [target, subcommand, ...]
        const sub = (line.params[1] || "").toUpperCase();
        const list = (line.params[line.params.length - 1] || "").split(/\s+/).filter(Boolean);
        if (sub === "LS") {
          const offered = new Set(list.map((c) => c.split("=")[0]));
          const want = WANTED_CAPS.filter((c) => offered.has(c));
          // "*" as the third param means more CAP LS lines are coming.
          const more = line.params[2] === "*";
          if (want.length) this.enqueue(`CAP REQ :${want.join(" ")}`);
          if (!more) this.enqueue("CAP END");
        } else if (sub === "ACK") {
          for (const c of list) this.caps.add(c);
          log("irc", `${this.host}: caps ${[...this.caps].join(", ") || "none"}`);
        } else if (sub === "NAK") {
          log.warn("irc", `${this.host}: caps rejected: ${list.join(", ")}`);
        }
        return;
      }

      case "001": // RPL_WELCOME — registration complete
        this.registered = true;
        this.status = "connected";
        this.statusDetail = undefined;
        this.nick = line.params[0] || this.nick;
        log("irc", `${this.host}: registered as ${this.nick}`);
        for (const chan of this.config.channels) this.enqueue(`JOIN ${chan}`);
        return;

      case "432": // erroneous nickname
      case "433": // nickname in use
      case "436": { // nick collision
        if (this.registered) return;
        this.nickAttempt += 1;
        if (this.nickAttempt > 5) {
          log.error("irc", `${this.host}: could not find a free nick`);
          this.socket?.destroy();
          return;
        }
        this.nick = `${this.config.nick}${"_".repeat(this.nickAttempt)}`;
        log.warn("irc", `${this.host}: nick taken, trying ${this.nick}`);
        this.enqueue(`NICK ${this.nick}`);
        return;
      }

      case "NICK":
        // Track server- or user-forced renames of ourselves.
        if (line.nick === this.nick) this.nick = line.params[0] || this.nick;
        return;

      case "ERROR":
        this.statusDetail = line.params[0] || "server sent ERROR";
        log.warn("irc", `${this.host}: ${this.statusDetail}`);
        this.socket?.destroy();
        return;

      case "PRIVMSG":
        this.handlePrivmsg(line);
        return;

      default:
        return;
    }
  }

  private handlePrivmsg(line: IrcLine): void {
    const target = line.params[0] || "";
    let text = line.params[1] || "";
    const nick = line.nick;
    if (!nick || !target || !text) return;
    if (nick.toLowerCase() === this.nick.toLowerCase()) return; // our own echo

    // CTCP: only ACTION is meaningful as text, everything else is machine chatter.
    if (text.startsWith("\x01")) {
      const m = /^\x01ACTION\s+([\s\S]*?)\x01?$/.exec(text);
      if (!m) return;
      text = `* ${nick} ${m[1]}`;
    }

    const isChannel = /^[#&+!]/.test(target);
    const replyTo = isChannel ? target : nick;

    // Channels: only answer when addressed. Strip a leading "nick:" address.
    if (isChannel) {
      if (!this.isMentioned(text)) return;
      text = text.replace(new RegExp(`^\\s*@?${escapeRegex(this.nick)}\\s*[:,]?\\s*`, "i"), "").trim();
      if (!text) text = "(mentioned with no message)";
    }

    // Identity comes from the authenticated account, never the nick.
    // Servers signal "not logged in" either by omitting account-tag or by
    // sending the placeholder "*", so a bare truthiness check would key an
    // anonymous sender as `irc:<host>/*` and let them auto-pair.
    const account = line.tags["account"]?.trim();
    const authenticated = Boolean(account) && account !== "*";
    const userId = `irc:${this.host}/${authenticated ? account : `~${nick}`}`;
    const channel = `irc:${this.host}/${replyTo}`;

    this.handleIncoming({ userId, channel, replyTo, nick, text, isChannel, authenticated }).catch(
      (err) => log.error("irc", `${this.host}: handle failed: ${err.message || err}`),
    );
  }

  private isMentioned(text: string): boolean {
    const n = escapeRegex(this.nick);
    return new RegExp(`(^|[^\\w\\[\\]{}\\\\^\`|-])@?${n}([^\\w\\[\\]{}\\\\^\`|-]|$)`, "i").test(text);
  }

  private async handleIncoming(msg: {
    userId: string;
    channel: string;
    replyTo: string;
    nick: string;
    text: string;
    isChannel: boolean;
    authenticated: boolean;
  }): Promise<void> {
    const { userId, channel, replyTo, nick, text, isChannel, authenticated } = msg;
    log("irc", `${this.host}: ${nick} in ${replyTo}: ${text.slice(0, 80)}`);

    // Pairing gates DMs only — channels are open, like Slack/Telegram groups.
    if (!isChannel && this.pairing && !this.pairing.isPaired(userId)) {
      // Auto-pair the first user only if the server vouched for their account.
      // An unauthenticated nick is trivially spoofable, so it never gets a
      // free pass.
      if (!this.pairing.hasAnyPairedUsers() && authenticated) {
        await this.pairing.autoPairFirst(userId, "irc", `${this.host}/${replyTo}`);
      } else {
        const key = `${userId}\u0000${replyTo}`;
        if (this.sentCodes.has(key)) return;
        this.sentCodes.add(key);
        const code = await this.pairing.getOrCreateCode(userId, "irc", channel);
        const why = authenticated
          ? ""
          : " (you are not logged in to an account, so your nick cannot be verified)";
        this.send(
          replyTo,
          `You are not paired with this agent${why}. Pairing code: ${code} — share it with the operator to get access.`,
        );
        return;
      }
    }

    if (!this.onMessage) return;

    try {
      const response = await this.onMessage(
        { text, userId, chatId: `${this.host}/${replyTo}`, interface: "irc", channel },
        () => {}, // no streaming — IRC gets the final text
      );
      if (isNoReply(response)) return;
      this.send(replyTo, response);
    } catch (err: any) {
      const reason = String(err?.message || err || "unknown error");
      log.error("irc", `${this.host}: turn failed in ${replyTo}: ${reason}`);
      // Surface the failure in channels too. Silence is worse than a short
      // error line — it looks identical to the agent ignoring the message,
      // which is impossible to debug from the other side. One line, capped,
      // addressed to the sender so it reads as a reply and not as spam.
      const line = isChannel
        ? `${nick}: turn failed — ${reason.slice(0, 200)}`
        : `Error processing message: ${reason.slice(0, 200)}`;
      this.send(replyTo, line);
    }
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export class IrcInterface implements Interface {
  private connections: IrcConnection[];

  constructor(servers: IrcServerConfig[], pairing?: PairingManager) {
    this.connections = servers.map((s) => new IrcConnection(s, pairing || null));
  }

  get status(): ConnStatus {
    if (!this.connections.length) return "disconnected";
    if (this.connections.some((c) => c.status === "connected")) return "connected";
    if (this.connections.every((c) => c.status === "error")) return "error";
    return "disconnected";
  }

  get statusDetail(): string | undefined {
    const parts = this.connections
      .map((c) => `${c.host}: ${c.status}${c.statusDetail ? ` (${c.statusDetail})` : ""}`)
      .filter(Boolean);
    return parts.length ? parts.join("; ") : undefined;
  }

  async start({ onMessage }: StartOptions): Promise<void> {
    // Non-blocking: each connection retries on its own and reports via status.
    for (const conn of this.connections) conn.start(onMessage);
  }

  async stop(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.stop().catch(() => {})));
  }

  /**
   * Send to a `<host>/<target>` address, where target is a nick or a channel.
   * This is the chatId stored by the pairing manager.
   */
  async sendToUser(chatId: string, text: string): Promise<boolean> {
    const slash = chatId.indexOf("/");
    if (slash < 0) return false;
    const host = chatId.slice(0, slash);
    const target = chatId.slice(slash + 1);
    if (!host || !isValidIrcTarget(target)) {
      log.warn("irc", `refusing to send to invalid target "${target}"`);
      return false;
    }

    const conn = this.connections.find((c) => c.host === host);
    if (!conn) {
      log.warn("irc", `no connection for host "${host}"`);
      return false;
    }
    return conn.send(target, text);
  }
}
