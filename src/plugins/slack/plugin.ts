import type { KernPlugin, PluginContext } from "../types.js";
import { slackTool, setSlackWebClient } from "./tools.js";
import { WebClient } from "@slack/web-api";
import { log } from "../../log.js";

export { setSlackWebClient } from "./tools.js";

export const slackPlugin: KernPlugin = {
  name: "slack",

  tools: {
    slack: slackTool,
  },

  toolDescriptions: {
    slack:
      "Inspect and interact with Slack workspaces: read channel history, inspect discussion threads, list channels, look up users, view pinned messages, check bookmarks, or add emoji reactions.",
  },

  async onStartup(ctx: PluginContext) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (token) {
      setSlackWebClient(new WebClient(token));
      log("slack", "initialized Slack web client for slack plugin");
    }
  },

  async onShutdown() {
    setSlackWebClient(null);
  },
};
