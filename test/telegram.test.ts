import { test } from "node:test";
import assert from "node:assert";
import { mdToHtml, stripMarkdown } from "../src/interfaces/telegram.js";

test("mdToHtml: converts bold, italic, strikethrough, lists, blockquotes", () => {
  assert.equal(mdToHtml("**bold text**"), "<b>bold text</b>");
  assert.equal(mdToHtml("*italic text*"), "<i>italic text</i>");
  assert.equal(mdToHtml("~~strikethrough~~"), "<s>strikethrough</s>");
  assert.equal(mdToHtml("- item 1\n- item 2"), "• item 1\n• item 2");
  assert.equal(mdToHtml("> quote"), "<blockquote>quote</blockquote>");
});

test("mdToHtml: escapes HTML inside code blocks and inline code", () => {
  const code = "```bash\necho '<test> & \"foo\"'\n```";
  assert.equal(
    mdToHtml(code),
    '<pre><code class="language-bash">echo \'&lt;test&gt; &amp; "foo"\'\n</code></pre>'
  );
  assert.equal(mdToHtml("`a < b & c > d`"), "<code>a &lt; b &amp; c &gt; d</code>");
});

test("stripMarkdown: strips basic formatting", () => {
  assert.equal(stripMarkdown("**bold** and *italic*"), "bold and italic");
  assert.equal(stripMarkdown("`code`"), "code");
  assert.equal(stripMarkdown("```\nblock\n```"), "block\n");
});
