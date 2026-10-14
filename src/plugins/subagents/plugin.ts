import type { KernPlugin, PluginContext } from "../types.js";
import { SubAgentRegistry, formatDuration } from "./registry.js";
import { spawnTool, subagentsTool, setRegistry } from "./tools.js";
import { log } from "../../log.js";

/**
 * Sub-agents plugin — spawn read-only worker agents in parallel.
 *
 * Parent agents call the spawn tool to delegate focused tasks. Children run
 * in-process with a restricted toolset (read, glob, grep, webfetch, websearch)
 * and no access to plugins. When a child finishes, the registry formats a
 * completion body and hands it to `ctx.announce()` together with the origin
 * captured from the turn that spawned it. The message queue then splices it
 * into that conversation's active turn, or wakes the agent — and the runtime
 * delivers the agent's reply to the origin chat, the same way background
 * jobs (src/plugins/shell) are routed.
 *
 * See src/plugins/subagents/registry.ts for the registry/worker split.
 */

/** The one live registry for this plugin instance. */
let registry: SubAgentRegistry | null = null;

export const subagentsPlugin: KernPlugin = {
  name: "subagents",

  tools: {
    spawn: spawnTool,
    subagents: subagentsTool,
  },

  toolDescriptions: {
    spawn:
      "Spawn a sub-agent to work on a focused task in parallel (returns immediately; result arrives as a new turn when the child finishes).",
    subagents:
      "List, inspect, or cancel sub-agents you've spawned.",
  },

  onStartup: async (ctx: PluginContext) => {
    registry = new SubAgentRegistry(ctx.agentDir, ctx.config);
    registry.setAnnouncer((record, body) => {
      if (!record.origin) {
        // Spawn only runs inside a turn, so this should not happen. The result
        // is still on disk for `subagents result <id>`.
        log.error("subagent", `${record.id} finished with no origin — completion not delivered`);
        return;
      }
      return ctx.announce(body, record.origin).catch((e) =>
        log.error("subagent", `announce failed for ${record.id}: ${e.message}`),
      );
    });
    setRegistry(registry, ctx);
  },

  onShutdown: async () => {
    if (registry) {
      const cancelled = registry.cancelAll();
      if (cancelled > 0) log("subagent", `cancelled ${cancelled} running on shutdown`);
    }
    registry = null;
    setRegistry(null, null);
  },

  onStatus: () => {
    if (!registry) return {};
    return {
      subagents: {
        running: registry.countRunning(),
        total: registry.list().length,
      },
    };
  },

  commands: {
    "/subagents": {
      description: "list sub-agents",
      handler: async () => {
        if (!registry) return "Sub-agents plugin not loaded.";
        const records = registry.list();
        if (records.length === 0) {
          return "```yaml\nsubagents: {}\n```";
        }

        // running first, then by finishedAt desc (most recent on top)
        const sorted = [...records].sort((a, b) => {
          if (a.status === "running" && b.status !== "running") return -1;
          if (b.status === "running" && a.status !== "running") return 1;
          const aFin = a.finishedAt || "";
          const bFin = b.finishedAt || "";
          return bFin.localeCompare(aFin);
        });

        const lines = ["```yaml", "subagents:"];
        for (const r of sorted) {
          const dur = formatDuration(r);
          const cleanPrompt = r.prompt.replace(/\r?\n/g, " ").trim();
          const prompt = cleanPrompt.length > 50 ? cleanPrompt.slice(0, 50) + "..." : cleanPrompt;

          lines.push(`  ${r.id}:`);
          lines.push(`    status: ${r.status}`);
          lines.push(`    runtime: ${dur}`);
          lines.push(`    toolCalls: ${r.toolCalls}`);
          lines.push(`    prompt: "${prompt.replace(/"/g, '\\"')}"`);
          if (r.error) {
            lines.push(`    error: "${r.error.replace(/"/g, '\\"')}"`);
          }
          if (r.origin) lines.push(`    origin: ${r.origin.interface}, ${r.origin.channel}`);
        }
        lines.push("```");
        return lines.join("\n");
      },
    },
  },
};
