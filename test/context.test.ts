import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { prepareContext, clearTrimBoundaries, addCacheBreakpoints } from "../src/context.js";
import type { KernConfig } from "../src/config.js";
import type { ModelMessage } from "ai";

// Minimal config for trim tests. summaryBudget 0.5 → raw budget = maxContextTokens / 2.
function makeConfig(maxContextTokens: number): KernConfig {
  return {
    maxContextTokens,
    summaryBudget: 0.5,
    maxToolResultChars: 100000,
  } as KernConfig;
}

// ~100 tokens per message (4 chars ≈ 1 token)
function makeMessages(count: number): ModelMessage[] {
  const msgs: ModelMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i} ${"x".repeat(400)}` });
  }
  return msgs;
}

// Fake SegmentIndex: only the two methods prepareContext/trim use.
// summarizedEnds defaults to l0Ends (all segments summarized); pass a shorter
// list to simulate segments that exist but haven't been summarized yet.
function fakeSegmentIndex(l0Ends: number[], summarizedEnds: number[] = l0Ends) {
  return {
    getL0Boundaries: (_sessionId: string, summarizedOnly = false) =>
      summarizedOnly ? summarizedEnds : l0Ends,
    composeHistory: () => null,
  } as any;
}

beforeEach(() => clearTrimBoundaries());

test("trim clamps to summary coverage — no coverage means no trim", () => {
  // 100 messages × ~100 tokens, raw budget 1000 tokens → would normally trim ~90.
  const messages = makeMessages(100);
  const result = prepareContext({
    messages,
    config: makeConfig(2000),
    sessionId: "s1",
    segmentIndex: fakeSegmentIndex([]),
  });
  // No L0 segments exist → nothing is summarized → nothing may be trimmed.
  assert.strictEqual(result.messages.length, 100);
});

test("trim clamps to summary coverage — boundary never passes last L0 end", () => {
  const messages = makeMessages(100);
  // Summaries cover messages 0..40 only.
  const result = prepareContext({
    messages,
    config: makeConfig(2000),
    sessionId: "s2",
    segmentIndex: fakeSegmentIndex([20, 40]),
  });
  // Boundary must be ≤ 40 → at least 60 messages stay raw, budget overshot.
  assert.ok(result.messages.length >= 60, `expected >= 60 raw messages, got ${result.messages.length}`);
});

test("trim proceeds normally when coverage is ahead of the cut point", () => {
  const messages = makeMessages(100);
  // Summaries cover everything.
  const result = prepareContext({
    messages,
    config: makeConfig(2000),
    sessionId: "s3",
    segmentIndex: fakeSegmentIndex([20, 40, 60, 80, 99]),
  });
  // Raw budget is 1000 tokens ≈ 10 messages → most messages should be trimmed.
  assert.ok(result.messages.length < 60, `expected < 60 raw messages, got ${result.messages.length}`);
  // Boundary is turn-safe: window starts on a user message.
  assert.strictEqual(result.messages[0].role, "user");
});

test("clamped boundary is turn-safe (walks back to a user message)", () => {
  const messages = makeMessages(100);
  // Coverage ends at 41 (an assistant message index) → clamp must walk back to 40 (user).
  const result = prepareContext({
    messages,
    config: makeConfig(2000),
    sessionId: "s4",
    segmentIndex: fakeSegmentIndex([41]),
  });
  assert.strictEqual(result.messages[0].role, "user");
});

test("segmented-but-unsummarized regions do not count as coverage", () => {
  const messages = makeMessages(100);
  // Segments exist up to msg 80, but the summarizer has only reached msg 40.
  // composeHistory() can only inject summarized segments, so the boundary
  // must clamp to 40 — not 80.
  const result = prepareContext({
    messages,
    config: makeConfig(2000),
    sessionId: "s5",
    segmentIndex: fakeSegmentIndex([20, 40, 60, 80], [20, 40]),
  });
  assert.ok(result.messages.length >= 60, `expected >= 60 raw messages, got ${result.messages.length}`);
});

// --- cache breakpoints -----------------------------------------------------

function cacheConfig(): KernConfig {
  return { provider: "openrouter", model: "anthropic/claude-opus-5" } as KernConfig;
}

// Counts cache_control blocks a provider would emit: one per message, except
// tool messages where the marker is copied onto every tool result.
function countBlocks(messages: ModelMessage[]): number {
  return messages.reduce((n, m) => {
    const opts = (m as any).providerOptions;
    if (!opts?.anthropic?.cacheControl && !opts?.openrouter?.cacheControl) return n;
    return n + (m.role === "tool" && Array.isArray(m.content) ? m.content.length : 1);
  }, 0);
}

function toolMsg(id: string, results: number): ModelMessage {
  return {
    role: "tool",
    content: Array.from({ length: results }, (_, i) => ({
      type: "tool-result" as const,
      toolCallId: `${id}-${i}`,
      toolName: "bash",
      output: { type: "text" as const, value: "ok" },
    })),
  };
}

test("cache breakpoints stay within Anthropic's 4-block budget", () => {
  // 30 messages; index 20 (the snapped stable breakpoint) is a tool message
  // with 3 parallel results — marking it would emit 3 blocks and, with the
  // system + turn breakpoints, exceed Anthropic's limit of 4.
  const messages = makeMessages(30);
  messages[20] = toolMsg("t20", 3);
  const marked = addCacheBreakpoints(messages, cacheConfig());

  // +1 for the system message breakpoint, which is added separately.
  assert.ok(countBlocks(marked) + 1 <= 4, `emitted ${countBlocks(marked) + 1} blocks`);
  assert.strictEqual(countBlocks([marked[20]]), 0, "multi-result tool message must not be marked");
});

test("stable breakpoint shifts off a multi-result tool message", () => {
  const messages = makeMessages(30);
  messages[20] = toolMsg("t20", 3);
  const marked = addCacheBreakpoints(messages, cacheConfig());
  const markedIdx = marked
    .map((m, i) => (countBlocks([m]) > 0 ? i : -1))
    .filter(i => i >= 0);
  // Turn breakpoint on the last user message (28), stable shifted 20 → 19.
  assert.deepStrictEqual(markedIdx, [19, 28]);
});

test("single-result tool messages are still valid breakpoints", () => {
  const messages = makeMessages(30);
  messages[20] = toolMsg("t20", 1);
  const marked = addCacheBreakpoints(messages, cacheConfig());
  assert.strictEqual(countBlocks(marked), 2);
  assert.ok(countBlocks([marked[20]]) === 1, "index 20 should keep the breakpoint");
});

test("no stable breakpoint when every candidate is multi-block", () => {
  const messages = makeMessages(30);
  for (let i = 0; i <= 20; i++) messages[i] = toolMsg(`t${i}`, 2);
  const marked = addCacheBreakpoints(messages, cacheConfig());
  // Only the turn breakpoint survives.
  assert.strictEqual(countBlocks(marked), 1);
});

test("no breakpoints for providers without prompt caching", () => {
  const messages = makeMessages(30);
  const marked = addCacheBreakpoints(messages, { provider: "openai", model: "gpt-5.6-sol" } as KernConfig);
  assert.strictEqual(countBlocks(marked), 0);
});
