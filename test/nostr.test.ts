import { test, after } from "node:test";
import assert from "node:assert";
import { WebSocketServer, type WebSocket } from "ws";
import { generateSecretKey, getPublicKey, finalizeEvent, type Event } from "nostr-tools/pure";
import * as nip04 from "nostr-tools/nip04";
import * as nip19 from "nostr-tools/nip19";
import { matchFilters, type Filter } from "nostr-tools/filter";
import {
  NostrInterface,
  parseRelayList,
  decodeSecretKey,
  toHexPubkey,
  DEFAULT_RELAYS,
} from "../src/interfaces/nostr.js";

// ---------------------------------------------------------------------------
// Minimal in-process relay: REQ/EVENT/CLOSE, in-memory store, fan-out.
// Enough of NIP-01 for nostr-tools' Relay client to be happy.
// ---------------------------------------------------------------------------
class FakeRelay {
  events: Event[] = [];
  private wss: WebSocketServer;
  private subs = new Map<WebSocket, Map<string, Filter[]>>();
  url = "";

  static async create(): Promise<FakeRelay> {
    const r = new FakeRelay();
    await new Promise<void>((resolve) => r.wss.once("listening", resolve));
    const addr = r.wss.address();
    if (typeof addr === "object" && addr) r.url = `ws://127.0.0.1:${addr.port}`;
    return r;
  }

  private constructor() {
    this.wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    this.wss.on("connection", (ws) => {
      this.subs.set(ws, new Map());
      ws.on("message", (raw) => this.onMessage(ws, raw.toString()));
      ws.on("close", () => this.subs.delete(ws));
    });
  }

  private onMessage(ws: WebSocket, raw: string) {
    let msg: any[];
    try { msg = JSON.parse(raw); } catch { return; }
    const [verb] = msg;
    if (verb === "REQ") {
      const [, id, ...filters] = msg;
      this.subs.get(ws)!.set(id, filters);
      for (const ev of this.events) {
        if (matchFilters(filters, ev)) ws.send(JSON.stringify(["EVENT", id, ev]));
      }
      ws.send(JSON.stringify(["EOSE", id]));
    } else if (verb === "EVENT") {
      const ev = msg[1] as Event;
      this.events.push(ev);
      ws.send(JSON.stringify(["OK", ev.id, true, ""]));
      for (const [client, subs] of this.subs) {
        for (const [id, filters] of subs) {
          if (matchFilters(filters, ev)) client.send(JSON.stringify(["EVENT", id, ev]));
        }
      }
    } else if (verb === "CLOSE") {
      this.subs.get(ws)?.delete(msg[1]);
    }
  }

  /** Inject an event as if another client published it. */
  inject(ev: Event) {
    this.onMessage({ send: () => {} } as any, JSON.stringify(["EVENT", ev]));
  }

  close() {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

function makeDM(fromSk: Uint8Array, toPk: string, text: string): Event {
  return finalizeEvent(
    {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000) + 1, // strictly after `since`
      tags: [["p", toPk]],
      content: nip04.encrypt(fromSk, toPk, text),
    },
    fromSk,
  );
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const relays: FakeRelay[] = [];
const ifaces: NostrInterface[] = [];
after(async () => {
  for (const i of ifaces) await i.stop();
  for (const r of relays) r.close();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test("parseRelayList trims, drops blanks, keeps order", () => {
  assert.deepEqual(parseRelayList(" wss://a , ,wss://b,"), ["wss://a", "wss://b"]);
  assert.deepEqual(parseRelayList(""), []);
  assert.deepEqual(parseRelayList(undefined), []);
});

test("decodeSecretKey accepts nsec and hex, rejects garbage", () => {
  const sk = generateSecretKey();
  const nsec = nip19.nsecEncode(sk);
  const hex = Buffer.from(sk).toString("hex");
  assert.deepEqual(decodeSecretKey(nsec), sk);
  assert.deepEqual(decodeSecretKey(hex), sk);
  assert.deepEqual(decodeSecretKey(`  ${nsec}\n`), sk);
  assert.throws(() => decodeSecretKey("nope"));
  assert.throws(() => decodeSecretKey(nip19.npubEncode(getPublicKey(sk))));
});

test("toHexPubkey accepts npub and hex", () => {
  const pk = getPublicKey(generateSecretKey());
  assert.equal(toHexPubkey(nip19.npubEncode(pk)), pk);
  assert.equal(toHexPubkey(pk.toUpperCase()), pk);
  assert.throws(() => toHexPubkey("npub1garbage"));
});

test("empty relay list falls back to public defaults", () => {
  const iface = new NostrInterface(nip19.nsecEncode(generateSecretKey()), []);
  assert.ok(DEFAULT_RELAYS.length >= 2);
  assert.ok(iface.publicKey.startsWith("npub1"));
});

// ---------------------------------------------------------------------------
// End-to-end over a fake relay
// ---------------------------------------------------------------------------
test("receives encrypted DM, decrypts, replies encrypted to sender", async () => {
  const relay = await FakeRelay.create();
  relays.push(relay);

  const agentSk = generateSecretKey();
  const userSk = generateSecretKey();
  const userPk = getPublicKey(userSk);
  const agentPk = getPublicKey(agentSk);

  const received: any[] = [];
  const iface = new NostrInterface(nip19.nsecEncode(agentSk), [relay.url]);
  ifaces.push(iface);
  await iface.start({
    onMessage: async (msg) => {
      received.push(msg);
      return `pong: ${msg.text}`;
    },
  });
  await waitFor(() => iface.status === "connected");

  relay.inject(makeDM(userSk, agentPk, "ping"));

  await waitFor(() => received.length === 1);
  assert.equal(received[0].text, "ping");
  assert.equal(received[0].interface, "nostr");
  assert.equal(received[0].userId, nip19.npubEncode(userPk));
  assert.equal(received[0].chatId, nip19.npubEncode(userPk));
  assert.equal(received[0].channel, `nostr:${nip19.npubEncode(userPk)}`);

  // Agent's reply lands on the relay, tagged to the user, decryptable by the user.
  await waitFor(() => relay.events.some((e) => e.pubkey === agentPk));
  const reply = relay.events.find((e) => e.pubkey === agentPk)!;
  assert.equal(reply.kind, 4);
  assert.deepEqual(reply.tags, [["p", userPk]]);
  assert.equal(nip04.decrypt(userSk, agentPk, reply.content), "pong: ping");

  // Our own reply echoed back by the relay must not re-enter the handler.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
});

test("NO_REPLY suppresses the outbound DM", async () => {
  const relay = await FakeRelay.create();
  relays.push(relay);
  const agentSk = generateSecretKey();
  const userSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);

  let calls = 0;
  const iface = new NostrInterface(nip19.nsecEncode(agentSk), [relay.url]);
  ifaces.push(iface);
  await iface.start({ onMessage: async () => { calls++; return "NO_REPLY"; } });
  await waitFor(() => iface.status === "connected");

  relay.inject(makeDM(userSk, agentPk, "quiet please"));
  await waitFor(() => calls === 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(relay.events.filter((e) => e.pubkey === agentPk).length, 0);
});

test("same event from two relays is handled once; reply fans out to both", async () => {
  const a = await FakeRelay.create();
  const b = await FakeRelay.create();
  relays.push(a, b);
  const agentSk = generateSecretKey();
  const userSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);

  let calls = 0;
  const iface = new NostrInterface(nip19.nsecEncode(agentSk), [a.url, b.url]);
  ifaces.push(iface);
  await iface.start({ onMessage: async () => { calls++; return "once"; } });
  await waitFor(() => iface.statusDetail === "2/2 relays");

  const dm = makeDM(userSk, agentPk, "dup");
  a.inject(dm);
  b.inject(dm);

  await waitFor(() => a.events.some((e) => e.pubkey === agentPk) && b.events.some((e) => e.pubkey === agentPk));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls, 1);
});

test("ignores non-DM kinds and undecryptable payloads", async () => {
  const relay = await FakeRelay.create();
  relays.push(relay);
  const agentSk = generateSecretKey();
  const userSk = generateSecretKey();
  const otherSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);

  let calls = 0;
  const iface = new NostrInterface(nip19.nsecEncode(agentSk), [relay.url]);
  ifaces.push(iface);
  await iface.start({ onMessage: async () => { calls++; return "x"; } });
  await waitFor(() => iface.status === "connected");

  // Kind 1 tagged to us — not a DM.
  relay.inject(finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000) + 1, tags: [["p", agentPk]], content: "hi" }, userSk));
  // Kind 4 tagged to us but encrypted for someone else.
  relay.inject(finalizeEvent({
    kind: 4, created_at: Math.floor(Date.now() / 1000) + 1, tags: [["p", agentPk]],
    content: nip04.encrypt(userSk, getPublicKey(otherSk), "not for you"),
  }, userSk));

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls, 0);
});

test("sendToUser accepts npub, publishes encrypted DM", async () => {
  const relay = await FakeRelay.create();
  relays.push(relay);
  const agentSk = generateSecretKey();
  const userSk = generateSecretKey();
  const userPk = getPublicKey(userSk);
  const agentPk = getPublicKey(agentSk);

  const iface = new NostrInterface(nip19.nsecEncode(agentSk), [relay.url]);
  ifaces.push(iface);
  await iface.start({ onMessage: async () => "" });
  await waitFor(() => iface.status === "connected");

  assert.equal(await iface.sendToUser(nip19.npubEncode(userPk), "proactive"), true);
  const ev = relay.events.find((e) => e.pubkey === agentPk)!;
  assert.equal(nip04.decrypt(userSk, agentPk, ev.content), "proactive");
  assert.equal(await iface.sendToUser("not-a-key", "x"), false);
});

test("unreachable relay is retried, not fatal", async () => {
  const dead = await FakeRelay.create();
  const url = dead.url;
  dead.close(); // port now refuses connections
  const iface = new NostrInterface(nip19.nsecEncode(generateSecretKey()), [url]);
  ifaces.push(iface);
  await iface.start({ onMessage: async () => "" });
  await waitFor(() => iface.status === "error");
  assert.match(iface.statusDetail || "", /no relays reachable/);
  await new Promise((r) => setTimeout(r, 300)); // survive at least one retry tick
  assert.equal(iface.status, "error");
});
