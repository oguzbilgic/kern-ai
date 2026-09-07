import { tool } from "ai";
import { z } from "zod";
import { readFile } from "fs/promises";
import { join, basename } from "path";
import { existsSync } from "fs";
import type { SessionStats } from "../context.js";

// These get set by the runtime at init
let _agentDir = "";
let _startedAt = Date.now();
let _messageCount = 0;
let _config: any = {};
let _sessionId = "";
let _version = "unknown";
let _totalPromptTokens = 0;
let _totalCompletionTokens = 0;
let _totalCacheReadTokens = 0;
let _totalCacheWriteTokens = 0;
let _usageFile = "";
let _getSessionStats: (() => SessionStats) | null = null;
let _reloadFn: (() => Promise<void>) | null = null;
let _pairingManager: any = null;
let _getQueueStatus: (() => { processing: boolean; pending: number; activeChannel: string | null }) | null = null;
let _getInterfaceStatuses: (() => InterfaceStatus[]) | null = null;
let _getSegmentStats: (() => { segments: number; level0: number; levels: Record<number, number> } | null) | null = null;

export function setQueueStatusFn(fn: () => { processing: boolean; pending: number; activeChannel: string | null }) {
  _getQueueStatus = fn;
}

export function setInterfaceStatusFn(fn: () => InterfaceStatus[]) {
  _getInterfaceStatuses = fn;
}

export function setSegmentStatsFn(fn: () => { segments: number; level0: number; levels: Record<number, number> } | null) {
  _getSegmentStats = fn;
}

let _getPluginStatus: (() => Record<string, any>) | null = null;
export function setPluginStatusFn(fn: () => Record<string, any>) {
  _getPluginStatus = fn;
}

export async function initKernTool(opts: {
  agentDir: string;
  config: any;
  sessionId: string;
  getSessionStats?: () => SessionStats;
  reload?: () => Promise<void>;
  pairingManager?: any;
}) {
  _agentDir = opts.agentDir;
  _config = opts.config;
  _sessionId = opts.sessionId;
  _startedAt = Date.now();
  _messageCount = 0;
  _getSessionStats = opts.getSessionStats || null;
  _reloadFn = opts.reload || null;
  _pairingManager = opts.pairingManager || null;
  _usageFile = join(_agentDir, ".kern", "usage.json");
  // Load persisted usage
  try {
    const usage = JSON.parse(await readFile(_usageFile, "utf-8"));
    _totalPromptTokens = usage.promptTokens || 0;
    _totalCompletionTokens = usage.completionTokens || 0;
    _totalCacheReadTokens = usage.cacheReadTokens || 0;
    _totalCacheWriteTokens = usage.cacheWriteTokens || 0;
  } catch {
    _totalPromptTokens = 0;
    _totalCompletionTokens = 0;
    _totalCacheReadTokens = 0;
    _totalCacheWriteTokens = 0;
  }
  try {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"));
    _version = pkg.version || "unknown";
  } catch {
    _version = "unknown";
  }
}

export function incrementMessageCount() {
  _messageCount++;
}

export async function addTokenUsage(promptTokens: number, completionTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number) {
  _totalPromptTokens += promptTokens;
  _totalCompletionTokens += completionTokens;
  _totalCacheReadTokens += cacheReadTokens || 0;
  _totalCacheWriteTokens += cacheWriteTokens || 0;
  // Persist
  try {
    const { writeFile } = await import("fs/promises");
    await writeFile(_usageFile, JSON.stringify({
      promptTokens: _totalPromptTokens,
      completionTokens: _totalCompletionTokens,
      cacheReadTokens: _totalCacheReadTokens,
      cacheWriteTokens: _totalCacheWriteTokens,
      updatedAt: new Date().toISOString(),
    }, null, 2) + "\n");
  } catch {}
}

export interface InterfaceStatus {
  name: string;
  status: "connected" | "disconnected" | "error";
  detail?: string;
}

export interface ContextBreakdown {
  maxTokens: number;
  systemPromptTokens: number;
  messageTokens: number;
  summaryTokens: number;
  messageCount: number;
  totalMessages: number;
  trimmedCount: number;
  truncatedCount: number;
  summaryLevelCounts: Record<number, number>;
}

export interface StatusData {
  version: string;
  name: string;
  agent: string;
  model: string;
  provider: string;
  toolScope: string;
  uptime: string;
  session: string;
  context: string | null;
  contextBreakdown: ContextBreakdown | null;
  summary: string | null;
  apiUsage: string;
  cacheUsage: string | null;
  promptTokens: number;
  completionTokens: number;
  queue: string;
  telegram: string | null;
  slack: string | null;
  matrix: string | null;
  nostr: string | null;
  segments: string | null;
  plugins: Record<string, any> | null;
}

export function getStatusData(): StatusData {
  const uptime = Math.floor((Date.now() - _startedAt) / 1000);
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  const secs = uptime % 60;
  const uptimeStr =
    hours > 0
      ? `${hours}h ${mins}m ${secs}s`
      : mins > 0
        ? `${mins}m ${secs}s`
        : `${secs}s`;

  const stats = _getSessionStats ? _getSessionStats() : null;
  const session = stats
    ? `${stats.totalMessages} messages (~${Math.round(stats.estimatedTokens / 1000)}k tokens)`
    : `${_messageCount} messages`;
  const trimmed = stats ? stats.totalMessages - stats.windowMessages + (stats.summaryTokens > 0 ? 1 : 0) : 0;
  const context = stats
    ? `~${Math.round(stats.windowTokens / 1000)}k / ${Math.round(_config.maxContextTokens / 1000)}k tokens (${stats.windowMessages} messages${trimmed > 0 ? `, ${trimmed} trimmed` : ""}${stats.truncatedCount > 0 ? `, ${stats.truncatedCount} truncated` : ""})`
    : null;
  const summary = stats && stats.summaryTokens > 0
    ? (() => {
        const lvlStr = Object.entries(stats.summaryLevelCounts)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([l, n]) => `${n}×L${l}`)
          .join(", ");
        return `~${Math.round(stats.summaryTokens / 1000)}k tokens (${lvlStr})`;
      })()
    : null;
  const totalTokens = _totalPromptTokens + _totalCompletionTokens;
  const apiUsage = `${totalTokens} tokens (in: ${_totalPromptTokens}, out: ${_totalCompletionTokens})`;
  const cacheUsage = _totalCacheReadTokens > 0 || _totalCacheWriteTokens > 0
    ? `${_totalCacheReadTokens} read, ${_totalCacheWriteTokens} written`
    : null;

  const qs = _getQueueStatus ? _getQueueStatus() : null;
  const queueStr = qs
    ? qs.processing ? `busy (${qs.pending} pending)` : `idle (${qs.pending} pending)`
    : "unknown";

  const ifaces = _getInterfaceStatuses ? _getInterfaceStatuses() : [];
  const ifaceStr = (name: string) => {
    const i = ifaces.find(x => x.name === name);
    return i ? (i.detail ? `${i.status} (${i.detail})` : i.status) : null;
  };

  // Numeric context breakdown for UI
  const contextBreakdown = stats ? {
    maxTokens: _config.maxContextTokens,
    systemPromptTokens: stats.systemPromptTokens || 0,
    messageTokens: stats.windowTokens,
    summaryTokens: stats.summaryTokens,
    messageCount: stats.windowMessages,
    totalMessages: stats.totalMessages,
    trimmedCount: trimmed,
    truncatedCount: stats.truncatedCount,
    summaryLevelCounts: stats.summaryLevelCounts,
  } : null;

  return {
    version: _version,
    name: _config.name || basename(_agentDir),
    agent: _agentDir,
    model: _config.model,
    provider: _config.provider,
    toolScope: _config.toolScope,
    uptime: uptimeStr,
    session,
    context,
    contextBreakdown,
    summary,
    apiUsage,
    cacheUsage,
    promptTokens: _totalPromptTokens,
    completionTokens: _totalCompletionTokens,
    queue: queueStr,
    telegram: ifaceStr("telegram"),
    slack: ifaceStr("slack"),
    matrix: ifaceStr("matrix"),
    nostr: ifaceStr("nostr"),
    segments: _getSegmentStats ? (() => {
      const ss = _getSegmentStats!();
      if (!ss) return "disabled";
      const lvlStr = Object.entries(ss.levels)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([l, n]) => `${n} L${l}`)
        .join(", ");
      return lvlStr || "0 segments";
    })() : null,
    plugins: _getPluginStatus ? _getPluginStatus() : null,
  };
}

export function formatStatus(data: StatusData): string {
  return [
    `kern: ${data.version}`,
    `agent: ${data.agent}`,
    `model: ${data.provider}/${data.model}`,
    `toolScope: ${data.toolScope}`,
    data.telegram ? `telegram: ${data.telegram}` : "",
    data.slack ? `slack: ${data.slack}` : "",
    data.matrix ? `matrix: ${data.matrix}` : "",
    data.nostr ? `nostr: ${data.nostr}` : "",
    `session: ${data.session}`,
    data.contextBreakdown ? (() => {
      const cb = data.contextBreakdown!;
      const total = cb.systemPromptTokens + cb.messageTokens + cb.summaryTokens;
      return `context: ~${Math.round(total / 1000)}k tokens`;
    })() : (data.context ? `context: ${data.context}` : ""),
    data.contextBreakdown ? `  system: ~${Math.round(data.contextBreakdown.systemPromptTokens / 1000)}k tokens` : "",
    data.contextBreakdown ? `  messages: ~${Math.round(data.contextBreakdown.messageTokens / 1000)}k tokens (${data.contextBreakdown.messageCount} messages, ${data.contextBreakdown.trimmedCount} trimmed)` : "",
    data.contextBreakdown && data.contextBreakdown.summaryTokens > 0 ? (() => {
      const lvlStr = Object.entries(data.contextBreakdown!.summaryLevelCounts)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([l, n]) => `${n}×L${l}`)
        .join(", ");
      return `  summary: ~${Math.round(data.contextBreakdown!.summaryTokens / 1000)}k tokens (${lvlStr})`;
    })() : (data.summary ? `  summary: ${data.summary}` : ""),

    data.segments ? `segments: ${data.segments}` : "",
    ...(data.plugins ? Object.entries(data.plugins).map(([k, v]) => `${k}: ${v}`) : []),
    `api usage: ${data.apiUsage}`,
    data.cacheUsage ? `cache: ${data.cacheUsage}` : "",
    `queue: ${data.queue}`,
    `uptime: ${data.uptime}`,
  ].filter(Boolean).join("\n");
}

export function getStatus(): string {
  return formatStatus(getStatusData());
}

export const kernTool = tool({
  description:
    "Manage your own kern runtime. Check status, view config, or pair users.",
  inputSchema: z.object({
    action: z
      .enum(["status", "config", "env", "pair", "users", "logs"])
      .describe(
        "status: runtime info. config: show config. env: show env var names. pair: approve a pairing code (provide code param). users: list paired users. logs: show recent logs (optionally filter by level).",
      ),
    code: z
      .string()
      .optional()
      .describe("Pairing code to approve (for pair action). Format: KERN-XXXX"),
    level: z
      .enum(["debug", "info", "warn", "error"])
      .optional()
      .describe("Filter logs by minimum level (for logs action). Default: warn."),
    lines: z
      .number()
      .optional()
      .describe("Number of log lines to return (for logs action). Default: 50."),
  }),
  execute: async ({ action, code, level, lines }) => {
    switch (action) {
      case "status":
        return getStatus();

      case "config": {
        try {
          const configPath = join(_agentDir, ".kern", "config.json");
          return await readFile(configPath, "utf-8");
        } catch {
          return "Error: could not read .kern/config.json";
        }
      }

      case "env": {
        try {
          const envPath = join(_agentDir, ".kern", ".env");
          const content = await readFile(envPath, "utf-8");
          // Show variable names only, mask values
          const lines = content
            .split("\n")
            .filter((l) => l.trim() && !l.startsWith("#"))
            .map((l) => {
              const eq = l.indexOf("=");
              if (eq === -1) return l;
              const key = l.slice(0, eq);
              return `${key}=****`;
            });
          return lines.join("\n") || "No env vars set.";
        } catch {
          return "Error: could not read .kern/.env";
        }
      }

      case "pair": {
        if (!_pairingManager) return "Pairing not available.";
        if (!code) return "Provide a pairing code. Usage: kern({ action: 'pair', code: 'KERN-XXXX' })";
        const result = await _pairingManager.pair(code);
        if (!result) return `Invalid or expired pairing code: ${code}`;
        return `Paired! User ${result.userId} from ${result.interface} is now approved.\n\nYou should now update USERS.md with their identity, role, and any access notes your operator provided.`;
      }

      case "users": {
        if (!_pairingManager) return "Pairing not available.";
        const paired = _pairingManager.getPairedUsers();
        const pending = _pairingManager.getPendingCodes();
        const lines: string[] = [];
        if (paired.length > 0) {
          lines.push("Paired users:");
          for (const u of paired) {
            lines.push(`  ${u.userId} (${u.interface}, paired ${u.pairedAt})`);
          }
        } else {
          lines.push("No paired users.");
        }
        if (pending.length > 0) {
          lines.push("\nPending codes:");
          for (const p of pending) {
            lines.push(`  ${p.code} → ${p.userId} (${p.interface})`);
          }
        }
        return lines.join("\n");
      }

      case "logs": {
        const logFile = join(_agentDir, ".kern", "logs", "kern.log");
        if (!existsSync(logFile)) return "No logs yet.";
        try {
          const content = await readFile(logFile, "utf-8");
          let allLines = content.trimEnd().split("\n");

          // Filter by level
          const minLevel = level || "warn";
          const LEVEL_FILTERS: Record<string, string[]> = {
            debug: [],
            info: [],
            warn: ["WRN", "ERR"],
            error: ["ERR"],
          };
          const filterLabels = LEVEL_FILTERS[minLevel];
          if (filterLabels && filterLabels.length > 0) {
            allLines = allLines.filter(l => filterLabels.some(label => l.includes(label)));
          }

          const count = lines || 50;
          const output = allLines.slice(-count);
          if (output.length === 0) return `No ${minLevel}+ logs found.`;
          return output.join("\n");
        } catch {
          return "Error reading logs.";
        }
      }

      default:
        return `Unknown action: ${action}`;
    }
  },
});
