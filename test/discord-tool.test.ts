import test from "node:test";
import assert from "node:assert/strict";
import { discordTool, setDiscordClient } from "../src/plugins/discord/tools.js";

test("discordTool: returns error when Discord interface is not configured", async () => {
  setDiscordClient(null);
  const res = await (discordTool as any).execute({ action: "history", channel: "123456" });
  assert.match(res, /Discord interface is not running or not configured/);
});

test("discordTool: history action returns formatted messages", async () => {
  const fakeChannel = {
    messages: {
      async fetch({ limit }: any) {
        assert.equal(limit, 20);
        return new Map([
          [
            "m1",
            {
              id: "m1",
              content: "Hello from discord",
              author: { username: "alice", tag: "alice#0001", id: "u1" },
              createdAt: new Date("2026-09-10T12:00:00Z"),
              createdTimestamp: 1000,
              reactions: { cache: [] },
              attachments: new Map(),
            },
          ],
          [
            "m2",
            {
              id: "m2",
              content: "Second message",
              author: { username: "bob", tag: "bob#0002", id: "u2" },
              createdAt: new Date("2026-09-10T12:05:00Z"),
              createdTimestamp: 2000,
              reactions: { cache: [{ emoji: { name: "👍" }, count: 3 }] },
              attachments: new Map(),
            },
          ],
        ]);
      },
    },
  };

  const fakeClient: any = {
    channels: {
      async fetch(id: string) {
        if (id === "123456") return fakeChannel;
        return null;
      },
    },
  };

  setDiscordClient(fakeClient);
  const res = await (discordTool as any).execute({ action: "history", channel: "123456" });
  assert.match(res, /History for 123456 \(2 messages\):/);
  assert.match(res, /\[id: m1\] alice#0001 \(u1\): Hello from discord/);
  assert.match(res, /\[id: m2\] bob#0002 \(u2\): Second message \[👍 \(3\)\]/);
});

test("discordTool: react action adds emoji reaction", async () => {
  let reactedEmoji = "";
  const fakeChannel = {
    messages: {
      async fetch(id: string) {
        if (id === "m1") {
          return {
            id: "m1",
            react: async (e: string) => {
              reactedEmoji = e;
            },
          };
        }
        return null;
      },
    },
  };

  const fakeClient: any = {
    channels: {
      async fetch(id: string) {
        return id === "123456" ? fakeChannel : null;
      },
    },
  };

  setDiscordClient(fakeClient);
  const res = await (discordTool as any).execute({
    action: "react",
    channel: "123456",
    messageId: "m1",
    emoji: "🔥",
  });
  assert.equal(reactedEmoji, "🔥");
  assert.match(res, /Added reaction 🔥 to message m1 in channel 123456/);
});

test("discordTool: pins action lists pinned messages", async () => {
  const fakeChannel = {
    messages: {
      async fetchPinned() {
        return new Map([
          [
            "p1",
            {
              id: "p1",
              content: "Pinned announcement",
              author: { username: "admin", tag: "admin", id: "u0" },
              createdAt: new Date("2026-09-01T00:00:00Z"),
            },
          ],
        ]);
      },
    },
  };

  const fakeClient: any = {
    channels: {
      async fetch(id: string) {
        return id === "123456" ? fakeChannel : null;
      },
    },
  };

  setDiscordClient(fakeClient);
  const res = await (discordTool as any).execute({ action: "pins", channel: "123456" });
  assert.match(res, /Pinned messages in 123456 \(1 pins\):/);
  assert.match(res, /Pinned announcement/);
});

test("discordTool: user action fetches user profile", async () => {
  const fakeClient: any = {
    users: {
      async fetch(id: string) {
        if (id === "u123") {
          return {
            id: "u123",
            username: "tester",
            globalName: "Tester Operator",
            tag: "tester",
            bot: false,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            avatarURL: () => "https://cdn.discordapp.com/avatars/u123/avatar.png",
          };
        }
        return null;
      },
    },
  };

  setDiscordClient(fakeClient);
  const res = await (discordTool as any).execute({ action: "user", userId: "u123" });
  assert.match(res, /User info for u123:/);
  assert.match(res, /Username: tester/);
  assert.match(res, /Global Name: Tester Operator/);
  assert.match(res, /Bot: no/);
});

test("discordTool: raw action executes REST request", async () => {
  let calledPath = "";
  let calledOptions: any = null;

  const fakeClient: any = {
    rest: {
      async get(path: string, options: any) {
        calledPath = path;
        calledOptions = options;
        return { id: "123", username: "mybot" };
      },
      async post(path: string, options: any) {
        calledPath = path;
        calledOptions = options;
        return { ok: true };
      },
    },
  };

  setDiscordClient(fakeClient);

  // Test GET
  const resGet = await (discordTool as any).execute({ action: "raw", method: "GET", path: "/users/@me" });
  assert.equal(calledPath, "/users/@me");
  assert.match(resGet, /"username": "mybot"/);

  // Test POST with body
  const resPost = await (discordTool as any).execute({
    action: "raw",
    method: "POST",
    path: "/channels/123/messages",
    body: JSON.stringify({ content: "test" }),
  });
  assert.equal(calledPath, "/channels/123/messages");
  assert.deepEqual(calledOptions.body, { content: "test" });
  assert.match(resPost, /"ok": true/);
});
