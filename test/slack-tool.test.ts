import test from "node:test";
import assert from "node:assert/strict";
import { slackTool, setSlackWebClient } from "../src/plugins/slack/tools.js";

test("slackTool: returns error when SlackInterface is not configured", async () => {
  setSlackWebClient(null);
  const res = await (slackTool as any).execute({ action: "history", channel: "C123" });
  assert.match(res, /Slack interface is not running or not configured/);
});

test("slackTool: history action returns formatted messages", async () => {
  const fakeClient: any = {
    conversations: {
      async history({ channel, limit }: any) {
        assert.equal(channel, "C123");
        assert.equal(limit, 20);
        return {
          ok: true,
          messages: [
            { user: "U1", ts: "1700000000.000100", text: "Hello world" },
            { user: "U2", ts: "1700000001.000200", text: "Reply here", reactions: [{ name: "eyes", count: 2 }] },
          ],
        };
      },
    },
  };

  setSlackWebClient(fakeClient);
  const res = await (slackTool as any).execute({ action: "history", channel: "C123" });
  assert.match(res, /History for C123/);
  assert.match(res, /<@U1> \[ts: 1700000000\.000100\]: Hello world/);
  assert.match(res, /<@U2> \[ts: 1700000001\.000200\]: Reply here \[:eyes: \(2\)\]/);
});

test("slackTool: thread action returns discussion replies", async () => {
  const fakeClient: any = {
    conversations: {
      async replies({ channel, ts }: any) {
        assert.equal(channel, "C123");
        assert.equal(ts, "1700000000.000100");
        return {
          ok: true,
          messages: [
            { user: "U1", ts: "1700000000.000100", text: "Original message" },
            { user: "U2", ts: "1700000005.000200", text: "Thread reply" },
          ],
        };
      },
    },
  };

  setSlackWebClient(fakeClient);
  const res = await (slackTool as any).execute({ action: "thread", channel: "C123", threadTs: "1700000000.000100" });
  assert.match(res, /Thread 1700000000\.000100 in C123/);
  assert.match(res, /<@U1> \[ts: 1700000000\.000100\] \(parent\): Original message/);
  assert.match(res, /<@U2> \[ts: 1700000005\.000200\]: Thread reply/);
});

test("slackTool: channels action lists public/private channels", async () => {
  const fakeClient: any = {
    conversations: {
      async list() {
        return {
          ok: true,
          channels: [
            { id: "C1", name: "general", is_private: false, num_members: 42, topic: { value: "Company chat" } },
            { id: "C2", name: "secret", is_private: true, num_members: 5 },
          ],
        };
      },
    },
  };

  setSlackWebClient(fakeClient);
  const res = await (slackTool as any).execute({ action: "channels" });
  assert.match(res, /#general \(C1, public\) \(42 members\) — Company chat/);
  assert.match(res, /#secret \(C2, private\) \(5 members\)/);
});

test("slackTool: user action returns profile info", async () => {
  const fakeClient: any = {
    users: {
      async info({ user }: any) {
        assert.equal(user, "U123");
        return {
          ok: true,
          user: {
            id: "U123",
            name: "alice",
            real_name: "Alice Smith",
            tz_label: "Pacific Daylight Time",
            profile: {
              real_name: "Alice Smith",
              display_name: "asmith",
              title: "Infra Lead",
              email: "alice@example.com",
              status_emoji: ":computer:",
              status_text: "Coding",
            },
          },
        };
      },
    },
  };

  setSlackWebClient(fakeClient);
  const res = await (slackTool as any).execute({ action: "user", userId: "<@U123>" });
  assert.match(res, /User Profile for U123:/);
  assert.match(res, /Username: @alice/);
  assert.match(res, /Real Name: Alice Smith/);
  assert.match(res, /Email: alice@example\.com/);
  assert.match(res, /Status: :computer: Coding/);
});

test("slackTool: react action adds emoji reaction", async () => {
  let reactionAdded = false;
  const fakeClient: any = {
    reactions: {
      async add({ channel, timestamp, name }: any) {
        assert.equal(channel, "C123");
        assert.equal(timestamp, "1700000000.000100");
        assert.equal(name, "white_check_mark");
        reactionAdded = true;
        return { ok: true };
      },
    },
  };

  setSlackWebClient(fakeClient);
  const res = await (slackTool as any).execute({
    action: "react",
    channel: "C123",
    timestamp: "1700000000.000100",
    name: ":white_check_mark:",
  });
  assert.equal(reactionAdded, true);
  assert.match(res, /Added reaction :white_check_mark: to message 1700000000\.000100 in C123/);
});

test("slackTool: pins and bookmarks actions return items", async () => {
  const fakeClient: any = {
    pins: {
      async list({ channel }: any) {
        assert.equal(channel, "C123");
        return {
          ok: true,
          items: [
            { type: "message", message: { user: "U1", ts: "1700000000", text: "Important runbook" } },
          ],
        };
      },
    },
    bookmarks: {
      async list({ channel_id }: any) {
        assert.equal(channel_id, "C123");
        return {
          ok: true,
          bookmarks: [
            { title: "Grafana", link: "https://grafana.example.com", emoji: "📊" },
          ],
        };
      },
    },
  };

  setSlackWebClient(fakeClient);
  const pinsRes = await (slackTool as any).execute({ action: "pins", channel: "C123" });
  assert.match(pinsRes, /Important runbook/);

  const bookmarksRes = await (slackTool as any).execute({ action: "bookmarks", channel: "C123" });
  assert.match(bookmarksRes, /Grafana — https:\/\/grafana\.example\.com/);
});
