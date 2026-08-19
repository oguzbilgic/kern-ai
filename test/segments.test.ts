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

test("embedTexts input is capped: per-message caps alone don't bound a window", () => {
  // 5 worst-case messages joined — the actual unit embedTexts sends.
  const window = Array.from({ length: 5 }, () =>
    "assistant: " + messageText("assistant", partsMsg("y".repeat(50000)))
  ).join("\n");
  assert.ok(window.length > EMBED_MAX_CHARS, "window exceeds the cap on its own");
  assert.equal(capForEmbedding(window).length, EMBED_MAX_CHARS);
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

// --- embedTexts / embedOne ---------------------------------------------------

// A fake EmbeddingModelV2 that rejects any value over `limit` code units,
// the way a provider rejects input over its token limit.
const fakeModel = (limit: number, seen: string[] = []) => ({
  specificationVersion: "v2" as const,
  provider: "test",
  modelId: "fake",
  maxEmbeddingsPerCall: 100,
  supportsParallelCalls: false,
  async doEmbed({ values }: { values: string[] }) {
    for (const v of values) {
      seen.push(v);
      if (v.length > limit) throw new Error("maximum context length is 8192 tokens");
    }
    return { embeddings: values.map(() => [1, 0, 0]), usage: { tokens: 1 }, warnings: [] };
  },
});

const embedTexts = (embeddingModel: unknown, texts: string[]): Promise<number[][]> =>
  (SegmentIndex.prototype as any).embedTexts.call(
    Object.assign(Object.create(SegmentIndex.prototype), { embeddingModel }),
    texts
  );

test("embedTexts: one rejected window doesn't fail the whole batch", async () => {
  // Before: the batch 400s, indexSession throws, segment_state never advances
  // and the same messages are retried forever.
  const out = await embedTexts(fakeModel(1000), ["short", "x".repeat(5000), "short too"]);
  assert.equal(out.length, 3, "every window still gets an embedding");
});

test("embedTexts: shrinks a rejected window until the provider accepts it", async () => {
  const seen: string[] = [];
  const out = await embedTexts(fakeModel(1000, seen), ["x".repeat(5000)]);
  assert.equal(out.length, 1);
  // Halved from the 5000-char value down to something the model took.
  const accepted = seen[seen.length - 1];
  assert.ok(accepted.length <= 1000, `accepted ${accepted.length} chars`);
  assert.ok(seen.length > 1, "retried at smaller sizes");
});

test("embedTexts: rethrows when shrinking can't be the problem", async () => {
  // A model that rejects everything: not a length issue, so failing the run
  // (and retrying later) beats advancing state past unindexed messages.
  await assert.rejects(() => embedTexts(fakeModel(0), ["anything"]), /maximum context length/);
});
