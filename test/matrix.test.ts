import test from "node:test";
import assert from "node:assert/strict";
import { MatrixInterface, mdToMatrixHtml, mimeToType } from "../src/interfaces/matrix.ts";

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

test("sendToUser: sends directly to room ID", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  (iface as any).api = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    return {};
  };

  const sent = await iface.sendToUser("!room1:matrix", "Hello room");
  assert.equal(sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.ok(calls[0].path.includes("/send/m.room.message/"));
  assert.ok(calls[0].path.includes("room1"));
  assert.equal(calls[0].body.body, "Hello room");
});

test("sendToUser: resolves existing DM room from m.direct when target is a user ID", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  (iface as any).api = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (path.includes("/account_data/m.direct")) {
      return { "@alice:matrix": ["!existing-dm:matrix"] };
    }
    if (path.includes("/state/m.room.member/")) {
      return { membership: "join" };
    }
    return {};
  };

  const sent = await iface.sendToUser("@alice:matrix", "Hello Alice");
  assert.equal(sent, true);
  // Checked m.direct, verified membership in !existing-dm:matrix, then sent message
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].path.includes("/account_data/m.direct"));
  assert.equal(calls[1].method, "GET");
  assert.ok(calls[1].path.includes("/state/m.room.member/"));
  assert.equal(calls[2].method, "PUT");
  assert.ok(calls[2].path.includes("/send/m.room.message/"));
  assert.ok(calls[2].path.includes("existing-dm"));
});

test("sendToUser: creates DM room and updates m.direct when no existing room exists", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  (iface as any).api = async (method: string, path: string, body?: any) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return {};
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      return { room_id: "!new-dm:matrix" };
    }
    return {};
  };

  const sent = await iface.sendToUser("@bob:matrix", "Hello Bob");
  assert.equal(sent, true);
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/_matrix/client/v3/createRoom" && c.body.is_direct === true));
  assert.ok(calls.some((c) => c.method === "PUT" && c.path.includes("/account_data/m.direct")));
  assert.ok(calls.some((c) => c.method === "PUT" && c.path.includes("new-dm") && c.path.includes("/send/m.room.message/")));
});

test("sendToUser: deduplicates concurrent resolutions for the same user", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let createRoomCount = 0;
  (iface as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return {};
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      createRoomCount++;
      // Simulate small network delay
      await new Promise((r) => setTimeout(r, 10));
      return { room_id: "!concurrent-dm:matrix" };
    }
    return {};
  };

  const [res1, res2] = await Promise.all([
    iface.sendToUser("@charlie:matrix", "Message 1"),
    iface.sendToUser("@charlie:matrix", "Message 2"),
  ]);

  assert.equal(res1, true);
  assert.equal(res2, true);
  assert.equal(createRoomCount, 1);
});

test("sendToUser: serializes m.direct updates across different users without dropping mappings", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let storedDirectData: Record<string, string[]> = {};

  (iface as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      // Simulate network delay to expose race conditions if not serialized
      await new Promise((r) => setTimeout(r, 20));
      return { ...storedDirectData };
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      const targetUser = body.invite[0];
      return { room_id: targetUser === "@alice:matrix" ? "!room-alice:matrix" : "!room-bob:matrix" };
    }
    if (method === "PUT" && path.includes("/account_data/m.direct")) {
      await new Promise((r) => setTimeout(r, 10));
      storedDirectData = { ...body };
      return {};
    }
    return {};
  };

  const [resAlice, resBob] = await Promise.all([
    iface.sendToUser("@alice:matrix", "Hi Alice"),
    iface.sendToUser("@bob:matrix", "Hi Bob"),
  ]);

  assert.equal(resAlice, true);
  assert.equal(resBob, true);
  assert.deepEqual(storedDirectData["@alice:matrix"], ["!room-alice:matrix"]);
  assert.deepEqual(storedDirectData["@bob:matrix"], ["!room-bob:matrix"]);
});

test("sendToUser: tries next mapped room when candidate is stale and falls back to createRoom when all candidates are unusable", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let sentToRoom = "";
  (iface as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return { "@stale:matrix": ["!stale-dm-1:matrix", "!left-dm-2:matrix", "!valid-dm-3:matrix"] };
    }
    if (method === "GET" && path.includes("/state/m.room.member/")) {
      if (path.includes("!stale-dm-1")) {
        const err: any = new Error("matrix GET 403: Forbidden");
        err.status = 403;
        throw err;
      }
      if (path.includes("!left-dm-2")) {
        return { membership: "leave" }; // recipient left room
      }
      return { membership: "join" }; // member state active for !valid-dm-3:matrix
    }
    if (method === "PUT" && path.includes("/send/m.room.message/")) {
      sentToRoom = path;
      return {};
    }
    return {};
  };

  const sent = await iface.sendToUser("@stale:matrix", "Hello via valid room");
  assert.equal(sent, true);
  assert.ok(sentToRoom.includes("!valid-dm-3"));

  // Now test all-stale fallback: every mapped candidate is unusable -> creates new room
  const ifaceAllStale = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let createCalled = false;
  let sentToCreatedRoom = "";
  (ifaceAllStale as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return { "@allstale:matrix": ["!stale-1:matrix", "!stale-2:matrix"] };
    }
    if (method === "GET" && path.includes("/state/m.room.member/")) {
      if (path.includes("!stale-1")) {
        const err: any = new Error("matrix GET 404: Not Found");
        err.status = 404;
        throw err;
      }
      return { membership: "leave" };
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      createCalled = true;
      return { room_id: "!replacement-dm:matrix" };
    }
    if (method === "PUT" && path.includes("/send/m.room.message/")) {
      sentToCreatedRoom = path;
      return {};
    }
    return {};
  };

  const sentReplacement = await ifaceAllStale.sendToUser("@allstale:matrix", "Hello via replacement");
  assert.equal(sentReplacement, true);
  assert.equal(createCalled, true);
  assert.ok(sentToCreatedRoom.includes("!replacement-dm"));
});

test("sendToUser: invalidates cached DM room and re-resolves when send returns 403/404", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let sendAttempts = 0;
  let createdCount = 0;
  let mDirectRooms = ["!cached-dm:matrix"];

  (iface as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return { "@alice:matrix": mDirectRooms };
    }
    if (method === "GET" && path.includes("/state/m.room.member/")) {
      if (path.includes("!cached-dm")) {
        // Initially member is in room
        return { membership: "join" };
      }
      return { membership: "join" };
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      createdCount++;
      return { room_id: "!newly-created-dm:matrix" };
    }
    if (method === "PUT" && path.includes("/send/m.room.message/")) {
      sendAttempts++;
      if (path.includes("!cached-dm")) {
        // Simulate cached room becoming unusable (e.g. 403 Forbidden after ban/leave)
        const err: any = new Error("matrix PUT 403: Forbidden");
        err.status = 403;
        throw err;
      }
      return {};
    }
    return {};
  };

  // Prime cache by sending first message (will succeed if cached-dm accepted, but here first send fails and invalidates)
  // Let's set up the cache directly on iface
  (iface as any).dmRoomCache.set("@alice:matrix", "!cached-dm:matrix");

  // When sending to @alice:matrix, cached room is used, fails with 403, cache invalidated,
  // re-resolve checks m.direct (which still has !cached-dm), member check fails or let's simulate mDirectRooms updated or empty
  mDirectRooms = []; // now m.direct has no valid rooms so createRoom is called

  const sent = await iface.sendToUser("@alice:matrix", "Retry message");
  assert.equal(sent, true);
  assert.equal(sendAttempts, 2); // 1 on !cached-dm, 1 on !newly-created-dm
  assert.equal(createdCount, 1);
  assert.equal((iface as any).dmRoomCache.get("@alice:matrix"), "!newly-created-dm:matrix");
});

test("sendToUser: propagates non-403/404 errors during candidate room check rather than creating duplicate DM", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let createCalled = false;
  (iface as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return { "@user:matrix": ["!existing-dm:matrix"] };
    }
    if (method === "GET" && path.includes("/state/m.room.member/")) {
      const err: any = new Error("matrix GET 500: Internal Server Error");
      err.status = 500;
      throw err;
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      createCalled = true;
      return { room_id: "!new-dm:matrix" };
    }
    return {};
  };

  const sent = await iface.sendToUser("@user:matrix", "Hello");
  assert.equal(sent, false);
  assert.equal(createCalled, false);
});

test("sendToUser: revalidates cached DM room membership and evicts stale cache before sending", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let createCalled = false;
  let sentToRoom = "";
  (iface as any).dmRoomCache.set("@user:matrix", "!cached-room:matrix");

  (iface as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return {};
    }
    if (method === "GET" && path.includes("/state/m.room.member/")) {
      if (path.includes("!cached-room")) {
        return { membership: "leave" }; // recipient left previously cached room
      }
      return { membership: "join" };
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      createCalled = true;
      return { room_id: "!new-room:matrix" };
    }
    if (method === "PUT" && path.includes("/send/m.room.message/")) {
      sentToRoom = path;
      return {};
    }
    return {};
  };

  const sent = await iface.sendToUser("@user:matrix", "Hello after leave");
  assert.equal(sent, true);
  assert.equal(createCalled, true);
  assert.ok(sentToRoom.includes("!new-room"));
  assert.equal((iface as any).dmRoomCache.get("@user:matrix"), "!new-room:matrix");
});

test("sendToUser: retains created DM in memory cache if m.direct persistence fails", async () => {
  const iface = new MatrixInterface("http://mock-homeserver", "@vega:matrix", "fake-token");
  let createCount = 0;
  (iface as any).api = async (method: string, path: string, body?: any) => {
    if (method === "GET" && path.includes("/account_data/m.direct")) {
      return {};
    }
    if (method === "GET" && path.includes("/state/m.room.member/")) {
      return { membership: "join" };
    }
    if (method === "POST" && path === "/_matrix/client/v3/createRoom") {
      createCount++;
      return { room_id: "!created-room:matrix" };
    }
    if (method === "PUT" && path.includes("/account_data/m.direct")) {
      const err: any = new Error("matrix PUT 500: Internal Server Error");
      err.status = 500;
      throw err;
    }
    return {};
  };

  const firstSend = await iface.sendToUser("@bob:matrix", "First message");
  assert.equal(firstSend, true);
  assert.equal(createCount, 1);

  // Second send should use the in-memory cache and not call createRoom again
  const secondSend = await iface.sendToUser("@bob:matrix", "Second message");
  assert.equal(secondSend, true);
  assert.equal(createCount, 1);
});


