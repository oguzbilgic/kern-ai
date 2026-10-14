import test from "node:test";
import assert from "node:assert/strict";
import { formatStatus, StatusData } from "../src/tools/kern.js";

test("formatStatus formats status output in a yaml code block", () => {
  const dummyData: StatusData = {
    version: "0.39.0",
    name: "vega",
    agent: "vega",
    model: "claude-fable-5.1",
    provider: "anthropic",
    toolScope: "full",
    uptime: "2h 15m 30s",
    session: "50 messages (~20k tokens)",
    context: null,
    contextBreakdown: {
      systemPromptTokens: 5000,
      messageTokens: 12000,
      summaryTokens: 8000,
      messageCount: 30,
      trimmedCount: 5,
      summaryLevelCounts: { 1: 10, 2: 2 },
    },
    summary: null,
    apiUsage: "$0.50 (5 turns)",
    cacheUsage: "90% (50k hits, 5k misses)",
    promptTokens: 25000,
    completionTokens: 1200,
    queue: "idle",
    telegram: "connected",
    slack: null,
    matrix: "connected (@vega:matrix)",
    nostr: null,
    discord: "connected as Vega#0001",
    irc: null,
    segments: "100 L0, 10 L1",
    plugins: {
      skills: "3 active",
    },
  };

  const formatted = formatStatus(dummyData);
  assert.match(formatted, /^```yaml\n/);
  assert.match(formatted, /\n```$/);
  assert.match(formatted, /kern: 0\.39\.0/);
  assert.match(formatted, /agent: vega/);
  assert.match(formatted, /model: anthropic\/claude-fable-5\.1/);
  assert.match(formatted, /channels:\n  matrix: connected \(@vega:matrix\)\n  telegram: connected\n  discord: connected as Vega#0001/);
  assert.match(formatted, /context:\n  total: ~25k tokens\n  system: ~5k tokens\n  messages: ~12k tokens \(30 msgs, 5 trimmed\)\n  summary: ~8k tokens \(10×L1, 2×L2\)/);
  assert.match(formatted, /plugins:\n  skills: 3 active/);
  assert.match(formatted, /usage:\n  api: \$0\.50 \(5 turns\)\n  cache: 90% \(50k hits, 5k misses\)\n  queue: idle/);
});
