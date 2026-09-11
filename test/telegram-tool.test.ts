import test from "node:test";
import assert from "node:assert/strict";
import { telegramTool, setTelegramBot } from "../src/plugins/telegram/tools.js";

test("telegramTool: returns error when telegram bot is not set", async () => {
  setTelegramBot(null);
  const result = await (telegramTool as any).execute({ action: "chat", chatId: "12345" });
  assert.ok(result.error);
  assert.match(result.error, /Telegram client is not available/);
});

test("telegramTool: handles 'chat' action", async () => {
  let calledWith: string | null = null;
  const mockBot = {
    api: {
      async getChat(chatId: string) {
        calledWith = chatId;
        return {
          id: 12345,
          type: "supergroup",
          title: "Homelab Chat",
          username: "homelab",
          description: "Homelab group chat",
        };
      },
    },
  } as any;

  setTelegramBot(mockBot);
  const result = await (telegramTool as any).execute({ action: "chat", chatId: "12345" });
  assert.equal(calledWith, "12345");
  assert.deepEqual(result, {
    id: 12345,
    type: "supergroup",
    title: "Homelab Chat",
    username: "homelab",
    description: "Homelab group chat",
    inviteLink: undefined,
    pinnedMessage: undefined,
  });
});

test("telegramTool: handles 'admins' action", async () => {
  let calledWith: string | null = null;
  const mockBot = {
    api: {
      async getChatAdministrators(chatId: string) {
        calledWith = chatId;
        return [
          {
            status: "creator",
            user: { id: 111, is_bot: false, first_name: "Oguz", username: "oguz" },
            is_anonymous: false,
          },
          {
            status: "administrator",
            user: { id: 222, is_bot: true, first_name: "Atlas", username: "atlas_bot" },
            custom_title: "Agent",
            is_anonymous: false,
          },
        ];
      },
    },
  } as any;

  setTelegramBot(mockBot);
  const result = await (telegramTool as any).execute({ action: "admins", chatId: "-100123" });
  assert.equal(calledWith, "-100123");
  assert.equal(result.count, 2);
  assert.equal(result.administrators[0].user.username, "oguz");
  assert.equal(result.administrators[1].customTitle, "Agent");
});

test("telegramTool: handles 'member' action", async () => {
  let calledChat: string | null = null;
  let calledUser: number | null = null;
  const mockBot = {
    api: {
      async getChatMember(chatId: string, userId: number) {
        calledChat = chatId;
        calledUser = userId;
        return {
          status: "member",
          user: { id: 111, is_bot: false, first_name: "Oguz", username: "oguz" },
        };
      },
    },
  } as any;

  setTelegramBot(mockBot);
  const result = await (telegramTool as any).execute({ action: "member", chatId: "-100123", userId: 111 });
  assert.equal(calledChat, "-100123");
  assert.equal(calledUser, 111);
  assert.equal(result.status, "member");
  assert.equal(result.user.username, "oguz");
});

test("telegramTool: handles 'pin' action", async () => {
  let calledPin: [string, number] | null = null;
  const mockBot = {
    api: {
      async pinChatMessage(chatId: string, messageId: number) {
        calledPin = [chatId, messageId];
        return true;
      },
    },
  } as any;

  setTelegramBot(mockBot);
  const result = await (telegramTool as any).execute({ action: "pin", chatId: "-100123", messageId: 99 });
  assert.deepEqual(calledPin, ["-100123", 99]);
  assert.equal(result.success, true);
});

test("telegramTool: handles 'unpin' action with specific messageId", async () => {
  let calledUnpin: [string, number] | null = null;
  const mockBot = {
    api: {
      async unpinChatMessage(chatId: string, messageId: number) {
        calledUnpin = [chatId, messageId];
        return true;
      },
    },
  } as any;

  setTelegramBot(mockBot);
  const result = await (telegramTool as any).execute({ action: "unpin", chatId: "-100123", messageId: 99 });
  assert.deepEqual(calledUnpin, ["-100123", 99]);
  assert.equal(result.success, true);
});

test("telegramTool: handles 'react' action", async () => {
  let calledReact: any = null;
  const mockBot = {
    api: {
      async setMessageReaction(chatId: string, messageId: number, reaction: any[]) {
        calledReact = { chatId, messageId, reaction };
        return true;
      },
    },
  } as any;

  setTelegramBot(mockBot);
  const result = await (telegramTool as any).execute({
    action: "react",
    chatId: "-100123",
    messageId: 99,
    emoji: "👍",
  });
  assert.deepEqual(calledReact, {
    chatId: "-100123",
    messageId: 99,
    reaction: [{ type: "emoji", emoji: "👍" }],
  });
  assert.equal(result.success, true);
  assert.equal(result.emoji, "👍");
});

test("telegramTool: handles 'raw' action", async () => {
  let calledRawWith: any = null;
  const mockBot = {
    api: {
      raw: {
        async getMe(params: any) {
          calledRawWith = params;
          return { id: 123, is_bot: true, first_name: "Atlas" };
        },
      },
    },
  } as any;

  setTelegramBot(mockBot);
  const result = await (telegramTool as any).execute({
    action: "raw",
    method: "getMe",
  });
  assert.deepEqual(calledRawWith, {});
  assert.deepEqual(result, { result: { id: 123, is_bot: true, first_name: "Atlas" } });
});
