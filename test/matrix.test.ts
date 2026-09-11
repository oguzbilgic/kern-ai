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
  assert.ok(result.includes('<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; 3 &gt; 0;</code></pre>'));
});

test("mdToMatrixHtml: lists and blockquotes", () => {
  const input = "> A famous quote\n\n- item 1\n- item 2";
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes("<blockquote>A famous quote</blockquote>"));
  assert.ok(result.includes("<ul>\n<li>item 1</li>\n<li>item 2</li>\n</ul>"));
});

test("mdToMatrixHtml: cleans redundant line breaks around block elements", () => {
  const input = "### Header\n\nParagraph 1\n\n- item 1\n- item 2\n\nParagraph 2";
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(!result.includes("</h3><br />"));
  assert.ok(!result.includes("<br /><ul>"));
  assert.ok(!result.includes("</ul><br />"));
  assert.ok(!result.includes("<br /><br /><br />"));
});

test("mdToMatrixHtml: links and strikethrough", () => {
  const input = "Visit [Matrix](https://matrix.org) or ~~old link~~";
  const result = mdToMatrixHtml(input);
  assert.ok(result);
  assert.ok(result.includes('<a href="https://matrix.org">Matrix</a>'));
  assert.ok(result.includes("<del>old link</del>"));
});
