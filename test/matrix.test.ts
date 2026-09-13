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
    return {};
  };

  const sent = await iface.sendToUser("@alice:matrix", "Hello Alice");
  assert.equal(sent, true);
  // Checked m.direct, then sent to !existing-dm:matrix
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].path.includes("/account_data/m.direct"));
  assert.equal(calls[1].method, "PUT");
  assert.ok(calls[1].path.includes("/send/m.room.message/"));
  assert.ok(calls[1].path.includes("existing-dm"));
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

