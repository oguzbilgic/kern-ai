import test from "node:test";
import assert from "node:assert/strict";
import { mdToMatrixHtml, mimeToType, MatrixInterface } from "../src/interfaces/matrix.ts";

test("mimeToType: categorizes mime types correctly", () => {
  assert.equal(mimeToType("image/png"), "image");
  assert.equal(mimeToType("image/jpeg"), "image");
  assert.equal(mimeToType("audio/ogg"), "audio");
  assert.equal(mimeToType("audio/mp3"), "audio");
  assert.equal(mimeToType("video/mp4"), "video");
  assert.equal(mimeToType("application/pdf"), "document");
  assert.equal(mimeToType("text/plain"), "document");
  assert.equal(mimeToType("application/octet-stream"), "document");
});

test("mdToMatrixHtml: plain text returns undefined", () => {
  assert.equal(mdToMatrixHtml("Hello world!"), undefined);
});

test("mdToMatrixHtml: formatting bold, italic, inline code", () => {
  const result = mdToMatrixHtml("Hello **bold** and *italic* with `code`");
  assert.ok(result);
  assert.ok(result.includes("<strong>bold</strong>"));
  assert.ok(result.includes("<em>italic</em>"));
  assert.ok(result.includes("<code>code</code>"));
});

test("mdToMatrixHtml: code blocks with language and HTML escaping", () => {
  const input = "Check this:\n```ts\nconst a = 1 < 2 && 3 > 0;\n```";
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes('<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; 3 &gt; 0;'));
  assert.ok(result.includes("</code></pre>"));
});

test("mdToMatrixHtml: lists and blockquotes", () => {
  const input = "> A famous quote\n\n- item 1\n- item 2";
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes("<blockquote>"));
  assert.ok(result.includes("A famous quote"));
  assert.ok(result.includes("</blockquote>"));
  assert.ok(result.includes("<ul>"));
  assert.ok(result.includes("<li>item 1</li>"));
  assert.ok(result.includes("<li>item 2</li>"));
  assert.ok(result.includes("</ul>"));
});

test("mdToMatrixHtml: ordered and nested lists", () => {
  const input = `
1. **history**
   * Fetch recent messages
   * Supports limit
2. **react**
   * Add emoji
`;
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes("<ol>"));
  assert.ok(result.includes("<strong>history</strong>"));
  assert.ok(result.includes("<ul>"));
  assert.ok(result.includes("<li>Fetch recent messages</li>"));
  assert.ok(result.includes("</ol>"));
});

test("mdToMatrixHtml: unwraps <p> inside <li> in loose lists", () => {
  const input = `1. **Item One**:
   - detail A
   - detail B

2. **Item Two**:
   - detail C`;
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  // Ensure <li> does not contain immediate <p> block which forces a line break after list numbers
  assert.ok(!result.includes("<li><p>"));
  assert.ok(result.includes("<li><strong>Item One</strong>:"));
});

test("mdToMatrixHtml: links and strikethrough", () => {
  const input = "Visit [Matrix](https://matrix.org) or ~~old link~~";
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes('<a href="https://matrix.org">Matrix</a>'));
  assert.ok(result.includes("<del>old link</del>"));
});

test("mdToMatrixHtml: renders tables with alignments and cell formatting", () => {
  const input = `
| Feature | Matrix | Status |
| :--- | :---: | ---: |
| **Markdown** | Full HTML | *Active* |
| Tables | Native | \`OK\` |
`;
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes("<table>"));
  assert.ok(result.includes('<th align="left">Feature</th>'));
  assert.ok(result.includes('<th align="center">Matrix</th>'));
  assert.ok(result.includes('<th align="right">Status</th>'));
  assert.ok(result.includes('<td align="left"><strong>Markdown</strong></td>'));
  assert.ok(result.includes('<td align="center">Full HTML</td>'));
  assert.ok(result.includes('<td align="right"><em>Active</em></td>'));
  assert.ok(result.includes('<td align="left">Tables</td>'));
  assert.ok(result.includes('<td align="center">Native</td>'));
  assert.ok(result.includes('<td align="right"><code>OK</code></td>'));
  assert.ok(result.includes("</table>"));
});

test("mdToMatrixHtml: converts ANSI escape sequences in code blocks to colored HTML", () => {
  const input = "```text\n\x1b[32m\x1b[1mHealth: 100/100\x1b[0m\n\x1b[90mTarget Rows\x1b[0m\n```";
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes("<pre><code>"));
  assert.ok(result.includes('<font color="#a6e3a1">'));
  assert.ok(result.includes("<b>Health: 100/100</b>"));
  assert.ok(result.includes('<font color="#6c7086">Target Rows</font>'));
  assert.ok(result.includes("</code></pre>"));
});

test("MatrixInterface: emits intermediate text on tool-call event (per-step)", async () => {
  const { MatrixInterface } = await import("../src/interfaces/matrix.js");
  const matrix = new MatrixInterface(
    "http://localhost:8008",
    "@agent:matrix",
    "fake-token",
    {
      isPaired: () => true,
      hasAnyPairedUsers: () => true,
      autoPairFirst: async () => {},
      getOrCreateCode: async () => "code",
    } as any,
  );

  const sentMessages: string[] = [];
  (matrix as any).sendMessage = async (_roomId: string, text: string) => {
    sentMessages.push(text);
  };
  (matrix as any).setTyping = async () => {};

  await (matrix as any).handleIncoming(
    "!room:matrix",
    "@oguz:matrix",
    "do research",
    {},
    async (_env: any, onEvent: any) => {
      onEvent({ type: "text-delta", text: "Searching knowledge base..." });
      await onEvent({ type: "tool-call", toolName: "read" });
      onEvent({ type: "text-delta", text: "Found the info!" });
      return "Found the info!";
    },
  );

  assert.strictEqual(sentMessages.length, 2);
  assert.strictEqual(sentMessages[0], "Searching knowledge base...");
  assert.strictEqual(sentMessages[1], "Found the info!");
});

test("MatrixInterface: downloads media with MSC3916 authenticated endpoint fallback", async () => {
  const matrix = new MatrixInterface(
    "http://matrix.test",
    "@agent:matrix",
    "fake-token",
  );

  const attemptedPaths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
    const urlStr = String(url);
    attemptedPaths.push(urlStr);
    if (urlStr.includes("/_matrix/client/v1/media/download/")) {
      return new Response(Buffer.from("fake-audio-content"), {
        status: 200,
        headers: { "Content-Type": "audio/ogg" },
      });
    }
    return new Response("Not Found", { status: 404 });
  }) as any;

  try {
    const att = await (matrix as any).downloadMediaAttachment({
      url: "mxc://matrix.test/media123",
      body: "audio.ogg",
      info: { mimetype: "audio/ogg", size: 18 },
    });

    assert.ok(att);
    assert.strictEqual(att.type, "audio");
    assert.strictEqual(att.mimeType, "audio/ogg");
    assert.strictEqual(att.data.toString(), "fake-audio-content");
    assert.ok(attemptedPaths.some((p) => p.includes("/_matrix/client/v1/media/download/matrix.test/media123")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


// ---------------------------------------------------------------------------
// sendToUser: room IDs send as-is, user IDs resolve to a direct room
// ---------------------------------------------------------------------------

type Route = (method: string, path: string, body: any) => { status?: number; json?: any } | undefined;

function mockMatrix(route: Route) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: any) => {
    const path = String(url).replace("http://matrix.test", "");
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const res = route(method, path, body);
    if (!res) return new Response(JSON.stringify({ errcode: "M_NOT_FOUND" }), { status: 404 });
    return new Response(JSON.stringify(res.json ?? {}), { status: res.status ?? 200 });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

const BOT = "@agent:matrix";
const ALICE = "@alice:matrix";
const DM_PATH = `/_matrix/client/v3/user/${encodeURIComponent(BOT)}/account_data/m.direct`;
const isSend = (c: { path: string }) => /\/send\/m\.room\.message\//.test(c.path);

function newMatrix() {
  return new MatrixInterface("http://matrix.test", BOT, "fake-token");
}

test("sendToUser: room ID sends directly with no lookups", async () => {
  const m = mockMatrix((method, path) => {
    if (method === "PUT" && isSend({ path })) return { json: { event_id: "$e" } };
    return undefined;
  });
  try {
    assert.equal(await newMatrix().sendToUser("!ops:matrix", "hi"), true);
    assert.equal(m.calls.length, 1);
    assert.ok(m.calls[0].path.startsWith(`/_matrix/client/v3/rooms/${encodeURIComponent("!ops:matrix")}/send/`));
  } finally {
    m.restore();
  }
});

test("sendToUser: rejects targets that are neither room nor user IDs", async () => {
  const m = mockMatrix(() => ({ json: {} }));
  try {
    assert.equal(await newMatrix().sendToUser("alice", "hi"), false);
    assert.equal(m.calls.length, 0);
  } finally {
    m.restore();
  }
});

test("sendToUser: user ID uses the DM recorded in m.direct", async () => {
  const m = mockMatrix((method, path) => {
    if (path === "/_matrix/client/v3/joined_rooms") return { json: { joined_rooms: ["!dm:matrix", "!ops:matrix"] } };
    if (method === "GET" && path === DM_PATH) return { json: { [ALICE]: ["!stale:matrix", "!dm:matrix"] } };
    if (method === "PUT" && isSend({ path })) return { json: { event_id: "$e" } };
    return undefined;
  });
  try {
    assert.equal(await newMatrix().sendToUser(ALICE, "hi"), true);
    const sends = m.calls.filter(isSend);
    assert.equal(sends.length, 1);
    assert.ok(sends[0].path.includes(encodeURIComponent("!dm:matrix")));
    assert.ok(!m.calls.some((c) => c.path.endsWith("/joined_members")), "no scan when m.direct hits");
    assert.ok(!m.calls.some((c) => c.path.endsWith("/createRoom")));
  } finally {
    m.restore();
  }
});

test("sendToUser: falls back to scanning joined rooms for a two-member DM and records it", async () => {
  const members: Record<string, string[]> = {
    "!ops:matrix": [BOT, ALICE, "@bob:matrix"],
    "!dm:matrix": [BOT, ALICE],
  };
  const m = mockMatrix((method, path) => {
    if (path === "/_matrix/client/v3/joined_rooms") return { json: { joined_rooms: Object.keys(members) } };
    if (method === "GET" && path === DM_PATH) return undefined; // 404: never set
    const mm = path.match(/\/rooms\/([^/]+)\/joined_members$/);
    if (mm) {
      const joined = Object.fromEntries(members[decodeURIComponent(mm[1])].map((u) => [u, {}]));
      return { json: { joined } };
    }
    if (method === "PUT" && path === DM_PATH) return { json: {} };
    if (method === "PUT" && isSend({ path })) return { json: { event_id: "$e" } };
    return undefined;
  });
  try {
    assert.equal(await newMatrix().sendToUser(ALICE, "hi"), true);
    const sends = m.calls.filter(isSend);
    assert.equal(sends.length, 1);
    assert.ok(sends[0].path.includes(encodeURIComponent("!dm:matrix")));
    const put = m.calls.find((c) => c.method === "PUT" && c.path === DM_PATH);
    assert.deepEqual(put?.body, { [ALICE]: ["!dm:matrix"] });
    assert.ok(!m.calls.some((c) => c.path.endsWith("/createRoom")));
  } finally {
    m.restore();
  }
});

test("sendToUser: creates a direct room when none exists and caches it", async () => {
  const m = mockMatrix((method, path) => {
    if (path === "/_matrix/client/v3/joined_rooms") return { json: { joined_rooms: ["!ops:matrix"] } };
    if (method === "GET" && path === DM_PATH) return undefined;
    if (path.endsWith("/joined_members")) return { json: { joined: { [BOT]: {}, [ALICE]: {}, "@bob:matrix": {} } } };
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") return { json: { room_id: "!new:matrix" } };
    if (method === "PUT" && path === DM_PATH) return { json: {} };
    if (method === "PUT" && isSend({ path })) return { json: { event_id: "$e" } };
    return undefined;
  });
  try {
    const matrix = newMatrix();
    assert.equal(await matrix.sendToUser(ALICE, "hi"), true);
    const create = m.calls.find((c) => c.path.endsWith("/createRoom"));
    assert.deepEqual(create?.body, { is_direct: true, invite: [ALICE], preset: "trusted_private_chat" });
    assert.ok(m.calls.filter(isSend)[0].path.includes(encodeURIComponent("!new:matrix")));
    const put = m.calls.find((c) => c.method === "PUT" && c.path === DM_PATH);
    assert.deepEqual(put?.body, { [ALICE]: ["!new:matrix"] });

    // Second send: cache hit, only the send request goes out.
    const before = m.calls.length;
    assert.equal(await matrix.sendToUser(ALICE, "again"), true);
    const after = m.calls.slice(before);
    assert.equal(after.length, 1);
    assert.ok(isSend(after[0]) && after[0].path.includes(encodeURIComponent("!new:matrix")));
  } finally {
    m.restore();
  }
});

test("sendToUser: concurrent sends to an unknown user create exactly one room", async () => {
  let created = 0;
  const m = mockMatrix((method, path) => {
    if (path === "/_matrix/client/v3/joined_rooms") return { json: { joined_rooms: [] } };
    if (method === "GET" && path === DM_PATH) return undefined;
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      created++;
      return { json: { room_id: `!new${created}:matrix` } };
    }
    if (method === "PUT" && path === DM_PATH) return { json: {} };
    if (method === "PUT" && isSend({ path })) return { json: { event_id: "$e" } };
    return undefined;
  });
  try {
    const matrix = newMatrix();
    const results = await Promise.all([matrix.sendToUser(ALICE, "a"), matrix.sendToUser(ALICE, "b")]);
    assert.deepEqual(results, [true, true]);
    assert.equal(created, 1);
    assert.ok(m.calls.filter(isSend).every((c) => c.path.includes(encodeURIComponent("!new1:matrix"))));
  } finally {
    m.restore();
  }
});

test("sendToUser: a stale cached room is dropped and re-resolved once", async () => {
  let joined = ["!old:matrix"];
  const m = mockMatrix((method, path) => {
    if (path === "/_matrix/client/v3/joined_rooms") return { json: { joined_rooms: joined } };
    if (method === "GET" && path === DM_PATH) return { json: { [ALICE]: ["!old:matrix"] } };
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") return { json: { room_id: "!fresh:matrix" } };
    if (method === "PUT" && path === DM_PATH) return { json: {} };
    if (method === "PUT" && isSend({ path })) {
      if (path.includes(encodeURIComponent("!old:matrix"))) return { status: 403, json: { errcode: "M_FORBIDDEN" } };
      return { json: { event_id: "$e" } };
    }
    return undefined;
  });
  try {
    const matrix = newMatrix();
    (matrix as any).directRooms.set(ALICE, "!old:matrix");
    joined = []; // bot has since left the old room
    assert.equal(await matrix.sendToUser(ALICE, "hi"), true);
    const sends = m.calls.filter(isSend);
    assert.equal(sends.length, 2);
    assert.ok(sends[1].path.includes(encodeURIComponent("!fresh:matrix")));
    assert.equal((matrix as any).directRooms.get(ALICE), "!fresh:matrix");
  } finally {
    m.restore();
  }
});

test("MatrixInterface: pairing records the sender's mxid, not the room", async () => {
  const recorded: Array<{ fn: string; args: string[] }> = [];
  const matrix = new MatrixInterface("http://matrix.test", BOT, "fake-token", {
    isPaired: () => false,
    hasAnyPairedUsers: () => true,
    autoPairFirst: async (...args: string[]) => { recorded.push({ fn: "auto", args }); },
    getOrCreateCode: async (...args: string[]) => { recorded.push({ fn: "code", args }); return "KERN-ABCD"; },
  } as any);
  const sent: Array<[string, string]> = [];
  (matrix as any).sendMessage = async (roomId: string, text: string) => { sent.push([roomId, text]); };

  await (matrix as any).handleIncoming("!ops:matrix", ALICE, "hello", {}, async () => "");
  assert.deepEqual(recorded, [{ fn: "code", args: [ALICE, "matrix", `matrix:${ALICE}`] }]);
  assert.equal(sent[0][0], "!ops:matrix", "pairing code still goes to the room the user spoke in");
});
