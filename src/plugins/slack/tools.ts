import { tool } from "ai";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";

let _client: WebClient | null = null;

export function setSlackWebClient(client: WebClient | null) {
  _client = client;
}

export function getSlackWebClient(): WebClient | null {
  return _client;
}

export const slackTool = tool({
  description:
    "Inspect and interact with Slack workspaces: read channel history, inspect discussion threads, list channels, look up users, view pinned messages, check channel bookmarks, or add emoji reactions.",
  inputSchema: z.object({
    action: z
      .enum(["history", "thread", "channels", "user", "react", "pins", "bookmarks"])
      .describe(
        "history: read recent messages in a channel. thread: read replies in a discussion thread. channels: list public and private channels. user: look up user profile by ID. react: add an emoji reaction. pins: list pinned messages in a channel. bookmarks: list bookmarks in a channel.",
      ),
    channel: z.string().optional().describe("Channel ID (e.g. 'C12345678') for history, thread, react, pins, or bookmarks"),
    threadTs: z.string().optional().describe("Thread timestamp (thread_ts) for reading replies in a thread"),
    timestamp: z.string().optional().describe("Message timestamp (ts) for adding a reaction"),
    name: z.string().optional().describe("Emoji name without colons (e.g. 'thumbsup', 'eyes', 'white_check_mark') for react"),
    userId: z.string().optional().describe("User ID (e.g. 'U12345678') for user profile lookup"),
    limit: z.number().optional().describe("Maximum items to return (default 20, max 100)"),
    oldest: z.string().optional().describe("Only messages after this timestamp (for history)"),
    latest: z.string().optional().describe("Only messages before this timestamp (for history)"),
    types: z.string().optional().describe("Comma-separated channel types for channels action (default: 'public_channel,private_channel')"),
  }),
  execute: async ({ action, channel, threadTs, timestamp, name, userId, limit = 20, oldest, latest, types }) => {
    if (!_client) {
      return "Error: Slack interface is not running or not configured on this agent.";
    }

    const client = _client;
    const boundedLimit = Math.min(Math.max(1, limit), 100);

    try {
      switch (action) {
        case "history": {
          if (!channel) return "Error: channel is required for history";
          const res = await client.conversations.history({
            channel,
            limit: boundedLimit,
            oldest,
            latest,
          });

          if (!res.ok || !res.messages) {
            return `Failed to fetch channel history: ${res.error || "unknown error"}`;
          }

          if (res.messages.length === 0) {
            return `No messages found in channel ${channel}.`;
          }

          const lines = res.messages.map((m: any) => {
            const user = m.user || m.bot_id || "unknown";
            const ts = m.ts ? ` [ts: ${m.ts}]` : "";
            const thread = m.thread_ts && m.thread_ts !== m.ts ? ` (thread: ${m.thread_ts})` : "";
            const reactions = m.reactions?.map((r: any) => `:${r.name}: (${r.count})`).join(" ") || "";
            const rxStr = reactions ? ` [${reactions}]` : "";
            return `<@${user}>${ts}${thread}: ${m.text || "(no text)"}${rxStr}`;
          });

          return `History for ${channel} (${res.messages.length} messages, newest first):\n\n${lines.join("\n")}`;
        }

        case "thread": {
          if (!channel) return "Error: channel is required for thread";
          if (!threadTs) return "Error: threadTs is required for thread";

          const res = await client.conversations.replies({
            channel,
            ts: threadTs,
            limit: boundedLimit,
          });

          if (!res.ok || !res.messages) {
            return `Failed to fetch thread replies: ${res.error || "unknown error"}`;
          }

          if (res.messages.length === 0) {
            return `No messages found in thread ${threadTs}.`;
          }

          const lines = res.messages.map((m: any, i: number) => {
            const user = m.user || m.bot_id || "unknown";
            const ts = m.ts ? ` [ts: ${m.ts}]` : "";
            const isParent = i === 0 ? " (parent)" : "";
            const reactions = m.reactions?.map((r: any) => `:${r.name}: (${r.count})`).join(" ") || "";
            const rxStr = reactions ? ` [${reactions}]` : "";
            return `<@${user}>${ts}${isParent}: ${m.text || "(no text)"}${rxStr}`;
          });

          return `Thread ${threadTs} in ${channel} (${res.messages.length} messages):\n\n${lines.join("\n")}`;
        }

        case "channels": {
          const channelTypes = types || "public_channel,private_channel";
          const res = await client.conversations.list({
            types: channelTypes,
            limit: boundedLimit,
            exclude_archived: true,
          });

          if (!res.ok || !res.channels) {
            return `Failed to list channels: ${res.error || "unknown error"}`;
          }

          if (res.channels.length === 0) {
            return "No accessible channels found.";
          }

          const list = res.channels.map((c: any) => {
            const kind = c.is_private ? "private" : "public";
            const topic = c.topic?.value ? ` — ${c.topic.value.slice(0, 60)}` : "";
            const memberCount = c.num_members !== undefined ? ` (${c.num_members} members)` : "";
            return `- #${c.name} (${c.id}, ${kind})${memberCount}${topic}`;
          });

          return `Channels (${res.channels.length}):\n${list.join("\n")}`;
        }

        case "user": {
          if (!userId) return "Error: userId is required for user lookup";
          // Strip <@...> formatting if provided
          const cleanId = userId.replace(/^[<@]+|[>]+$/g, "");
          const res = await client.users.info({ user: cleanId });

          if (!res.ok || !res.user) {
            return `Failed to look up user ${userId}: ${res.error || "unknown error"}`;
          }

          const u = res.user;
          const p = u.profile || {};
          return [
            `User Profile for ${u.id}:`,
            `  Username: @${u.name || "unknown"}`,
            `  Real Name: ${p.real_name || u.real_name || "unknown"}`,
            `  Display Name: ${p.display_name || "none"}`,
            `  Title/Role: ${p.title || "none"}`,
            `  Email: ${p.email || "none"}`,
            `  Timezone: ${u.tz_label || u.tz || "unknown"}`,
            `  Status: ${p.status_emoji ? `${p.status_emoji} ` : ""}${p.status_text || "none"}`,
            `  Bot: ${u.is_bot ? "yes" : "no"}`,
          ].join("\n");
        }

        case "react": {
          if (!channel) return "Error: channel is required for react";
          if (!timestamp) return "Error: timestamp is required for react";
          if (!name) return "Error: name (emoji name) is required for react";

          const emojiName = name.replace(/^:+|:+$/g, "");
          const res = await client.reactions.add({
            channel,
            timestamp,
            name: emojiName,
          });

          if (!res.ok) {
            return `Failed to add reaction :${emojiName}: ${res.error || "unknown error"}`;
          }

          return `Added reaction :${emojiName}: to message ${timestamp} in ${channel}`;
        }

        case "pins": {
          if (!channel) return "Error: channel is required for pins";
          const res = await client.pins.list({ channel });

          if (!res.ok || !res.items) {
            return `Failed to list pins: ${res.error || "unknown error"}`;
          }

          if (res.items.length === 0) {
            return `No pinned items in channel ${channel}.`;
          }

          const lines = res.items.map((item: any) => {
            if (item.type === "message" && item.message) {
              const m = item.message;
              const user = m.user || m.bot_id || "unknown";
              const ts = m.ts ? ` [ts: ${m.ts}]` : "";
              return `- Message by <@${user}>${ts}: ${(m.text || "").slice(0, 150)}`;
            } else if (item.type === "file" && item.file) {
              return `- File: ${item.file.name || item.file.title || "unnamed file"} (${item.file.filetype || "unknown"})`;
            }
            return `- Item (${item.type})`;
          });

          return `Pinned items in ${channel} (${res.items.length}):\n${lines.join("\n")}`;
        }

        case "bookmarks": {
          if (!channel) return "Error: channel is required for bookmarks";
          const res = await client.bookmarks.list({ channel_id: channel });

          if (!res.ok || !res.bookmarks) {
            return `Failed to list bookmarks: ${res.error || "unknown error"}`;
          }

          if (res.bookmarks.length === 0) {
            return `No bookmarks in channel ${channel}.`;
          }

          const lines = res.bookmarks.map((b: any) => {
            const title = b.title || "Untitled";
            const link = b.link ? ` — ${b.link}` : "";
            const emoji = b.emoji ? `${b.emoji} ` : "";
            return `- ${emoji}${title}${link}`;
          });

          return `Bookmarks in ${channel} (${res.bookmarks.length}):\n${lines.join("\n")}`;
        }
      }
    } catch (err: any) {
      return `Slack API error during ${action}: ${err.message || err}`;
    }
  },
});
