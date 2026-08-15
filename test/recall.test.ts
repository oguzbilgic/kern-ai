import { test } from "node:test";
import assert from "node:assert/strict";
import { capForEmbedding } from "../src/plugins/recall/recall.js";

test("capForEmbedding: passes short text through unchanged", () => {
  assert.equal(capForEmbedding("hello"), "hello");
  const text = "x".repeat(16000);
  assert.equal(capForEmbedding(text), text);
});

test("capForEmbedding: truncates oversized text to the cap", () => {
  const text = "x".repeat(50000);
  assert.equal(capForEmbedding(text).length, 16000);
});

test("capForEmbedding: respects a custom max", () => {
  assert.equal(capForEmbedding("abcdef", 3), "abc");
});

test("capForEmbedding: never splits a surrogate pair at the cut", () => {
  // Cut lands exactly mid-emoji: "ab" + 💰 = 4 code units, cut at 3 would
  // leave a lone high surrogate. (Don't use isWellFormed() here — it's
  // Node 20+ and engines allows >=18.)
  const text = "ab💰cd";
  const cut = capForEmbedding(text, 3);
  assert.equal(cut, "ab");
  assert.equal(/[\uD800-\uDBFF]$/.test(cut), false);
});
