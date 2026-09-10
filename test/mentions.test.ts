import { test } from "node:test";
import assert from "node:assert";
import {
  MentionGate,
  SentIds,
  escapeRegex,
  formatObserved,
  mentionsName,
  MAX_OBSERVED_CHARS,
  MAX_OBSERVED_CHANNELS,
} from "../src/mentions.js";
import { stripReplyFallback } from "../src/interfaces/matrix.js";
import { isAddressedTo, mentionEntities, stripBotMention } from "../src/interfaces/telegram.js";

// ---------------------------------------------------------------------------
// Name matching
// ---------------------------------------------------------------------------

test("mentionsName: matches a standalone name with or without @", () => {
  assert.ok(mentionsName("vega: status?", "vega"));
  assert.ok(mentionsName("hey @vega can you look", "vega"));
  assert.ok(mentionsName("ping vega", "vega"), "trailing position counts");
  assert.ok(mentionsName("VEGA wake up", "vega"), "case-insensitive");
});

test("mentionsName: does not match a name embedded in another word", () => {
  assert.ok(!mentionsName("vegan lunch spot", "vega"));
  assert.ok(!mentionsName("vega-bot is offline", "vega"), "nick chars are word chars on IRC");
  assert.ok(!mentionsName("supervega", "vega"));
});

test("mentionsName: empty name never matches", () => {
  assert.ok(!mentionsName("anything", ""));
  assert.ok(!mentionsName("anything", "   "));
});

test("escapeRegex: regex metacharacters in a nick are literal", () => {
  assert.ok(mentionsName("hi a.b", "a.b"));
  assert.ok(!mentionsName("hi axb", "a.b"), "the dot is not a wildcard");
  assert.equal(escapeRegex("a+b"), "a\\+b");
});

// ---------------------------------------------------------------------------
// Observation buffer
// ---------------------------------------------------------------------------

test("gate: disabled is a passthrough that buffers nothing", () => {
  const gate = new MentionGate(false);
  assert.equal(gate.active, false);
  gate.observe("#ops", "ada", "chatter");
  assert.equal(gate.pending("#ops"), 0, "nothing would ever drain it");
  assert.equal(gate.withContext("#ops", "hello"), "hello");
});

test("gate: observed messages fold into the next addressed turn, oldest first", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "anyone deploying?");
  gate.observe("#ops", "oguz", "I pushed the migration");
  assert.equal(gate.pending("#ops"), 2);

  const folded = gate.withContext("#ops", "did it land?");
  assert.match(folded, /^\[2 messages in this channel you were not addressed in/);
  assert.ok(
    folded.indexOf("ada: anyone deploying?") < folded.indexOf("oguz: I pushed the migration"),
    "chronological order",
  );
  assert.ok(folded.endsWith("did it land?"), "the addressed message comes last");
  assert.equal(gate.pending("#ops"), 0, "buffer is drained");
});

test("gate: buffers are per channel", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "ops chatter");
  gate.observe("#random", "ada", "random chatter");

  const ops = gate.withContext("#ops", "hi");
  assert.match(ops, /ops chatter/);
  assert.ok(!ops.includes("random chatter"), "channels don't leak into each other");
  assert.equal(gate.pending("#random"), 1);
});

test("gate: no context block when nothing was observed", () => {
  const gate = new MentionGate(true);
  assert.equal(gate.withContext("#ops", "hello"), "hello");
});

test("gate: blank messages are not buffered", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "");
  gate.observe("#ops", "ada", "   ");
  assert.equal(gate.pending("#ops"), 0);
});

test("gate: long messages are truncated", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "x".repeat(MAX_OBSERVED_CHARS + 500));
  const folded = gate.withContext("#ops", "hi");
  const line = folded.split("\n").find((l) => l.startsWith("ada: "))!;
  assert.ok(line.length <= MAX_OBSERVED_CHARS + "ada: ".length + 1, "capped");
  assert.ok(line.endsWith("…"), "truncation is visible");
});

test("gate: the buffer is bounded and reports what it dropped", () => {
  const gate = new MentionGate(true, 3);
  for (let i = 1; i <= 6; i++) gate.observe("#ops", "ada", `msg ${i}`);
  assert.equal(gate.pending("#ops"), 3, "only the most recent window is kept");

  const folded = gate.withContext("#ops", "catch me up");
  assert.match(folded, /3 earlier messages not shown/);
  assert.ok(!folded.includes("msg 1"), "oldest dropped");
  assert.match(folded, /msg 4[\s\S]*msg 5[\s\S]*msg 6/);
});

test("gate: a zero-size buffer keeps gating but stores nothing", () => {
  const gate = new MentionGate(true, 0);
  gate.observe("#ops", "ada", "chatter");
  assert.equal(gate.active, true);
  assert.equal(gate.withContext("#ops", "hi"), "hi");
});

test("formatObserved: singular wording and fencing", () => {
  const block = formatObserved([{ sender: "ada", text: "hi" }]);
  assert.match(block, /^\[1 message in this channel you were not addressed in/);
  assert.ok(block.endsWith("[end of observed messages]"));
});

// ---------------------------------------------------------------------------
// Sent-id tracking
// ---------------------------------------------------------------------------

test("SentIds: remembers ids and evicts the oldest past the cap", () => {
  const ids = new SentIds(2);
  ids.add("a");
  ids.add("b");
  assert.ok(ids.has("a") && ids.has("b"));
  ids.add("c");
  assert.ok(!ids.has("a"), "oldest evicted");
  assert.ok(ids.has("b") && ids.has("c"));
});

test("SentIds: ignores empty ids and duplicates", () => {
  const ids = new SentIds(2);
  ids.add(undefined);
  ids.add(null);
  ids.add("");
  assert.ok(!ids.has(undefined) && !ids.has(""));
  ids.add("a");
  ids.add("a");
  ids.add("b");
  assert.ok(ids.has("a"), "duplicate add did not consume a slot");
});

// ---------------------------------------------------------------------------
// Matrix reply fallback
// ---------------------------------------------------------------------------

test("stripReplyFallback: drops the quoted fallback, keeps the reply", () => {
  const body = "> <@vega:example.com> the migration is done\n\nthanks!";
  assert.equal(stripReplyFallback(body), "thanks!");
});

test("stripReplyFallback: multi-line quotes and plain bodies", () => {
  assert.equal(
    stripReplyFallback("> <@vega:example.com> line one\n> line two\n\nok"),
    "ok",
  );
  assert.equal(stripReplyFallback("no fallback here"), "no fallback here");
});

// ---------------------------------------------------------------------------
// Telegram addressing
// ---------------------------------------------------------------------------

test("telegram: an @username mention addresses the bot", () => {
  assert.ok(isAddressedTo({ text: "@vega_bot status?" }, 42, "vega_bot"));
  assert.ok(isAddressedTo({ text: "hey @VEGA_BOT" }, 42, "vega_bot"), "case-insensitive");
  assert.ok(isAddressedTo({ caption: "@vega_bot what is this?" }, 42, "vega_bot"), "captions count");
  assert.ok(isAddressedTo({ text: "/status@vega_bot" }, 42, "vega_bot"), "command suffix counts");
});

test("telegram: a bare name or another bot's mention does not", () => {
  assert.ok(!isAddressedTo({ text: "vega_bot status?" }, 42, "vega_bot"), "no @, not a mention");
  assert.ok(!isAddressedTo({ text: "@vega_botswana hi" }, 42, "vega_bot"), "prefix of a longer handle");
  assert.ok(!isAddressedTo({ text: "@other_bot hi" }, 42, "vega_bot"));
  assert.ok(!isAddressedTo({ text: "just chatting" }, 42, "vega_bot"));
});

test("telegram: a reply to the bot's message addresses it", () => {
  assert.ok(isAddressedTo({ text: "thanks", reply_to_message: { from: { id: 42 } } }, 42, "vega_bot"));
  assert.ok(
    !isAddressedTo({ text: "thanks", reply_to_message: { from: { id: 7 } } }, 42, "vega_bot"),
    "a reply to someone else does not",
  );
});

test("telegram: a text_mention entity pointing at the bot addresses it", () => {
  const msg = { text: "Vega look", entities: [{ type: "text_mention", user: { id: 42 } }] };
  assert.ok(isAddressedTo(msg, 42, ""), "works even without a public username");
  assert.ok(!isAddressedTo({ ...msg, entities: [{ type: "text_mention", user: { id: 7 } }] }, 42, ""));
});

test("telegram: with no resolved identity, nothing looks addressed", () => {
  assert.ok(!isAddressedTo({ text: "@vega_bot hi" }, 0, ""));
  assert.ok(!isAddressedTo(undefined, 42, "vega_bot"));
});

test("telegram: a handle inside a URL or email is not a mention", () => {
  assert.ok(
    !isAddressedTo({ text: "see https://x.com/@vega_bot/status/1" }, 42, "vega_bot"),
    "a handle in a URL path is not someone addressing us",
  );
  assert.ok(!isAddressedTo({ text: "mail ops@vega_bot.example.com" }, 42, "vega_bot"));
});

test("telegram: entities decide when Telegram sends them", () => {
  const text = "@vega_bot look";
  const msg = { text, entities: [{ type: "mention", offset: 0, length: 9 }] };
  assert.ok(isAddressedTo(msg, 42, "vega_bot"));

  const other = "@someone_else look";
  assert.ok(
    !isAddressedTo({ text: other, entities: [{ type: "mention", offset: 0, length: 14 }] }, 42, "vega_bot"),
    "someone else's mention is not ours",
  );

  const cmd = "/status@vega_bot";
  assert.ok(
    isAddressedTo({ text: cmd, entities: [{ type: "bot_command", offset: 0, length: cmd.length }] }, 42, "vega_bot"),
  );
});

test("mentionEntities: merges text and caption entities", () => {
  assert.deepEqual(mentionEntities(undefined), []);
  assert.equal(
    mentionEntities({ entities: [{ type: "mention" }], caption_entities: [{ type: "url" }] }).length,
    2,
  );
});

test("stripBotMention: removes our handle and leaves the message intact", () => {
  const text = "@vega_bot check the logs";
  const entities = [{ type: "mention", offset: 0, length: 9 }];
  assert.equal(stripBotMention(text, entities, "vega_bot"), "check the logs");
  assert.equal(stripBotMention(text, [], "vega_bot"), "check the logs", "regex fallback matches");
  assert.equal(stripBotMention("vega_bot", [], "vega_bot"), "vega_bot", "a bare name is not a handle");
});

test("stripBotMention: newlines and indentation survive", () => {
  const text = "@vega_bot fix this:\n\nfunction f() {\n    return 1;\n}";
  const stripped = stripBotMention(text, [{ type: "mention", offset: 0, length: 9 }], "vega_bot");
  assert.equal(stripped, "fix this:\n\nfunction f() {\n    return 1;\n}");
});

test("stripBotMention: URLs and emails containing the handle are untouched", () => {
  const text = "@vega_bot summarize https://x.com/@vega_bot/status/1";
  const entities = [
    { type: "mention", offset: 0, length: 9 },
    { type: "url", offset: 20, length: 31 },
  ];
  assert.equal(
    stripBotMention(text, entities, "vega_bot"),
    "summarize https://x.com/@vega_bot/status/1",
  );
  assert.equal(
    stripBotMention("summarize https://x.com/@vega_bot/status/1", [], "vega_bot"),
    "summarize https://x.com/@vega_bot/status/1",
    "the fallback pattern also leaves the URL alone",
  );
  assert.equal(
    stripBotMention("mail ops@vega_bot.example.com", [], "vega_bot"),
    "mail ops@vega_bot.example.com",
  );
});

test("stripBotMention: a command keeps its slash so the router still sees it", () => {
  const cmd = "/status@vega_bot";
  assert.equal(
    stripBotMention(cmd, [{ type: "bot_command", offset: 0, length: cmd.length }], "vega_bot"),
    "/status",
  );
  assert.equal(stripBotMention(cmd, [], "vega_bot"), "/status", "regex fallback too");
});

test("gate: a slash command is never wrapped in observed context", () => {
  const gate = new MentionGate(true);
  gate.observe("#ops", "ada", "standup in 5");
  assert.equal(gate.withContext("#ops", "/status"), "/status", "the command stays a command");
  assert.equal(gate.pending("#ops"), 1, "context is kept for the next real turn");
  assert.match(gate.withContext("#ops", "what happened?"), /standup in 5/);
});

test("gate: the channel map is bounded", () => {
  const gate = new MentionGate(true, 5);
  for (let i = 0; i < MAX_OBSERVED_CHANNELS + 20; i++) gate.observe(`#c${i}`, "ada", "hi");
  assert.equal(gate.pending("#c0"), 0, "the oldest channel was evicted");
  assert.equal(gate.pending(`#c${MAX_OBSERVED_CHANNELS + 19}`), 1, "the newest is kept");
});

test("stripBotMention: removing a mid-sentence handle leaves single spacing", () => {
  const text = "hey @vega_bot check the logs";
  const entities = [{ type: "mention", offset: 4, length: 9 }];
  assert.equal(stripBotMention(text, entities, "vega_bot"), "hey check the logs");
  assert.equal(stripBotMention(text, [], "vega_bot"), "hey check the logs", "fallback matches");
});

test("stripBotMention: entities present but none of ours strips nothing", () => {
  const text = "thanks, see https://x.com/@vega_bot";
  const entities = [{ type: "url", offset: 12, length: 23 }];
  assert.equal(stripBotMention(text, entities, "vega_bot"), text);
});
