import type { KernPlugin, PluginContext } from "../types.js";
import type { McpServerConfig } from "../../config.js";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { substituteEnvDeep } from "../../util.js";
import { log } from "../../log.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

/** One connected MCP server. */
interface ActiveServer {
  name: string;
  client: MCPClient;
  tools: Array<{ name: string }>;
}

/** One server we tried and failed to connect to. */
interface FailedServer {
  name: string;
  reason: string;
}

/** Connected servers for the lifetime of this plugin. */
const active: ActiveServer[] = [];

/** Failed servers, for /status and /mcp visibility. */
const failed: FailedServer[] = [];

/** Count of servers present in config — for /status visibility even when all failed. */
let configured = 0;

/** First line of an error message, truncated for compact display. */
function shortReason(err: unknown): string {
  const msg = errMsg(err);
  const firstLine = msg.split("\n")[0];
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
}

/**
 * Merged tools from all servers, namespaced as `<server>__<tool>`.
 * Populated during onStartup; read by the plugin manager's collectTools()
 * which runs after onStartup awaits complete, so a plain object is fine.
 */
const mergedTools: Record<string, any> = {};

/**
 * Build a transport from one server's config. Env vars already substituted.
 */
function buildTransport(name: string, cfg: McpServerConfig) {
  if (cfg.transport === "http" || cfg.transport === "sse") {
    return {
      type: cfg.transport,
      url: cfg.url,
      ...(cfg.headers ? { headers: cfg.headers } : {}),
    } as const;
  }
  if (cfg.transport === "stdio") {
    return new Experimental_StdioMCPTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
    });
  }
  throw new Error(`unknown MCP transport for server "${name}"`);
}

/**
 * Connect to one server, fetch its tools, and prefix them with the server name.
 */
async function connectServer(name: string, cfg: McpServerConfig): Promise<void> {
  // Warn (don't fail) on unresolved ${VAR} references; let the server return
  // the real auth error so the user sees what's missing.
  const resolved = substituteEnvDeep(cfg, (missing) => {
    log.warn("mcp", `server "${name}": ${missing} not set in env`);
  });

  const transport = buildTransport(name, resolved);
  const client = await createMCPClient({ transport });

  try {
    const serverTools = await client.tools();

    const tools: Array<{ name: string }> = [];
    for (const [toolName, tool] of Object.entries(serverTools)) {
      mergedTools[`${name}__${toolName}`] = tool;
      tools.push({ name: toolName });
    }

    active.push({ name, client, tools });
    log("mcp", `connected "${name}" — ${tools.length} tool(s)`);
  } catch (err) {
    // Client is open (stdio may have spawned a subprocess). Close it before rethrowing.
    try {
      await client.close();
    } catch (closeErr) {
      log.warn("mcp", `server "${name}": close failed after startup error: ${errMsg(closeErr)}`);
    }
    throw err;
  }
}

export const mcpPlugin: KernPlugin = {
  name: "mcp",
  tools: mergedTools,

  async onStartup(ctx: PluginContext) {
    const servers = ctx.config.mcpServers;
    if (!servers || Object.keys(servers).length === 0) return;

    configured = Object.keys(servers).length;

    // Connect to all servers in parallel; failures don't block the agent
    // or other servers — they just mean those tools aren't available.
    await Promise.all(
      Object.entries(servers).map(([name, cfg]) =>
        connectServer(name, cfg).catch((err) => {
          log.error("mcp", `failed to connect "${name}": ${errMsg(err)}`);
          failed.push({ name, reason: shortReason(err) });
        }),
      ),
    );
  },

  async onShutdown() {
    await Promise.all(
      active.map((s) =>
        s.client.close().catch((err) => {
          log.warn("mcp", `close error for "${s.name}": ${errMsg(err)}`);
        }),
      ),
    );
    active.length = 0;
    failed.length = 0;
    configured = 0;
    for (const k of Object.keys(mergedTools)) delete mergedTools[k];
  },

  onStatus() {
    // Only stay silent when MCP isn't configured at all. If it is configured
    // but all connections failed, surface that in /status so operators see it.
    if (configured === 0) return {};
    const total = active.reduce((sum, s) => sum + s.tools.length, 0);
    return {
      mcp: `${active.length}/${configured} server(s), ${total} tool(s)`,
    };
  },

  commands: {
    "/mcp": {
      description: "list MCP servers and their tools",
      handler: async () => {
        if (configured === 0) {
          return "```yaml\nmcp: {}\n```";
        }

        const lines = ["```yaml", "mcp:"];
        for (const s of active) {
          lines.push(`  ${s.name}:`);
          lines.push("    status: connected");
          lines.push(`    toolsCount: ${s.tools.length}`);
          if (s.tools.length > 0) {
            const TOOL_CAP = 20;
            const names = s.tools.map((t) => t.name);
            const shown = names.slice(0, TOOL_CAP);
            lines.push(`    tools: [${shown.join(", ")}]`);
            if (names.length > shown.length) {
              lines.push(`    extraTools: ${names.length - shown.length}`);
            }
          }
        }

        for (const f of failed) {
          lines.push(`  ${f.name}:`);
          lines.push("    status: failed");
          lines.push(`    error: "${f.reason.replace(/"/g, '\\"')}"`);
        }

        lines.push("```");
        return lines.join("\n");
      },
    },
  },
};
