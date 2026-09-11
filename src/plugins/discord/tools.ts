import { tool } from "ai";
import { z } from "zod";
import type { Client } from "discord.js";

let _client: Client | null = null;

export function setDiscordClient(client: Client | null) {
  _client = client;
}

export function getDiscordClient(): Client | null {
  return _client;
}

export const discordTool = tool({
  description:
    "Inspect and interact with Discord: read channel or DM history, add emoji reactions, view pinned messages, look up user profiles, or execute raw Discord REST API calls.",
  inputSchema: z.object({
    action: z
      .enum(["history", "react", "pins", "user", "raw"])
      .describe(
        "history: read recent messages in a channel or DM. react: add an emoji reaction to a message. pins: list pinned messages in a channel or DM. user: look up user profile by ID. raw: make an arbitrary Discord REST API request.",
      ),
    channel: z
      .string()
      .optional()
      .describe("Channel ID or DM channel ID for history, react, or pins"),
    messageId: z
      .string()
      .optional()
      .describe("Message ID for react"),
    emoji: z
      .string()
      .optional()
      .describe("Emoji for react (Unicode character e.g. '👍', '👀', or custom emoji name:id 'name:123456789')"),
    userId: z
      .string()
      .optional()
      .describe("User ID for user lookup"),
    limit: z
      .number()
      .optional()
      .describe("Maximum items to return (default 20, max 100)"),
    before: z
      .string()
      .optional()
      .describe("Only get messages before this message ID (for history)"),
    after: z
      .string()
      .optional()
      .describe("Only get messages after this message ID (for history)"),
    method: z
      .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
      .optional()
      .describe("HTTP method for raw REST action (default: GET)"),
    path: z
      .string()
      .optional()
      .describe("REST API path for raw action (e.g. '/users/@me', '/channels/123/messages')"),
    body: z
      .string()
      .optional()
      .describe("JSON string payload for raw action (for POST, PATCH, PUT)"),
  }),
  execute: async ({
    action,
    channel,
    messageId,
    emoji,
    userId,
    limit = 20,
    before,
    after,
    method = "GET",
    path,
    body,
  }) => {
    if (!_client) {
      return "Error: Discord interface is not running or not configured on this agent.";
    }

    const client = _client;
    const boundedLimit = Math.min(Math.max(1, limit), 100);

    try {
      switch (action) {
        case "history": {
          if (!channel) return "Error: channel is required for history";
          let targetChannel: any = await client.channels.fetch(channel).catch(() => null);

          // If not found as a channel, check if channel is a userId and try to open DM
          if (!targetChannel) {
            const user = await client.users.fetch(channel).catch(() => null);
            if (user) {
              targetChannel = await user.createDM().catch(() => null);
            }
          }

          if (!targetChannel || !("messages" in targetChannel)) {
            return `Error: Channel "${channel}" not found or is not a text channel.`;
          }

          const fetchOptions: any = { limit: boundedLimit };
          if (before) fetchOptions.before = before;
          if (after) fetchOptions.after = after;

          const messages = await targetChannel.messages.fetch(fetchOptions);
          if (messages.size === 0) {
            return `No messages found in channel ${channel}.`;
          }

          const sorted = Array.from(messages.values()).sort(
            (a: any, b: any) => a.createdTimestamp - b.createdTimestamp,
          );

          const lines = sorted.map((m: any) => {
            const author = `${m.author.tag || m.author.username} (${m.author.id})`;
            const ts = m.createdAt ? m.createdAt.toISOString() : "";
            const reactions = m.reactions.cache
              .map((r: any) => `${r.emoji.name} (${r.count})`)
              .join(" ");
            const rxStr = reactions ? ` [${reactions}]` : "";
            const attachments = m.attachments.size > 0
              ? ` [${m.attachments.map((a: any) => a.name || a.url).join(", ")}]`
              : "";
            return `[${ts}] [id: ${m.id}] ${author}: ${m.content || "(no text)"}${attachments}${rxStr}`;
          });

          return `History for ${channel} (${messages.size} messages):\n\n${lines.join("\n")}`;
        }

        case "react": {
          if (!channel) return "Error: channel is required for react";
          if (!messageId) return "Error: messageId is required for react";
          if (!emoji) return "Error: emoji is required for react";

          const targetChannel: any = await client.channels.fetch(channel).catch(() => null);
          if (!targetChannel || !("messages" in targetChannel)) {
            return `Error: Channel "${channel}" not found or is not a text channel.`;
          }

          const msg = await targetChannel.messages.fetch(messageId).catch(() => null);
          if (!msg) {
            return `Error: Message "${messageId}" not found in channel "${channel}".`;
          }

          await msg.react(emoji);
          return `Added reaction ${emoji} to message ${messageId} in channel ${channel}.`;
        }

        case "pins": {
          if (!channel) return "Error: channel is required for pins";
          const targetChannel: any = await client.channels.fetch(channel).catch(() => null);
          if (!targetChannel || !("messages" in targetChannel)) {
            return `Error: Channel "${channel}" not found or is not a text channel.`;
          }

          const pins = await targetChannel.messages.fetchPinned();
          if (pins.size === 0) {
            return `No pinned messages found in channel ${channel}.`;
          }

          const lines = Array.from(pins.values()).map((m: any) => {
            const author = `${m.author.tag || m.author.username} (${m.author.id})`;
            const ts = m.createdAt ? m.createdAt.toISOString() : "";
            return `[${ts}] [id: ${m.id}] ${author}: ${m.content || "(no text)"}`;
          });

          return `Pinned messages in ${channel} (${pins.size} pins):\n\n${lines.join("\n")}`;
        }

        case "user": {
          if (!userId) return "Error: userId is required for user lookup";
          const user = await client.users.fetch(userId).catch(() => null);
          if (!user) {
            return `User "${userId}" not found.`;
          }

          const info = [
            `ID: ${user.id}`,
            `Username: ${user.username}`,
            `Global Name: ${user.globalName || "(none)"}`,
            `Tag: ${user.tag}`,
            `Bot: ${user.bot ? "yes" : "no"}`,
            `Created At: ${user.createdAt.toISOString()}`,
            user.avatarURL() ? `Avatar: ${user.avatarURL()}` : undefined,
          ].filter(Boolean);

          return `User info for ${userId}:\n\n${info.join("\n")}`;
        }

        case "raw": {
          if (!path) return "Error: path is required for raw action";
          const formattedPath = path.startsWith("/") ? path : `/${path}`;

          let parsedBody: any = undefined;
          if (body) {
            try {
              parsedBody = JSON.parse(body);
            } catch (err: any) {
              return `Error parsing JSON body: ${err.message}`;
            }
          }

          const reqOptions: any = {};
          if (parsedBody !== undefined) {
            reqOptions.body = parsedBody;
          }

          const upperMethod = method.toUpperCase();
          let res: any;

          switch (upperMethod) {
            case "GET":
              res = await (client.rest as any).get(formattedPath, reqOptions);
              break;
            case "POST":
              res = await (client.rest as any).post(formattedPath, reqOptions);
              break;
            case "PATCH":
              res = await (client.rest as any).patch(formattedPath, reqOptions);
              break;
            case "PUT":
              res = await (client.rest as any).put(formattedPath, reqOptions);
              break;
            case "DELETE":
              res = await (client.rest as any).delete(formattedPath, reqOptions);
              break;
            default:
              return `Unsupported method: ${method}`;
          }

          if (res === null || res === undefined) {
            return `${upperMethod} ${formattedPath} succeeded with no response content.`;
          }

          const out = typeof res === "object" ? JSON.stringify(res, null, 2) : String(res);
          return out.length > 25000 ? `${out.slice(0, 25000)}\n\n[truncated]` : out;
        }

        default:
          return `Unknown action: ${action}`;
      }
    } catch (err: any) {
      return `Discord API error: ${err.message || String(err)}`;
    }
  },
});
