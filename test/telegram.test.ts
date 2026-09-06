import { test } from "node:test";
import assert from "node:assert";
import { mdToHtml, stripMarkdown } from "../src/interfaces/telegram.js";

test("mdToHtml: converts headers to bold", () => {
  assert.equal(mdToHtml("### Subheader"), "<b>Subheader</b>");
  assert.equal(mdToHtml("# Top Header"), "<b>Top Header</b>");
});

test("mdToHtml: converts markdown tables to <pre> blocks", () => {
  const table = `| Col 1 | Col 2 |
| :--- | :--- |
| Val 1 | Val 2 |`;
  const res = mdToHtml(table);
  assert.match(res, /<pre>\| Col 1 \| Col 2 \|/);
  assert.match(res, /\| Val 1 \| Val 2 \|<\/pre>/);
});

test("mdToHtml: removes horizontal rules", () => {
  assert.equal(mdToHtml("Above\n---\nBelow"), "Above\n\nBelow");
  assert.equal(mdToHtml("Above\n***\nBelow"), "Above\n\nBelow");
});

test("mdToHtml: escapes HTML inside code blocks and inline code", () => {
  const code = "```bash\necho '<test> & \"foo\"'\n```";
  assert.equal(
    mdToHtml(code),
    '<pre><code class="language-bash">echo \'&lt;test&gt; &amp; "foo"\'\n</code></pre>'
  );
  assert.equal(mdToHtml("`a < b & c > d`"), "<code>a &lt; b &amp; c &gt; d</code>");
});

test("mdToHtml: handles standard bold, italic, lists, and blockquotes", () => {
  assert.equal(mdToHtml("**bold**"), "<b>bold</b>");
  assert.equal(mdToHtml("*italic*"), "<i>italic</i>");
  assert.equal(mdToHtml("- item 1\n- item 2"), "• item 1\n• item 2");
  assert.equal(mdToHtml("> quote 1\n> quote 2"), "<blockquote>quote 1\nquote 2</blockquote>");
});

test("stripMarkdown: strips headers, tables, code, and horizontal rules", () => {
  const text = `### Heading
---
| A | B |
- item`;
  const stripped = stripMarkdown(text);
  assert.match(stripped, /Heading/);
  assert.match(stripped, /• item/);
  assert.doesNotMatch(stripped, /###/);
  assert.doesNotMatch(stripped, /---/);
});
