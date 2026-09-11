import type { KernPlugin, PluginContext } from "../types.js";
import { openrouterTool, setOpenRouterKey } from "./tools.js";
import { log } from "../../log.js";

export { setOpenRouterKey, getOpenRouterKey } from "./tools.js";

export const openrouterPlugin: KernPlugin = {
  name: "openrouter",

  tools: {
    openrouter: openrouterTool,
  },

  toolDescriptions: {
    openrouter:
      "Inspect OpenRouter API key limits, daily/monthly spend, available models, pricing, and generation metadata.",
  },

  async onStartup(ctx: PluginContext) {
    const key = process.env.OPENROUTER_API_KEY;
    if (key) {
      setOpenRouterKey(key);
      log("openrouter", "openrouter plugin initialized");
    }
  },

  async onShutdown() {
    setOpenRouterKey(null);
  },
};
