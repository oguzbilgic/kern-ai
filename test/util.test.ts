import { test } from "node:test";
import assert from "node:assert/strict";
import { wellFormed } from "../src/util.js";

// Local lone-surrogate detector — String.prototype.isWellFormed() is Node 20+
// and engines allows >=18, so don't rely on it in tests.
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

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
  assert.equal(hasLoneSurrogate(truncated), true);
  const fixed = wellFormed(truncated);
  assert.equal(hasLoneSurrogate(fixed), false);
  assert.ok(fixed.endsWith("\uFFFD"));
});

test("wellFormed: fixes lone surrogates mid-string", () => {
  const bad = "a\uD83Db... [truncated]\nmore text";
  assert.equal(hasLoneSurrogate(bad), true);
  const fixed = wellFormed(bad);
  assert.equal(hasLoneSurrogate(fixed), false);
  assert.equal(fixed, "a\uFFFDb... [truncated]\nmore text");
});
