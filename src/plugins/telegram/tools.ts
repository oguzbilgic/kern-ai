import { tool } from "ai";
import { z } from "zod";
import type { Bot } from "grammy";

let _bot: Bot | null = null;

export function setTelegramBot(bot: Bot | null) {
  _bot = bot;
}

export function getTelegramBot(): Bot | null {
  return _bot;
}

export const telegramTool = tool({
  description:
    "Inspect and interact with Telegram: view chat details, inspect administrators, check member status, pin or unpin messages, add emoji reactions, or execute raw Telegram Bot API methods.",
  inputSchema: z.object({
    action: z
      .enum(["chat", "admins", "member", "pin", "unpin", "react", "raw"])
      .describe(
        "chat: get information about a chat or channel. admins: list administrators in a chat. member: get details of a specific member in a chat. pin: pin a message in a chat. unpin: unpin a message (or all) in a chat. react: add or set emoji reaction on a message. raw: call any Telegram Bot API method directly.",
      ),
    chatId: z
      .string()
      .optional()
      .describe("Chat ID or channel username (e.g. '@channelusername' or '-1001234567890')"),
    userId: z
      .number()
      .optional()
      .describe("User ID for 'member' action"),
    messageId: z
      .number()
      .optional()
      .describe("Message ID for 'pin', 'unpin', or 'react'"),
    emoji: z
      .string()
      .optional()
      .describe("Emoji for 'react' (e.g. '👍', '🔥', '🎉')"),
    method: z
      .string()
      .optional()
      .describe("API method name for 'raw' action (e.g. 'getMe', 'exportChatInviteLink', 'setChatTitle')"),
    params: z
      .record(z.any())
      .optional()
      .describe("Parameters object for 'raw' action"),
  }),
  execute: async ({ action, chatId, userId, messageId, emoji, method, params }) => {
    if (!_bot) {
      return {
        error: "Telegram client is not available. Ensure TELEGRAM_BOT_TOKEN is configured and Telegram is enabled.",
      };
    }

    try {
      switch (action) {
        case "chat": {
          if (!chatId) return { error: "chatId is required for 'chat' action" };
          const chat = await _bot.api.getChat(chatId);
          return {
            id: chat.id,
            type: chat.type,
            title: "title" in chat ? chat.title : undefined,
            username: "username" in chat ? chat.username : undefined,
            description: "description" in chat ? chat.description : undefined,
            inviteLink: "invite_link" in chat ? chat.invite_link : undefined,
            pinnedMessage: "pinned_message" in chat && chat.pinned_message ? {
              messageId: chat.pinned_message.message_id,
              date: chat.pinned_message.date,
              text: chat.pinned_message.text,
            } : undefined,
          };
        }

        case "admins": {
          if (!chatId) return { error: "chatId is required for 'admins' action" };
          const admins = await _bot.api.getChatAdministrators(chatId);
          return {
            count: admins.length,
            administrators: admins.map((a) => ({
              status: a.status,
              user: {
                id: a.user.id,
                isBot: a.user.is_bot,
                firstName: a.user.first_name,
                lastName: a.user.last_name,
                username: a.user.username,
              },
              customTitle: "custom_title" in a ? a.custom_title : undefined,
              isAnonymous: "is_anonymous" in a ? a.is_anonymous : false,
            })),
          };
        }

        case "member": {
          if (!chatId) return { error: "chatId is required for 'member' action" };
          if (!userId) return { error: "userId is required for 'member' action" };
          const member = await _bot.api.getChatMember(chatId, userId);
          return {
            status: member.status,
            user: {
              id: member.user.id,
              isBot: member.user.is_bot,
              firstName: member.user.first_name,
              lastName: member.user.last_name,
              username: member.user.username,
            },
            untilDate: "until_date" in member ? member.until_date : undefined,
            customTitle: "custom_title" in member ? member.custom_title : undefined,
          };
        }

        case "pin": {
          if (!chatId) return { error: "chatId is required for 'pin' action" };
          if (!messageId) return { error: "messageId is required for 'pin' action" };
          await _bot.api.pinChatMessage(chatId, messageId);
          return { success: true, message: `Pinned message ${messageId} in chat ${chatId}` };
        }

        case "unpin": {
          if (!chatId) return { error: "chatId is required for 'unpin' action" };
          if (messageId) {
            await _bot.api.unpinChatMessage(chatId, messageId);
            return { success: true, message: `Unpinned message ${messageId} in chat ${chatId}` };
          }
          await _bot.api.unpinAllChatMessages(chatId);
          return { success: true, message: `Unpinned all messages in chat ${chatId}` };
        }

        case "react": {
          if (!chatId) return { error: "chatId is required for 'react' action" };
          if (!messageId) return { error: "messageId is required for 'react' action" };
          if (!emoji) return { error: "emoji is required for 'react' action" };
          await _bot.api.setMessageReaction(chatId, messageId, [
            { type: "emoji", emoji: emoji as any },
          ]);
          return { success: true, emoji, messageId, chatId };
        }

        case "raw": {
          if (!method) return { error: "method is required for 'raw' action (e.g. 'getMe', 'exportChatInviteLink')" };
          const rawFn = (_bot.api.raw as any)[method];
          if (typeof rawFn !== "function") {
            return { error: `Unknown Telegram Bot API method '${method}'` };
          }
          const result = await rawFn.call(_bot.api.raw, params || {});
          return { result };
        }

        default:
          return { error: `Unknown action '${action}'` };
      }
    } catch (err: any) {
      return { error: `Telegram API error: ${err.message}` };
    }
  },
});
