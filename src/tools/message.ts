import { tool } from "ai";
import { z } from "zod";

type SendFn = (userId: string, iface: string, text: string) => Promise<boolean>;

let _sendFn: SendFn | null = null;

export function setMessageSender(fn: SendFn) {
  _sendFn = fn;
}

export const messageTool = tool({
  description:
    "Send a message to a user or a room on a specific interface. Use this to proactively reach out to users, notify them, or relay information from your operator. A user ID reaches that user's DM; a room or channel ID posts to that room. Do NOT use this tool to reply to incoming messages — your standard text response is automatically sent back to the user.",
  inputSchema: z.object({
    userId: z.string().describe("The user ID to message (from USERS.md or pairing data), or a room/channel ID to post there (e.g. Matrix '!room:server', Slack channel ID)"),
    interface: z.string().describe("The interface to send on: telegram, slack, matrix, discord, nostr, irc, hub."),
    text: z.string().describe("The message text to send"),
  }),
  execute: async ({ userId, interface: iface, text }) => {
    if (!_sendFn) return "Error: messaging not available — no send function configured.";
    try {
      const sent = await _sendFn(userId, iface, text);
      if (sent) return `Message sent to ${userId} on ${iface}.`;
      return `Failed to send — user ${userId} not found on ${iface}, or interface not connected.`;
    } catch (e: any) {
      return `Error sending message: ${e.message}`;
    }
  },
});
