import type { KernPlugin, PluginContext, BeforeContextInfo, ContextInjection } from "./types.js";
import { dashboardPlugin } from "./dashboard/plugin.js";
import { notesPlugin } from "./notes/plugin.js";
import { recallPlugin } from "./recall/plugin.js";
import { mediaPlugin } from "./media/plugin.js";
import { skillsPlugin } from "./skills/plugin.js";
import { mcpPlugin } from "./mcp/plugin.js";
import { subagentsPlugin } from "./subagents/plugin.js";
import { slackPlugin } from "./slack/plugin.js";
import { ircPlugin } from "./irc/plugin.js";
import { discordPlugin } from "./discord/plugin.js";
import { telegramPlugin } from "./telegram/plugin.js";
import { openrouterPlugin } from "./openrouter/plugin.js";
import { log } from "../log.js";

export type { KernPlugin, PluginContext, RouteHandler, ContextInjection, BeforeContextInfo } from "./types.js";

/**
 * All available plugins. Add new plugins here.
 * In the future, config.plugins can gate which are loaded.
 */
const availablePlugins: KernPlugin[] = [
  notesPlugin,
  recallPlugin,
  mediaPlugin,
  dashboardPlugin,
  skillsPlugin,
  mcpPlugin,
  subagentsPlugin,
  slackPlugin,
  ircPlugin,
  discordPlugin,
  telegramPlugin,
  openrouterPlugin,
];

/** Active plugin instances after loading */
let activePlugins: KernPlugin[] = [];

// ---------------------------------------------------------------------------
// Plugin lifecycle & aggregation — single namespace for all plugin operations
// ---------------------------------------------------------------------------

export const plugins = {
  /** Load and start plugins. Returns active list for route registration. */
  async load(ctx: PluginContext): Promise<KernPlugin[]> {
    activePlugins = [];
    for (const plugin of availablePlugins) {
      try {
        if (plugin.onStartup) await plugin.onStartup(ctx);
        activePlugins.push(plugin);
        log("plugin", `loaded: ${plugin.name}`);
      } catch (err: any) {
        log.error("plugin", `failed to load ${plugin.name}: ${err.message}`);
      }
    }
    return activePlugins;
  },

  /** Graceful shutdown of all active plugins. */
  async shutdown(ctx: PluginContext) {
    for (const plugin of activePlugins) {
      if (plugin.onShutdown) {
        try {
          await plugin.onShutdown(ctx);
        } catch (err: any) {
          log.error("plugin", `shutdown error in ${plugin.name}: ${err.message}`);
        }
      }
    }
    activePlugins = [];
  },

  // --- Collect (merge data from all plugins) ---

  /** Merge all plugin tools into one record. */
  collectTools(): Record<string, any> {
    const tools: Record<string, any> = {};
    for (const plugin of activePlugins) {
      if (plugin.tools) Object.assign(tools, plugin.tools);
    }
    return tools;
  },

  /** Merge all plugin tool descriptions. */
  collectToolDescriptions(): Record<string, string> {
    const descriptions: Record<string, string> = {};
    for (const plugin of activePlugins) {
      if (plugin.toolDescriptions) Object.assign(descriptions, plugin.toolDescriptions);
    }
    return descriptions;
  },

  /** Gather context injections from all plugins. */
  async collectContextInjections(info: BeforeContextInfo, ctx: PluginContext): Promise<ContextInjection[]> {
    const injections: ContextInjection[] = [];
    for (const plugin of activePlugins) {
      if (plugin.onBeforeContext) {
        try {
          const result = await plugin.onBeforeContext(info, ctx);
          if (result) {
            if (Array.isArray(result)) {
              injections.push(...result);
            } else {
              injections.push(result);
            }
          }
        } catch (err: any) {
          log.error("plugin", `onBeforeContext error in ${plugin.name}: ${err.message}`);
        }
      }
    }
    return injections;
  },

  // --- Dispatch (fire hooks to plugins) ---

  /** Notify all plugins of a tool result (fire-to-all). */
  dispatchToolResult(toolName: string, result: string, emit: (event: any) => void, ctx: PluginContext) {
    for (const plugin of activePlugins) {
      if (plugin.onToolResult) plugin.onToolResult(toolName, result, emit, ctx);
    }
  },

  /** Notify all plugins that a turn finished (fire-to-all). */
  async dispatchTurnFinish(sessionId: string, ctx: PluginContext) {
    for (const plugin of activePlugins) {
      if (plugin.onTurnFinish) {
        try {
          await plugin.onTurnFinish(sessionId, ctx);
        } catch (err: any) {
          log.error("plugin", `onTurnFinish error in ${plugin.name}: ${err.message}`);
        }
      }
    }
  },

  /** Look up a slash command handler from plugins. */
  getCommand(cmd: string): { description: string; handler: (ctx: PluginContext) => Promise<string> } | null {
    for (const plugin of activePlugins) {
      if (plugin.commands?.[cmd]) return plugin.commands[cmd];
    }
    return null;
  },

  /** Collect all plugin command descriptions for /help. */
  collectCommandDescriptions(): Record<string, string> {
    const cmds: Record<string, string> = {};
    for (const plugin of activePlugins) {
      if (plugin.commands) {
        for (const [cmd, { description }] of Object.entries(plugin.commands)) {
          cmds[cmd] = description;
        }
      }
    }
    return cmds;
  },

  /** Collect status info from all plugins. */
  collectStatus(ctx: PluginContext): Record<string, any> {
    const status: Record<string, any> = {};
    for (const plugin of activePlugins) {
      if (plugin.onStatus) {
        try {
          Object.assign(status, plugin.onStatus(ctx));
        } catch (err: any) {
          log.error("plugin", `onStatus error in ${plugin.name}: ${err.message}`);
        }
      }
    }
    return status;
  },

  /** Process attachments — first plugin that returns a message wins. */
  async dispatchProcessAttachments(
    attachments: import("../interfaces/types.js").Attachment[],
    userMessage: string,
    ctx: PluginContext,
  ): Promise<import("ai").ModelMessage | null> {
    for (const plugin of activePlugins) {
      if (plugin.onMessage?.processAttachments) {
        try {
          const result = await plugin.onMessage.processAttachments(attachments, userMessage, ctx);
          if (result) return result;
        } catch (err: any) {
          log.error("plugin", `processAttachments error in ${plugin.name}: ${err.message}`);
        }
      }
    }
    return null;
  },

  /** Resolve custom URIs in messages — chain through all plugins. */
  async dispatchResolveMessages(
    messages: import("ai").ModelMessage[],
    ctx: PluginContext,
  ): Promise<import("ai").ModelMessage[]> {
    let result = messages;
    for (const plugin of activePlugins) {
      if (plugin.onMessage?.resolveMessages) {
        try {
          result = await plugin.onMessage.resolveMessages(result, ctx);
        } catch (err: any) {
          log.error("plugin", `resolveMessages error in ${plugin.name}: ${err.message}`);
        }
      }
    }
    return result;
  },
};
