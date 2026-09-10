import type { KernPlugin, PluginContext } from "../types.js";
import { ircTool, setIrcInterface, initIrcTool } from "./tools.js";

export { setIrcInterface, initIrcTool } from "./tools.js";

export const ircPlugin: KernPlugin = {
  name: "irc",

  tools: {
    irc: ircTool,
  },

  toolDescriptions: {
    irc: "manage IRC connections, register accounts, and query users/channels",
  },

  async onStartup(ctx: PluginContext) {
    initIrcTool(ctx.agentDir);
  },

  async onShutdown() {
    setIrcInterface(null);
  },
};
