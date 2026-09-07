import { Relay } from "nostr-tools/relay";
import WebSocket from "ws";
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from "nostr-tools/pure";
import * as nip04 from "nostr-tools/nip04";
import * as nip17 from "nostr-tools/nip17";
import * as nip19 from "nostr-tools/nip19";
import type { Interface, StartOptions } from "./types.js";
import type { PairingManager } from "../pairing.js";
import { log } from "../log.js";
import { isNoReply } from "../util.js";

/**
 * Nostr interface — encrypted DMs (NIP-04, kind 4) over one or more relays.
 *
 * MVP scope:
 * - Kind 4 encrypted DMs in/out (what every Nostr client supports today)
 * - Multi-relay: subscribe to all, dedupe by event id, publish to all
 * - Reconnect with backoff; missed events replayed via `since` on resubscribe
 * - Pairing gated per sender (npub is the userId)
 * - No channels (kind 42), no NIP-44/gift-wrap, no media
 *
 * Config:
 *   NOSTR_NSEC      (.env)        agent identity, bech32 nsec
 *   nostrRelays     (config.json) relay URLs; omit for public defaults
 *   NOSTR_RELAYS    (.env)        comma-separated override of nostrRelays
 */

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

/** Parse a comma-separated relay list; drops blanks, trims, keeps order. */
export function parseRelayList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Decode an nsec (bech32) or 64-char hex secret key into bytes. */
export function decodeSecretKey(input: string): Uint8Array {
  const s = input.trim();
  if (s.startsWith("nsec1")) {
    const { type, data } = nip19.decode(s);
    if (type !== "nsec") throw new Error("not an nsec");
    return data as Uint8Array;
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return Uint8Array.from(Buffer.from(s, "hex"));
  throw new Error("NOSTR_NSEC must be a bech32 nsec1… or 64-char hex secret key");
}

/** Accept npub (bech32) or hex pubkey; return hex. */
export function toHexPubkey(input: string): string {
  const s = input.trim();
  if (s.startsWith("npub1")) {
    const { type, data } = nip19.decode(s);
    if (type !== "npub") throw new Error("not an npub");
    return data as string;
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  throw new Error(`invalid nostr pubkey: ${s.slice(0, 16)}…`);
}

export class NostrInterface implements Interface {
  private sk: Uint8Array;
  private pk: string;
  private npub: string;
  private relayUrls: string[];
  private pairing: PairingManager | null;
  private relays = new Map<string, Relay>();
  private running = false;
  private startedAt = 0;
  private _status: "connected" | "disconnected" | "error" = "disconnected";
  private _statusDetail?: string;
  // Dedupe across relays — the same event arrives from every relay we're on.
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  // Gate pairing-code messages to once per sender per process.
  private sentCodes = new Set<string>();
  private announced = false;
  // Remember if a sender talked via NIP-17 (gift wrap) or legacy NIP-04
  private senderMode = new Map<string, "nip17" | "nip04">();

  constructor(nsec: string, relays: string[], pairing?: PairingManager) {
    this.sk = decodeSecretKey(nsec);
    this.pk = getPublicKey(this.sk);
    this.npub = nip19.npubEncode(this.pk);
    this.relayUrls = relays.length ? relays : DEFAULT_RELAYS;
    this.pairing = pairing || null;
  }

  get status() { return this._status; }
  get statusDetail() { return this._statusDetail; }
  get publicKey() { return this.npub; }

  async start({ onMessage }: StartOptions): Promise<void> {
    this.running = true;
    this.startedAt = Math.floor(Date.now() / 1000);
    log("nostr", `identity ${this.npub}`);
    // Non-blocking: each relay gets its own connect loop. Status flips to
    // connected once any relay is up; error if none are.
    for (const url of this.relayUrls) {
      this.relayLoop(url, onMessage).catch((err) => {
        log.error("nostr", `relay loop crashed for ${url}: ${err.message || err}`);
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const relay of this.relays.values()) {
      try { relay.close(); } catch {}
    }
    this.relays.clear();
    this._status = "disconnected";
  }

  async sendToUser(userId: string, text: string): Promise<boolean> {
    try {
      const to = toHexPubkey(userId);
      const mode = this.senderMode.get(to) || "nip17";
      return await this.sendDM(to, text, mode);
    } catch (err: any) {
      log.warn("nostr", `sendToUser failed: ${err.message || err}`);
      return false;
    }
  }

  private async relayLoop(url: string, onMessage: StartOptions["onMessage"]): Promise<void> {
    let backoff = 1000;
    const maxBackoff = 60000;

    while (this.running) {
      // enableReconnect: after a successful first connect, nostr-tools
      // reconnects on its own and re-fires open subscriptions with
      // `since = lastEmitted + 1`, so DMs that landed while we were
      // disconnected are replayed. It does NOT retry a failed *initial*
      // connect — that's what this outer loop is for.
      // Use `ws`, not Node's built-in WebSocket: nostr-tools calls ws.close()
      // from its onerror handler, and undici's WebSocket re-fires error on
      // close → infinite recursion → RangeError, process down.
      const relay = new Relay(url, { enableReconnect: true, websocketImplementation: WebSocket } as any);
      this.relays.set(url, relay);

      let closed: () => void = () => {};
      const closedPromise = new Promise<void>((r) => { closed = r; });
      relay.onclose = () => closed();

      try {
        await relay.connect({ timeout: 10000 });
        backoff = 1000;
        this.markConnected(url);

        const twoDaysAgo = Math.max(0, this.startedAt - 172800);
        relay.subscribe(
          [
            { kinds: [4], "#p": [this.pk], since: this.startedAt },
            { kinds: [1059], "#p": [this.pk], since: twoDaysAgo },
          ],
          {
            onevent: (ev) => this.onEvent(ev, url, onMessage),
            onclose: (reason) => log.warn("nostr", `${url} subscription closed: ${reason}`),
          },
        );

        // Block until the relay gives up (only happens when nostr-tools'
        // own reconnect is exhausted or we called stop()).
        await closedPromise;
        if (!this.running) break;
        this.markDisconnected(url, "connection closed");
      } catch (err: any) {
        if (!this.running) break;
        this.markDisconnected(url, String(err?.message || err));
        try { relay.close(); } catch {}
        const jitter = 0.75 + Math.random() * 0.5;
        const wait = Math.min(backoff * jitter, maxBackoff);
        log.warn("nostr", `${url} connect failed, retrying in ${Math.round(wait)}ms: ${err?.message || err}`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
    this.relays.delete(url);
  }

  private connectedUrls = new Set<string>();

  private markConnected(url: string) {
    const wasDown = this.connectedUrls.size === 0;
    this.connectedUrls.add(url);
    this._status = "connected";
    this._statusDetail = `${this.connectedUrls.size}/${this.relayUrls.length} relays`;
    if (wasDown) {
      log("nostr", `connected via ${url}`);
      if (!this.announced) {
        this.announced = true;
        this.announceRelays().catch((err) => {
          log.warn("nostr", `failed to announce relays: ${err.message || err}`);
        });
      }
    }
  }

  private markDisconnected(url: string, reason: string) {
    this.connectedUrls.delete(url);
    if (this.connectedUrls.size === 0) {
      this._status = "error";
      this._statusDetail = `no relays reachable (last: ${url}: ${reason})`;
    } else {
      this._statusDetail = `${this.connectedUrls.size}/${this.relayUrls.length} relays`;
    }
  }

  private remember(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 5000) {
      const drop = this.seenOrder.splice(0, 1000);
      for (const d of drop) this.seen.delete(d);
    }
    return true;
  }

  private onEvent(ev: NostrEvent, url: string, onMessage: StartOptions["onMessage"]) {
    if (ev.pubkey === this.pk) return; // our own sends echoed back
    if (!this.remember(ev.id)) return; // already handled via another relay

    let text: string;
    let senderPk: string;
    let mode: "nip17" | "nip04";

    if (ev.kind === 1059) {
      // NIP-17 / NIP-59 Gift Wrap (kind 1059 -> seal kind 13 -> rumor kind 14)
      try {
        const rumor = nip17.unwrapEvent(ev as any, this.sk);
        senderPk = rumor.pubkey;
        text = rumor.content;
        mode = "nip17";
        if (rumor.id) this.remember(rumor.id);
      } catch (err: any) {
        log.warn("nostr", `unwrap gift wrap failed for ${ev.id.slice(0, 8)}: ${err.message || err}`);
        return;
      }
    } else if (ev.kind === 4) {
      // Legacy NIP-04 encrypted DM
      senderPk = ev.pubkey;
      mode = "nip04";
      try {
        text = nip04.decrypt(this.sk, ev.pubkey, ev.content);
      } catch (err: any) {
        log.warn("nostr", `decrypt failed for ${ev.id.slice(0, 8)} from ${ev.pubkey.slice(0, 8)}: ${err.message || err}`);
        return;
      }
    } else {
      return;
    }

    if (!text.trim()) return;
    this.senderMode.set(senderPk, mode);

    // Fire and forget — don't block the relay socket on a long turn
    this.handleIncoming(senderPk, text, mode, onMessage).catch((err) => {
      log.error("nostr", `handle incoming failed: ${err.message || err}`);
    });
  }

  private async handleIncoming(
    senderPk: string,
    text: string,
    mode: "nip17" | "nip04",
    onMessage: StartOptions["onMessage"],
  ): Promise<void> {
    const sender = nip19.npubEncode(senderPk);
    log("nostr", `message [${mode}] from ${sender.slice(0, 16)}…: ${text.slice(0, 80)}`);

    // Pairing: auto-pair first user, gate others
    if (this.pairing && !this.pairing.isPaired(sender)) {
      if (!this.pairing.hasAnyPairedUsers()) {
        await this.pairing.autoPairFirst(sender, "nostr", sender);
      } else {
        if (this.sentCodes.has(sender)) return;
        this.sentCodes.add(sender);
        const code = await this.pairing.getOrCreateCode(sender, "nostr", `nostr:${sender}`);
        await this.sendDM(
          senderPk,
          `${sender} is not paired with this agent.\n\nPairing code: ${code}\n\nShare this code with the agent's operator to approve access.`,
          mode,
        );
        return;
      }
    }

    try {
      const response = await onMessage(
        {
          text,
          userId: sender,
          chatId: sender,
          interface: "nostr",
          channel: `nostr:${sender}`,
        },
        () => {}, // no streaming/typing in Nostr — final text only
      );
      const reply = (response || "").trim();
      if (isNoReply(reply)) return;
      await this.sendDM(senderPk, reply, mode);
    } catch (err: any) {
      log.error("nostr", `turn failed for ${sender}: ${err.message || err}`);
      await this.sendDM(senderPk, "Error processing message.", mode).catch(() => {});
    }
  }

  /** Encrypt, sign, and publish a DM (NIP-17 gift wrap or legacy NIP-04) to every connected relay. */
  private async sendDM(toPk: string, text: string, mode: "nip17" | "nip04" = "nip17"): Promise<boolean> {
    let event: NostrEvent;

    if (mode === "nip17") {
      // NIP-17 / NIP-59: Gift wrap (kind 1059) containing rumor (kind 14)
      event = nip17.wrapEvent(this.sk, { publicKey: toPk }, text) as NostrEvent;
    } else {
      // Legacy NIP-04 (kind 4)
      const content = nip04.encrypt(this.sk, toPk, text);
      event = finalizeEvent(
        {
          kind: 4,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", toPk]],
          content,
        },
        this.sk,
      );
    }

    // Our own message comes back on the subscription; skip it there.
    this.remember(event.id);

    const targets = [...this.relays.values()].filter((r) => r.connected);
    if (targets.length === 0) {
      log.warn("nostr", "sendDM: no connected relays");
      return false;
    }
    const results = await Promise.allSettled(targets.map((r) => r.publish(event)));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok === 0) {
      const reasons = results
        .map((r) => (r.status === "rejected" ? String(r.reason?.message || r.reason) : ""))
        .filter(Boolean)
        .join("; ");
      log.warn("nostr", `publish rejected by all relays: ${reasons}`);
      return false;
    }
    return true;
  }

  /**
   * Broadcast NIP-65 (kind 10002) relay list, NIP-17 (kind 10050) DM relay list,
   * and Kind 10044 encryption key announcement.
   * Clients like Jumble gate starting DMs on both kind 10050 AND kind 10044.
   */
  async announceRelays(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    // Kind 10002: NIP-65 Relay List Metadata
    const nip65 = finalizeEvent(
      {
        kind: 10002,
        created_at: now,
        tags: this.relayUrls.map((r) => ["r", r]),
        content: "",
      },
      this.sk,
    );

    // Kind 10050: NIP-17 DM Relay List
    const nip17 = finalizeEvent(
      {
        kind: 10050,
        created_at: now,
        tags: this.relayUrls.map((r) => ["relay", r]),
        content: "",
      },
      this.sk,
    );

    // Kind 10044: Encryption Key Announcement
    const kind10044 = finalizeEvent(
      {
        kind: 10044,
        created_at: now,
        tags: [["n", this.pk]],
        content: "",
      },
      this.sk,
    );

    const targets = [...this.relays.values()].filter((r) => r.connected);
    if (targets.length === 0) return;

    await Promise.allSettled([
      ...targets.map((r) => r.publish(nip65)),
      ...targets.map((r) => r.publish(nip17)),
      ...targets.map((r) => r.publish(kind10044)),
    ]);
    log("nostr", `announced metadata (kinds 10002, 10050, 10044) to ${targets.length} relay(s)`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
