import test from "node:test";
import assert from "node:assert";
import { DiscordInterface, chunkMessage } from "../src/interfaces/discord.js";

test("chunkMessage: returns single chunk if within limit", () => {
  const msg = "Hello world";
  const chunks = chunkMessage(msg, 2000);
  assert.deepStrictEqual(chunks, ["Hello world"]);
});

test("chunkMessage: splits on newline when exceeding limit", () => {
  const line1 = "a".repeat(1200);
  const line2 = "b".repeat(900);
  const text = `${line1}\n${line2}`;
  const chunks = chunkMessage(text, 2000);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0], line1);
  assert.strictEqual(chunks[1], line2);
});

test("chunkMessage: splits on space when no suitable newline", () => {
  const part1 = "a".repeat(1200);
  const part2 = "b".repeat(900);
  const text = `${part1} ${part2}`;
  const chunks = chunkMessage(text, 2000);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0], part1);
  assert.strictEqual(chunks[1], part2);
});

test("chunkMessage: hard cuts when no whitespace", () => {
  const text = "a".repeat(2500);
  const chunks = chunkMessage(text, 2000);
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].length, 2000);
  assert.strictEqual(chunks[1].length, 500);
});

test("DiscordInterface: start() is non-blocking and stop() halts retry loop cleanly", async () => {
  const { DiscordInterface } = await import("../src/interfaces/discord.js");
  const discord = new DiscordInterface("fake-token");

  // Stub client.login to simulate transient failures
  let loginAttempts = 0;
  (discord as any).client.login = async () => {
    loginAttempts++;
    throw new Error("getaddrinfo ENOTFOUND discord.com");
  };

  const startPromise = discord.start({
    onMessage: async () => {},
  });

  // Verify start() resolves immediately without waiting for login
  let resolvedImmediately = false;
  await Promise.race([
    startPromise.then(() => { resolvedImmediately = true; }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("start() timed out")), 200)),
  ]);
  assert.strictEqual(resolvedImmediately, true);

  // Status should be set to error with the failure reason
  assert.strictEqual(discord.status, "error");
  assert.match(discord.statusDetail || "", /getaddrinfo ENOTFOUND/);
  assert.strictEqual(loginAttempts, 1);

  // Stop should cancel retries and reset status to disconnected without being overwritten
  await discord.stop();
  assert.strictEqual(discord.status, "disconnected");
  assert.strictEqual((discord as any).retryTimeout, undefined);
});

test("DiscordInterface: send in DMs and reply in guild channels", async () => {
  const { DiscordInterface } = await import("../src/interfaces/discord.js");
  const discord = new DiscordInterface("fake-token");

  let dmReplied = false;
  let dmSentMessage = "";
  const mockDMMessage = {
    author: { id: "user1", username: "oguz" },
    channel: {
      id: "dm-channel-1",
      type: 1, // ChannelType.DM
      send: async (payload: any) => {
        dmSentMessage = payload.content;
      },
    },
    guild: null,
    mentions: { users: new Map(), roles: new Map() },
    attachments: new Map(),
    content: "hello agent in dm",
    reply: async () => {
      dmReplied = true;
    },
  };

  let guildReplied = false;
  let guildReplyContent = "";
  const mockGuildMessage = {
    author: { id: "user2", username: "someone" },
    channel: {
      id: "guild-channel-1",
      type: 0, // ChannelType.GuildText
      name: "general",
      send: async () => {},
    },
    guild: {
      id: "guild-1",
      members: { me: { roles: { cache: new Map() } } },
    },
    mentions: { users: new Map([["fake-bot-id", {}]]), roles: new Map() },
    attachments: new Map(),
    content: "hello agent in channel",
    reply: async (payload: any) => {
      guildReplied = true;
      guildReplyContent = payload.content;
    },
  };

  // Trigger message handler directly
  let messageCreateHandler: any;
  (discord as any).botUserId = "fake-bot-id";
  (discord as any).client.on = (event: string, handler: any) => {
    if (event === "messageCreate") messageCreateHandler = handler;
  };
  (discord as any).client.login = async () => {};

  await discord.start({
    onMessage: async (msg) => `Reply to: ${msg.text}`,
  });

  // 1. DM message should use channel.send, NOT message.reply
  await messageCreateHandler(mockDMMessage);
  assert.strictEqual(dmReplied, false, "Should not reply() in DMs");
  assert.strictEqual(dmSentMessage, "Reply to: hello agent in dm");

  // 2. Guild message should use message.reply for the first chunk
  await messageCreateHandler(mockGuildMessage);
  assert.strictEqual(guildReplied, true, "Should reply() in guild channels");
  assert.strictEqual(guildReplyContent, "Reply to: hello agent in channel");

  await discord.stop();
});

test("DiscordInterface: emits intermediate text on tool-call event (per-step)", async () => {
  const discord = new DiscordInterface(
    "fake-token",
    {
      isPaired: () => true,
      hasAnyPairedUsers: () => true,
      autoPairFirst: async () => {},
      getOrCreateCode: async () => "code",
    } as any,
  );

  let messageCreateHandler: any;
  (discord as any).client = {
    on: (event: string, handler: any) => {
      if (event === "messageCreate") messageCreateHandler = handler;
    },
    once: () => {},
    login: async () => {},
    destroy: () => {},
    user: { id: "bot-id" },
    channels: { fetch: async () => null },
    users: { fetch: async () => null },
  };

  const sentMessages: string[] = [];
  const mockMessage = {
    author: { id: "user1", username: "oguz" },
    channel: {
      id: "dm-channel-1",
      type: 1, // DM
      send: async (payload: any) => {
        sentMessages.push(payload.content);
      },
    },
    guild: null,
    mentions: { users: new Map(), roles: new Map() },
    attachments: new Map(),
    content: "search for me",
    reply: async () => {},
  };

  await discord.start({
    onMessage: async (_env, onEvent) => {
      onEvent?.({ type: "text-delta", text: "Starting search..." });
      await onEvent?.({ type: "tool-call", toolName: "websearch" });
      onEvent?.({ type: "text-delta", text: "Here are the results." });
      return "Here are the results.";
    },
  });

  await messageCreateHandler(mockMessage);

  assert.strictEqual(sentMessages.length, 2);
  assert.strictEqual(sentMessages[0], "Starting search...");
  assert.strictEqual(sentMessages[1], "Here are the results.");

  await discord.stop();
});

