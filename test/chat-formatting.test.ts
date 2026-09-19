import test from "node:test";
import assert from "node:assert/strict";
import { mdToHtml, stripMarkdown } from "../src/interfaces/telegram.js";
import { mdToSlack } from "../src/interfaces/slack.js";

test("telegram mdToHtml preserves language class for code blocks", () => {
  const yamlBlock = "```yaml\nkern: 0.40.0\nstatus: ok\n```";
  assert.equal(
    mdToHtml(yamlBlock),
    '<pre><code class="language-yaml">kern: 0.40.0\nstatus: ok\n</code></pre>'
  );

  const plainBlock = "```\nsome code\n```";
  assert.equal(
    mdToHtml(plainBlock),
    "<pre><code>some code\n</code></pre>"
  );

  const textBlock = "```text\nhello world\n```";
  assert.equal(
    mdToHtml(textBlock),
    '<pre><code class="language-text">hello world\n</code></pre>'
  );
});

test("telegram stripMarkdown strips code block fences and language tags", () => {
  const yamlBlock = "```yaml\nkern: 0.40.0\n```";
  assert.equal(stripMarkdown(yamlBlock), "kern: 0.40.0\n");
});

test("slack mdToSlack strips language tags from code blocks", () => {
  const yamlBlock = "```yaml\nkern: 0.40.0\nstatus: ok\n```";
  assert.equal(mdToSlack(yamlBlock), "```\nkern: 0.40.0\nstatus: ok\n```");

  const plainBlock = "```\nsome code\n```";
  assert.equal(mdToSlack(plainBlock), "```\nsome code\n```");

  const inlineWithOtherStyles = "**status:**\n```json\n{\"ok\": true}\n```";
  assert.equal(
    mdToSlack(inlineWithOtherStyles),
    "*status:*\n```\n{\"ok\": true}\n```"
  );
});
