import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { prepareContext, clearTrimBoundaries } from "../src/context.js";
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
function fakeSegmentIndex(l0Ends: number[]) {
  return {
    getL0Boundaries: () => l0Ends,
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
