import type { KernPlugin, PluginContext } from "../types.js";
import { discordTool, setDiscordClient } from "./tools.js";
import { log } from "../../log.js";

export { setDiscordClient, getDiscordClient } from "./tools.js";

export const discordPlugin: KernPlugin = {
  name: "discord",

  tools: {
    discord: discordTool,
  },

  toolDescriptions: {
    discord:
      "Inspect and interact with Discord: read channel or DM history, add emoji reactions, view pinned messages, look up user profiles, or execute raw Discord REST API calls.",
  },

  async onStartup(ctx: PluginContext) {
    // Client is set dynamically by DiscordInterface when started
    log("discord", "discord plugin registered");
  },

  async onShutdown() {
    setDiscordClient(null);
  },
};
