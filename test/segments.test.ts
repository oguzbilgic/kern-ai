import { test } from "node:test";
import assert from "node:assert/strict";
import { capForEmbedding, EMBED_MAX_CHARS } from "../src/util.js";
import { SegmentIndex } from "../src/segments.js";

// --- capForEmbedding ---------------------------------------------------------

test("capForEmbedding: passes text at or under the cap through unchanged", () => {
  assert.equal(capForEmbedding("hello"), "hello");
  const exact = "x".repeat(EMBED_MAX_CHARS);
  assert.equal(capForEmbedding(exact), exact);
});

test("capForEmbedding: truncates oversized text to the cap", () => {
  assert.equal(capForEmbedding("x".repeat(50000)).length, EMBED_MAX_CHARS);
  assert.equal(capForEmbedding("abcdef", 3), "abc");
});

test("capForEmbedding: never splits a surrogate pair at the cut", () => {
  // "ab" + 💰 is 4 UTF-16 code units; cutting at 3 would leave a lone high
  // surrogate, which serializes to invalid JSON and gets rejected upstream.
  // (No isWellFormed() here — that's Node 20+ and engines allows >=18.)
  const cut = capForEmbedding("ab💰cd", 3);
  assert.equal(cut, "ab");
  assert.match(cut, /^ab$/);
  assert.equal(/[\uD800-\uDBFF]$/.test(cut), false);
});

// --- messageText -------------------------------------------------------------

// messageText is private and pure; reach it without constructing a real index
// (which would need a live embedding model).
const messageText = (role: string, content: string): string =>
  (SegmentIndex.prototype as any).messageText.call({}, { role, content });

const partsMsg = (text: string) =>
  JSON.stringify([{ type: "text", text }, { type: "tool-call", toolName: "bash" }]);

test("messageText: array content is capped", () => {
  const out = messageText("assistant", partsMsg("y".repeat(50000)));
  // Cap + the "..." marker; must not carry the full 50k through.
  assert.ok(out.length < 2100, `expected capped output, got ${out.length} chars`);
  assert.ok(out.endsWith("..."));
});

test("messageText: array content under the cap is untouched and keeps tool markers", () => {
  const out = messageText("assistant", partsMsg("short answer"));
  assert.equal(out, "short answer [tool: bash]");
});

test("messageText: capped array content never ends in a lone surrogate", () => {
  // Emoji-dense text guarantees the cut lands mid-pair somewhere.
  const out = messageText("user", partsMsg("💰".repeat(5000)));
  const body = out.slice(0, -3); // strip "..."
  assert.equal(/[\uD800-\uDBFF]$/.test(body), false);
});

test("messageText: existing tool and string caps unchanged", () => {
  const tool = messageText("tool", "z".repeat(1000));
  assert.equal(tool.length, 303);
  const str = messageText("assistant", "w".repeat(1000));
  assert.equal(str.length, 503);
});

test("embed input is bounded for any script, not just typical text", () => {
  // 5 worst-case messages joined — the actual unit embedTexts sends.
  const window = Array.from({ length: 5 }, () =>
    "assistant: " + messageText("assistant", partsMsg("y".repeat(50000)))
  ).join("\n");
  // Per-message caps alone don't bound the window (5 x 2000 > EMBED_MAX_CHARS),
  // so the ceiling in embedTexts is what makes the guarantee.
  const sent = capForEmbedding(window);
  // Worst-case tokenization is ~1 char/token (CJK); the hard limit is 8192.
  assert.ok(sent.length <= 8192, `${sent.length} chars could exceed 8192 tokens`);
  assert.equal(sent.length, EMBED_MAX_CHARS);
});

test("CJK text is bounded below the token limit too", () => {
  // 5 messages of dense CJK — ~1 char/token, the case a char-count cap
  // calibrated for English would miss.
  const window = Array.from({ length: 5 }, () =>
    "user: " + messageText("user", partsMsg("経済".repeat(10000)))
  ).join("\n");
  assert.ok(capForEmbedding(window).length <= 8192);
});

test("messageText: tool and parse-failure truncation is surrogate-safe", () => {
  // Both branches used raw .slice() before — a cut mid-emoji leaves a lone
  // high surrogate, the #313 failure mode.
  const tool = messageText("tool", "💰".repeat(500));
  assert.equal(/[\uD800-\uDBFF]$/.test(tool.slice(0, -3)), false);
  // "[" prefix takes the array branch, then JSON.parse throws -> 500 cap.
  const broken = messageText("assistant", "[" + "💰".repeat(500));
  assert.equal(/[\uD800-\uDBFF]$/.test(broken.slice(0, -3)), false);
});
