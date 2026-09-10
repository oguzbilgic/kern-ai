import { test, after } from "node:test";
import assert from "node:assert";
import { createServer, type Server, type Socket } from "net";
import {
  IrcInterface,
  parseIrcUrl,
  parseIrcUrls,
  parseIrcLine,
  formatForIrc,
  redactIrcUrl,
  isValidIrcTarget,
} from "../src/interfaces/irc.js";
import { MentionGate } from "../src/mentions.js";

// ---------------------------------------------------------------------------
// Minimal in-process IRC server: CAP negotiation, registration, JOIN, PRIVMSG.
// Enough of RFC1459 + IRCv3 message-tags for the client to be happy.
// ---------------------------------------------------------------------------
class FakeIrcServer {
  private server: Server;
  private clients = new Set<Socket>();
  /** Every line the client sent us. */
  received: string[] = [];
  port = 0;

  static async create(): Promise<FakeIrcServer> {
    const s = new FakeIrcServer();
    await new Promise<void>((resolve) => s.server.listen(0, "127.0.0.1", resolve));
    const addr = s.server.address();
    if (typeof addr === "object" && addr) s.port = addr.port;
    return s;
  }

  private constructor() {
    this.server = createServer((sock) => {
      this.clients.add(sock);
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\r\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line) this.onLine(sock, line);
        }
      });
      sock.on("error", () => {});
      sock.on("close", () => this.clients.delete(sock));
    });
    this.server.on("error", () => {});
  }

  private onLine(sock: Socket, line: string) {
    this.received.push(line);
    const [cmd, ...rest] = line.split(" ");
    switch (cmd.toUpperCase()) {
      case "CAP": {
        const sub = (rest[0] || "").toUpperCase();
        if (sub === "LS") {
          sock.write(":fake CAP * LS :account-tag message-tags server-time sasl\r\n");
        } else if (sub === "REQ") {
          const caps = line.slice(line.indexOf(":") + 1);
          sock.write(`:fake CAP * ACK :${caps}\r\n`);
        }
        return;
      }
      case "NICK":
        this.nick = rest[0] || this.nick;
        return;
      case "USER":
        sock.write(`:fake 001 ${this.nick} :Welcome\r\n`);
        return;
      default:
        return;
    }
  }

  nick = "";

  /** Push a raw line to every connected client. */
  push(line: string) {
    for (const c of this.clients) c.write(`${line}\r\n`);
  }

  /** Lines the client sent that are PRIVMSGs, as [target, text] pairs. */
  privmsgs(): Array<[string, string]> {
    return this.received
      .filter((l) => l.startsWith("PRIVMSG "))
      .map((l) => {
        const rest = l.slice("PRIVMSG ".length);
        const sp = rest.indexOf(" :");
        return [rest.slice(0, sp), rest.slice(sp + 2)] as [string, string];
      });
  }

  async close() {
    for (const c of this.clients) c.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Wait until `fn()` is truthy, or throw after `timeout` ms. */
async function waitFor<T>(fn: () => T, timeout = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

const servers: FakeIrcServer[] = [];
const ifaces: IrcInterface[] = [];

after(async () => {
  for (const i of ifaces) await i.stop().catch(() => {});
  for (const s of servers) await s.close().catch(() => {});
});

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

test("parseIrcUrl: plain, defaults, hash channels", () => {
  const c = parseIrcUrl("irc://vega@10.0.0.1:6667/#homelab");
  assert.equal(c.host, "10.0.0.1");
  assert.equal(c.port, 6667);
  assert.equal(c.tls, false);
  assert.equal(c.nick, "vega");
  assert.equal(c.password, undefined);
  assert.deepEqual(c.channels, ["#homelab"]);
});

test("parseIrcUrl: tls, password, multiple channels, default port", () => {
  const c = parseIrcUrl("ircs://vega:s3cret@irc.example.com/#homelab,#agents");
  assert.equal(c.tls, true);
  assert.equal(c.port, 6697, "ircs:// defaults to 6697");
  assert.equal(c.password, "s3cret");
  assert.deepEqual(c.channels, ["#homelab", "#agents"]);
});

test("parseIrcUrl: bare port default and path-style channels get a # prefix", () => {
  const c = parseIrcUrl("irc://bot@example.com/homelab,ops");
  assert.equal(c.port, 6667);
  assert.deepEqual(c.channels, ["#homelab", "#ops"]);
});

test("parseIrcUrl: no nick falls back to kern, no channels is allowed", () => {
  const c = parseIrcUrl("irc://example.com");
  assert.equal(c.nick, "kern");
  assert.deepEqual(c.channels, []);
});

test("parseIrcUrl: rejects non-irc schemes", () => {
  assert.throws(() => parseIrcUrl("http://example.com"), /unsupported scheme/);
});

test("parseIrcUrls: whitespace-separated, invalid entries skipped", () => {
  const list = parseIrcUrls("irc://a@h1/#x  ircs://b@h2/#y  not-a-url");
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.host), ["h1", "h2"]);
  assert.deepEqual(parseIrcUrls(undefined), []);
  assert.deepEqual(parseIrcUrls(""), []);
});

// ---------------------------------------------------------------------------
// Protocol line parsing
// ---------------------------------------------------------------------------

test("parseIrcLine: prefix, command, params, trailing", () => {
  const l = parseIrcLine(":nick!user@host PRIVMSG #chan :hello world")!;
  assert.equal(l.command, "PRIVMSG");
  assert.equal(l.nick, "nick");
  assert.deepEqual(l.params, ["#chan", "hello world"]);
  assert.deepEqual(l.tags, {});
});

test("parseIrcLine: IRCv3 tags including account and escapes", () => {
  const l = parseIrcLine(
    "@account=oguz;+draft/x=a\\sb;empty :n!u@h PRIVMSG #c :hi",
  )!;
  assert.equal(l.tags["account"], "oguz");
  assert.equal(l.tags["+draft/x"], "a b", "\\s unescapes to a space");
  assert.equal(l.tags["empty"], "");
});

test("parseIrcLine: no prefix, and trailing with colons intact", () => {
  const l = parseIrcLine("PING :12345")!;
  assert.equal(l.command, "PING");
  assert.deepEqual(l.params, ["12345"]);

  const l2 = parseIrcLine(":s PRIVMSG #c :a: b: c")!;
  assert.equal(l2.params[1], "a: b: c");
});

test("parseIrcLine: rejects blank and malformed lines", () => {
  assert.equal(parseIrcLine(""), null);
  assert.equal(parseIrcLine("@tagsonly"), null);
  assert.equal(parseIrcLine(":prefixonly"), null);
});

// ---------------------------------------------------------------------------
// Outbound formatting
// ---------------------------------------------------------------------------

test("formatForIrc: markdown maps to IRC control codes", () => {
  const out = formatForIrc("**bold** and `code` and *em*");
  assert.equal(out.length, 1);
  assert.ok(out[0].includes("\x02bold\x02"), "bold → \\x02");
  assert.ok(out[0].includes("code"), "inline code has backticks stripped");
  assert.ok(!out[0].includes("\x11"), "no 0x11 monospace control codes");
  assert.ok(out[0].includes("\x1dem\x1d"), "italic → \\x1d");
});

test("formatForIrc: headers become bold, rules and fences are dropped", () => {
  const out = formatForIrc("# Title\n\n---\n\n```sh\nls -la\n```\n");
  assert.deepEqual(out, ["\x02Title\x02", "ls -la"]);
});

test("formatForIrc: table separator rows dropped, data rows kept", () => {
  const out = formatForIrc("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.deepEqual(out, ["| a | b |", "| 1 | 2 |"]);
});

test("formatForIrc: bullets, quotes and links are rewritten", () => {
  assert.deepEqual(formatForIrc("- one\n- two"), ["• one", "• two"]);
  assert.deepEqual(formatForIrc("> quoted"), ["quoted"]);
  assert.deepEqual(formatForIrc("see [docs](http://x/y)"), ["see docs <http://x/y>"]);
});

test("formatForIrc: no blank lines and no stray control characters", () => {
  const out = formatForIrc("a\n\n\nb\n\x00c");
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("formatForIrc: long lines wrap under the byte limit on word boundaries", () => {
  const out = formatForIrc(("word ".repeat(300)).trim());
  assert.ok(out.length > 1, "should wrap");
  for (const line of out) {
    assert.ok(Buffer.byteLength(line) <= 400, `line is ${Buffer.byteLength(line)} bytes`);
    assert.ok(!line.startsWith(" ") && !line.endsWith(" "));
  }
  assert.equal(out.join(" ").split(/\s+/).length, 300, "no words lost");
});

test("formatForIrc: an unbreakable run is hard-split without splitting a codepoint", () => {
  const out = formatForIrc("é".repeat(500)); // 2 bytes each
  assert.ok(out.length > 1);
  for (const line of out) {
    assert.ok(Buffer.byteLength(line) <= 400);
    // A broken surrogate/continuation byte would round-trip as U+FFFD.
    assert.ok(!line.includes("\uFFFD"), "no mangled characters");
  }
  assert.equal(out.join("").length, 500, "no characters lost");
});

test("formatForIrc: reply line count is capped with a truncation notice", () => {
  const out = formatForIrc(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"), 10);
  assert.equal(out.length, 11);
  assert.match(out[10], /70 more lines truncated/);
});

// ---------------------------------------------------------------------------
// End-to-end against the fake server
// ---------------------------------------------------------------------------

async function connect(opts: {
  channels?: string;
  pairing?: any;
  gate?: MentionGate;
  onMessage?: (msg: any) => Promise<string>;
}) {
  const server = await FakeIrcServer.create();
  servers.push(server);

  const received: any[] = [];
  const iface = new IrcInterface(
    parseIrcUrls(`irc://vega@127.0.0.1:${server.port}/${opts.channels ?? "#homelab"}`),
    opts.pairing,
    opts.gate,
  );
  ifaces.push(iface);

  await iface.start({
    onMessage: async (msg) => {
      received.push(msg);
      return opts.onMessage ? opts.onMessage(msg) : "pong";
    },
  });

  await waitFor(() => server.received.some((l) => l.startsWith("JOIN ")));
  return { server, iface, received };
}

test("registers with CAP negotiation and joins configured channels", async () => {
  const { server, iface } = await connect({ channels: "#homelab,#ops" });

  assert.ok(server.received.includes("CAP LS 302"), "requests caps first");
  assert.ok(
    server.received.some((l) => l.startsWith("CAP REQ :") && l.includes("account-tag")),
    "asks for account-tag",
  );
  assert.ok(server.received.includes("CAP END"), "ends negotiation");
  assert.ok(server.received.includes("NICK vega"));
  assert.ok(server.received.some((l) => l.startsWith("USER vega ")));

  await waitFor(() => server.received.includes("JOIN #ops"));
  assert.ok(server.received.includes("JOIN #homelab"));
  assert.equal(iface.status, "connected");
});

test("replies to PING to stay connected", async () => {
  const { server } = await connect({});
  server.push("PING :abc123");
  await waitFor(() => server.received.includes("PONG :abc123"));
});

test("DM: authenticated sender is keyed on account, not nick", async () => {
  const { server, received } = await connect({});
  server.push("@account=oguz :spoofer!u@h PRIVMSG vega :hello");

  await waitFor(() => received.length > 0);
  assert.equal(received[0].userId, "irc:127.0.0.1/oguz", "account wins over nick");
  assert.equal(received[0].interface, "irc");
  assert.equal(received[0].text, "hello");
  assert.equal(received[0].chatId, "127.0.0.1/spoofer", "replies go back to the nick");
  assert.equal(received[0].channel, "irc:127.0.0.1/spoofer");

  await waitFor(() => server.privmsgs().length > 0);
  assert.deepEqual(server.privmsgs()[0], ["spoofer", "pong"]);
});

test("DM: unauthenticated sender is tilde-marked", async () => {
  const { received } = await connect({});
  const { server } = { server: servers[servers.length - 1] };
  server.push(":oguz!u@h PRIVMSG vega :hello");

  await waitFor(() => received.length > 0);
  assert.equal(received[0].userId, "irc:127.0.0.1/~oguz", "no account tag → ~nick");
});

test("DM: account-tag \"*\" means not logged in, not an account named *", async () => {
  // Some servers send the placeholder "*" rather than omitting the tag. A bare
  // truthiness check would key this sender as irc:<host>/* and auto-pair them.
  const { received } = await connect({});
  const { server } = { server: servers[servers.length - 1] };
  server.push("@account=* :oguz!u@h PRIVMSG vega :hello");

  await waitFor(() => received.length > 0);
  assert.equal(received[0].userId, "irc:127.0.0.1/~oguz", "placeholder account → ~nick");
});

test("channel: with mentions-only off, receives all messages and strips leading nick address", async () => {
  const { server, received } = await connect({ gate: new MentionGate(false) });

  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :just chatting");
  await waitFor(() => received.length === 1);
  assert.equal(received[0].text, "just chatting", "bare chatter is delivered to the agent");

  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :vega: status?");
  await waitFor(() => received.length === 2);
  assert.equal(received[1].text, "status?", "leading address is stripped");
  assert.equal(received[1].chatId, "127.0.0.1/#homelab", "replies go to the channel");

  await waitFor(() => server.privmsgs().length > 0);
  assert.deepEqual(server.privmsgs()[0], ["#homelab", "pong"]);
});

test("channel: mention anywhere in the line counts", async () => {
  const { server, received } = await connect({ gate: new MentionGate(false) });
  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :hey vega can you look?");
  await waitFor(() => received.length > 0);
  assert.match(received[0].text, /hey .*can you look\?/);
});

test("channel: unaddressed messages are observed, not answered", async () => {
  const { server, received } = await connect({ gate: new MentionGate(true) });

  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :anyone deploying today?");
  server.push("@account=ada :ada!u@h PRIVMSG #homelab :I pushed the migration");
  // Give the connection a beat to prove it stays quiet.
  await sleep(150);
  assert.equal(received.length, 0, "no turn for messages we were not addressed in");
  assert.equal(server.privmsgs().length, 0, "and nothing sent to the channel");

  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :vega: did it land?");
  await waitFor(() => received.length === 1);
  const text = received[0].text as string;
  assert.match(text, /you were not addressed in/, "observed messages are folded in as context");
  assert.match(text, /oguz: anyone deploying today\?/);
  assert.match(text, /ada: I pushed the migration/);
  assert.match(text, /did it land\?$/, "the addressed message comes last");

  await waitFor(() => server.privmsgs().length > 0);
  assert.deepEqual(server.privmsgs()[0], ["#homelab", "pong"]);
});

test("channel: observed buffer is cleared once folded in", async () => {
  const { server, received } = await connect({ gate: new MentionGate(true) });

  server.push("@account=ada :ada!u@h PRIVMSG #homelab :standup in 5");
  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :vega: noted?");
  await waitFor(() => received.length === 1);
  assert.match(received[0].text, /standup in 5/);

  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :vega: anything else?");
  await waitFor(() => received.length === 2);
  assert.equal(received[1].text, "anything else?", "no stale context on the next turn");
});

test("DM: never gated by mentions-only", async () => {
  const { server, received } = await connect({ gate: new MentionGate(true) });
  server.push("@account=oguz :oguz!u@h PRIVMSG vega :no mention here");
  await waitFor(() => received.length === 1);
  assert.equal(received[0].text, "no mention here");
});

test("NO_REPLY suppresses the outbound message", async () => {
  const { server, received } = await connect({ onMessage: async () => "NO_REPLY" });
  server.push("@account=oguz :oguz!u@h PRIVMSG vega :hi");
  await waitFor(() => received.length > 0);
  await sleep(300);
  assert.equal(server.privmsgs().length, 0);
});

test("own echo and non-ACTION CTCP are ignored", async () => {
  const { server, received } = await connect({});
  server.push(":vega!u@h PRIVMSG #homelab :vega: talking to myself");
  server.push("@account=oguz :oguz!u@h PRIVMSG vega :\x01VERSION\x01");
  await sleep(250);
  assert.equal(received.length, 0);

  server.push("@account=oguz :oguz!u@h PRIVMSG vega :\x01ACTION waves at vega\x01");
  await waitFor(() => received.length > 0);
  assert.equal(received[0].text, "* oguz waves at vega");
});

test("pairing: unauthenticated senders never auto-pair, they get a code", async () => {
  const codes: string[] = [];
  const pairing = {
    isPaired: () => false,
    hasAnyPairedUsers: () => false, // would normally auto-pair the first user
    autoPairFirst: async () => {
      throw new Error("must not auto-pair an unauthenticated nick");
    },
    getOrCreateCode: async (userId: string) => {
      codes.push(userId);
      return "KERN-TEST";
    },
  };
  const { server, received } = await connect({ pairing });

  server.push(":oguz!u@h PRIVMSG vega :hello");
  await waitFor(() => server.privmsgs().length > 0);

  assert.equal(received.length, 0, "turn never runs for an unpaired user");
  assert.deepEqual(codes, ["irc:127.0.0.1/~oguz"]);
  const [target, text] = server.privmsgs()[0];
  assert.equal(target, "oguz");
  assert.match(text, /KERN-TEST/);
  assert.match(text, /not logged in/, "explains why the nick can't be trusted");

  // Repeat sends must not spam more codes.
  server.push(":oguz!u@h PRIVMSG vega :hello again");
  await sleep(300);
  assert.equal(server.privmsgs().length, 1, "one code per user+target per process");
});

test("pairing: first authenticated sender is auto-paired", async () => {
  const paired: string[] = [];
  const pairing = {
    isPaired: () => false,
    hasAnyPairedUsers: () => paired.length > 0,
    autoPairFirst: async (userId: string, _iface: string, chatId: string) => {
      paired.push(`${userId}|${chatId}`);
    },
    getOrCreateCode: async () => "KERN-NOPE",
  };
  const { received } = await connect({ pairing });
  const server = servers[servers.length - 1];

  server.push("@account=oguz :oguz!u@h PRIVMSG vega :hello");
  await waitFor(() => received.length > 0);
  assert.deepEqual(paired, ["irc:127.0.0.1/oguz|127.0.0.1/oguz"]);
});

test("pairing gates DMs only — channels stay open", async () => {
  const pairing = {
    isPaired: () => false,
    hasAnyPairedUsers: () => true,
    autoPairFirst: async () => {},
    getOrCreateCode: async () => "KERN-TEST",
  };
  const { server, received } = await connect({ pairing });

  server.push("@account=stranger :stranger!u@h PRIVMSG #homelab :vega: hi");
  await waitFor(() => received.length > 0);
  assert.equal(received[0].userId, "irc:127.0.0.1/stranger");
  assert.equal(server.privmsgs().filter(([, t]) => t.includes("KERN-TEST")).length, 0);
});

test("sendToUser addresses host/target and rejects unknown hosts", async () => {
  const { server, iface } = await connect({});

  assert.equal(await iface.sendToUser("127.0.0.1/#homelab", "proactive"), true);
  await waitFor(() => server.privmsgs().length > 0);
  assert.deepEqual(server.privmsgs()[0], ["#homelab", "proactive"]);

  assert.equal(await iface.sendToUser("other.host/nick", "x"), false, "unknown host");
  assert.equal(await iface.sendToUser("no-slash", "x"), false, "malformed chatId");
  assert.equal(await iface.sendToUser("127.0.0.1/", "x"), false, "empty target");
});

test("multi-line replies become multiple PRIVMSGs to the same target", async () => {
  const { server, received } = await connect({
    onMessage: async () => "first line\nsecond line\nthird line",
  });
  server.push("@account=oguz :oguz!u@h PRIVMSG vega :go");
  await waitFor(() => received.length > 0);
  await waitFor(() => server.privmsgs().length === 3);
  assert.deepEqual(
    server.privmsgs(),
    [["oguz", "first line"], ["oguz", "second line"], ["oguz", "third line"]],
  );
});

test("nick collision retries with a suffixed nick", async () => {
  const server = await FakeIrcServer.create();
  servers.push(server);

  // Swap in a handler that rejects the first NICK, then welcomes the retry.
  const orig = (server as any).onLine.bind(server);
  let rejected = false;
  (server as any).onLine = (sock: Socket, line: string) => {
    if (line.startsWith("NICK ") && !rejected) {
      rejected = true;
      server.received.push(line);
      sock.write(":fake 433 * vega :Nickname is already in use\r\n");
      return;
    }
    orig(sock, line);
  };

  const iface = new IrcInterface(
    parseIrcUrls(`irc://vega@127.0.0.1:${server.port}/#homelab`),
  );
  ifaces.push(iface);
  await iface.start({ onMessage: async () => "ok" });

  await waitFor(() => server.received.includes("NICK vega_"));
  await waitFor(() => iface.status === "connected");
});

test("status reflects failure when the server is unreachable", async () => {
  const iface = new IrcInterface(parseIrcUrls("irc://vega@127.0.0.1:1/#x"));
  ifaces.push(iface);
  await iface.start({ onMessage: async () => "ok" });
  await waitFor(() => iface.status === "error");
  assert.match(iface.statusDetail || "", /127\.0\.0\.1/);
});

// ---------------------------------------------------------------------------
// Hardening (PR review follow-ups)
// ---------------------------------------------------------------------------

test("parseIrcUrl: channels in both path and fragment stay separate", () => {
  // "#" opens a URL fragment, so a URL carrying channels on both sides used to
  // fuse the last path channel to the first fragment one ("b#c").
  const c = parseIrcUrl("irc://n@h/a,b#c,d");
  assert.deepEqual(c.channels, ["#a", "#b", "#c", "#d"]);
});

test("redactIrcUrl: hides server password, keeps the rest legible", () => {
  assert.equal(redactIrcUrl("ircs://nick:s3cret@h:6697/#x"), "ircs://nick:***@h:6697/#x");
  // Nothing to redact — left untouched.
  assert.equal(redactIrcUrl("ircs://nick@h/#x"), "ircs://nick@h/#x");
  assert.equal(redactIrcUrl("not-a-url"), "not-a-url");
});

test("parseIrcUrls: password never reaches the log on a bad URL", () => {
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // log.warn goes to stderr; capture it rather than trusting the formatter.
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    lines.push(String(chunk));
    return orig(chunk as any, ...(rest as [any]));
  };
  try {
    parseIrcUrls("gopher://nick:hunter2@h/#x");
  } finally {
    (process.stderr as any).write = orig;
  }
  const out = lines.join("");
  assert.ok(!out.includes("hunter2"), "password leaked into log output");
});

test("isValidIrcTarget: rejects line-injection and accepts real targets", () => {
  assert.ok(isValidIrcTarget("oguz"));
  assert.ok(isValidIrcTarget("#homelab"));
  // A space or CRLF would let a crafted target append commands to the line.
  assert.ok(!isValidIrcTarget("nick :hi\r\nQUIT"));
  assert.ok(!isValidIrcTarget("nick PRIVMSG #chan"));
  assert.ok(!isValidIrcTarget("a\r\nJOIN #evil"));
  assert.ok(!isValidIrcTarget(":trailing"));
  assert.ok(!isValidIrcTarget(""));
  assert.ok(!isValidIrcTarget("a".repeat(201)));
});

test("turn failures are surfaced in channels, not swallowed", async () => {
  const { server, received } = await connect({
    onMessage: async () => {
      throw new Error("API credits exhausted");
    },
  });
  server.push("@account=oguz :oguz!u@h PRIVMSG #homelab :vega are you there");
  await waitFor(() => received.length > 0);
  await waitFor(() => server.privmsgs().length > 0);

  const [target, text] = server.privmsgs()[0];
  assert.equal(target, "#homelab", "goes back to the channel");
  assert.ok(text.startsWith("oguz:"), "addressed to the sender");
  assert.ok(text.includes("API credits exhausted"), "carries the reason");
});

test("turn failures in DMs carry the reason too", async () => {
  const { server, received } = await connect({
    onMessage: async () => {
      throw new Error("DNS resolution failed");
    },
  });
  server.push("@account=oguz :oguz!u@h PRIVMSG vega :hi");
  await waitFor(() => received.length > 0);
  await waitFor(() => server.privmsgs().length > 0);

  const [target, text] = server.privmsgs()[0];
  assert.equal(target, "oguz", "goes back to the sender");
  assert.ok(text.startsWith("Error processing message"), "still prefixed as an error");
  assert.ok(text.includes("DNS resolution failed"), "carries the reason");
});
