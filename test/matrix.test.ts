import test from "node:test";
import assert from "node:assert/strict";
import { mdToMatrixHtml, mimeToType } from "../src/interfaces/matrix.ts";

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
