import type { KernPlugin, PluginContext } from "../types.js";
import { telegramTool, setTelegramBot } from "./tools.js";
import { log } from "../../log.js";

export { setTelegramBot, getTelegramBot } from "./tools.js";

export const telegramPlugin: KernPlugin = {
  name: "telegram",

  tools: {
    telegram: telegramTool,
  },

  toolDescriptions: {
    telegram:
      "Inspect and interact with Telegram: view chat info, inspect administrators, check member status, pin or unpin messages, add reactions, or execute raw Telegram Bot API methods.",
  },

  async onStartup(ctx: PluginContext) {
    // Bot is set dynamically by TelegramInterface when started
    log("telegram", "telegram plugin registered");
  },

  async onShutdown() {
    setTelegramBot(null);
  },
};
