import type { KernPlugin, PluginContext } from "../types.js";
import { JobRegistry, formatDuration } from "./registry.js";
import { bashTool, jobsTool, setRegistry } from "./tools.js";
import { log } from "../../log.js";

/**
 * Shell plugin — provides the `bash` tool on Unix/Linux and owns background
 * execution of shell commands.
 *
 * `bash({ background: true })` starts a detached job and returns at once.
 * When the job finishes, the registry formats a completion message and hands
 * it to `ctx.announce()` together with the origin captured from the turn
 * that started the job. The message queue then splices it into that
 * conversation's active turn, queues it behind a foreign turn, or wakes the
 * agent — and the runtime delivers the agent's reply to the origin chat.
 *
 * Tool scope is enforced here because plugin tools bypass the core scope
 * check: `bash` and `jobs` are registered only when `toolScope` is `full`.
 * Windows keeps the core `pwsh` tool; this plugin registers nothing there.
 */

let registry: JobRegistry | null = null;

export const shellPlugin: KernPlugin = {
  name: "shell",

  // Populated in onStartup — depends on config and platform.
  tools: {},

  toolDescriptions: {
    bash: "Run a shell command. Pass background: true for long-running commands; the result arrives as a new message when it finishes. Add remindEvery (seconds) to be reminded while it runs.",
    jobs: "List, inspect, tail, or kill background jobs.",
  },

  onStartup: async (ctx: PluginContext) => {
    const isWindows = process.platform === "win32";
    if (isWindows || ctx.config.toolScope !== "full") {
      shellPlugin.tools = {};
      shellPlugin.toolDescriptions = {};
      log("shell", isWindows ? "windows — bash not registered (core pwsh in use)" : `toolScope=${ctx.config.toolScope} — bash not registered`);
      return;
    }
    registry = new JobRegistry(ctx.agentDir);
    const reaped = await registry.reapOrphans();
    if (reaped > 0) log("shell", `reaped ${reaped} orphaned job(s) from a previous run`);
    registry.setAnnouncer((record, body) => {
      if (!record.origin) {
        log.warn("shell", `${record.id} finished with no origin — completion not delivered`);
        return;
      }
      // Returned so the registry can hold the next reminder until this one
      // has been consumed. Errors are logged here and never propagate.
      return ctx.announce(body, record.origin).catch((e) =>
        log.error("shell", `announce failed for ${record.id}: ${e.message}`),
      );
    });
    setRegistry(registry, ctx);
    shellPlugin.tools = { bash: bashTool, jobs: jobsTool };
  },

  onShutdown: async () => {
    if (registry) {
      const killed = await registry.killAll();
      if (killed > 0) log("shell", `killed ${killed} running job(s) on shutdown`);
    }
    registry = null;
    setRegistry(null, null);
  },

  onStatus: () => {
    if (!registry) return {};
    return {
      jobs: {
        running: registry.countRunning(),
        total: registry.list().length,
      },
    };
  },

  commands: {
    "/jobs": {
      description: "list background jobs",
      handler: async () => {
        if (!registry) return "Background jobs not available.";
        const records = registry.list();
        if (records.length === 0) return "```yaml\njobs: {}\n```";

        const sorted = [...records].sort((a, b) => {
          if (a.status === "running" && b.status !== "running") return -1;
          if (b.status === "running" && a.status !== "running") return 1;
          return (b.finishedAt || "").localeCompare(a.finishedAt || "");
        });

        const lines = ["```yaml", "jobs:"];
        for (const r of sorted) {
          const cmd = r.command.replace(/\r?\n/g, " ").trim();
          lines.push(`  ${r.id}:`);
          lines.push(`    status: ${r.status}`);
          if (r.status !== "running") lines.push(`    exit: ${r.exitCode ?? "?"}${r.signal ? ` (${r.signal})` : ""}`);
          lines.push(`    runtime: ${formatDuration(r)}`);
          if (r.status === "running" && r.remindEverySec) lines.push(`    remind: every ${r.remindEverySec}s`);
          lines.push(`    command: "${(cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd).replace(/"/g, '\\"')}"`);
          if (r.origin) lines.push(`    origin: ${r.origin.interface}, ${r.origin.channel}`);
        }
        lines.push("```");
        return lines.join("\n");
      },
    },
  },
};
