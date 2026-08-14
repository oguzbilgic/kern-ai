import { test } from "node:test";
import assert from "node:assert/strict";
import { wellFormed } from "../src/util.js";

test("wellFormed: passes through well-formed strings unchanged", () => {
  assert.equal(wellFormed("hello"), "hello");
  assert.equal(wellFormed("emoji 💰 intact"), "emoji 💰 intact");
  assert.equal(wellFormed(""), "");
});

test("wellFormed: replaces lone surrogates from a split surrogate pair", () => {
  // Slicing mid-emoji leaves a lone high surrogate (real-world failure:
  // tool-line truncation at char 300 split 💰 → provider rejected the
  // request body as invalid JSON).
  const truncated = "cost: 💰".slice(0, 7); // ends with lone high surrogate
  assert.equal(truncated.isWellFormed(), false);
  const fixed = wellFormed(truncated);
  assert.equal(fixed.isWellFormed(), true);
  assert.ok(fixed.endsWith("\uFFFD"));
});

test("wellFormed: fixes lone surrogates mid-string", () => {
  const bad = "a\uD83Db... [truncated]\nmore text";
  assert.equal(bad.isWellFormed(), false);
  const fixed = wellFormed(bad);
  assert.equal(fixed.isWellFormed(), true);
  assert.equal(fixed, "a\uFFFDb... [truncated]\nmore text");
});
