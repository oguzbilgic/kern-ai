import test from "node:test";
import assert from "node:assert";
import { chunkMessage } from "../src/interfaces/discord.js";

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
