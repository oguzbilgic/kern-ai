import type { KernPlugin, PluginContext, RouteHandler, BeforeContextInfo, ContextInjection } from "../types.js";
import { RecallIndex } from "./recall.js";
import { recallTool, setRecallIndex, setContextBounds } from "./tool.js";
import { analyzeRecallHealth, formatRecallHealthReport, listRecallSessions } from "./health.js";
import { analyzeSegmentHealth, formatHealthReport, listSessions } from "../../segment-health.js";
import { log } from "../../log.js";

let recallIndex: RecallIndex | null = null;
let building = false;

export const recallPlugin: KernPlugin = {
  name: "recall",

  get tools() {
    return recallIndex ? { recall: recallTool } : {};
  },

  toolDescriptions: {
    recall: "search long-term memory for old conversations outside current context",
  },

  routes: (() => {
    const routes: RouteHandler[] = [
      {
        method: "GET",
        path: "/recall/stats",
        handler: (_req, res) => {
          if (!recallIndex) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "recall not enabled" }));
            return;
          }
          const stats = recallIndex.getStats();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ...stats, building }));
        },
      },
      {
        method: "GET",
        path: "/recall/search",
        handler: async (req, res) => {
          if (!recallIndex) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "recall not enabled" }));
            return;
          }
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const query = url.searchParams.get("q") || "";
          const limit = parseInt(url.searchParams.get("limit") || "5", 10);
          if (!query) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing ?q= parameter" }));
            return;
          }
          try {
            const results = await recallIndex.search(query, limit);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ query, results }));
          } catch (err: any) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        },
      },
    ];
    return routes;
  })(),

  async onStartup(ctx) {
    if (ctx.config.recall === false) return;

    try {
      recallIndex = new RecallIndex(ctx.db, ctx.agentDir, ctx.config);
      setRecallIndex(recallIndex);

      // Backfill in background
      const sessionId = ctx.sessionId();
      if (sessionId) {
        building = true;
        recallIndex.indexSession(sessionId).then((indexed) => {
          building = false;
          if (indexed > 0) log("recall", `backfilled ${indexed} chunks`);
        }).catch((err) => {
          building = false;
          log.error("recall", `backfill failed: ${err.message}`);
        });
      }
    } catch (err: any) {
      log.error("recall", `init failed: ${err.message} — recall disabled`);
      recallIndex = null;
    }
  },

  async onTurnFinish(sessionId, _ctx) {
    if (!recallIndex) return;
    try {
      await recallIndex.indexSession(sessionId);
    } catch (err: any) {
      log.error("recall", `indexing failed: ${err.message}`);
    }
  },

  async onBeforeContext(info: BeforeContextInfo, ctx: PluginContext): Promise<ContextInjection | null> {
    setContextBounds(info.sessionId, info.trimmedCount);
    if (!recallIndex || info.trimmedCount <= 0 || ctx.config.autoRecall === false) return null;

    try {
      const results = await recallIndex.search(info.userQuery, 3);
      const relevant = results.filter(r => r.distance < 0.95 && r.msg_end < info.trimmedCount);
      if (relevant.length === 0) return null;

      const recallText = relevant
        .map(r => `[${r.timestamp}]\n${r.text}`)
        .join("\n---\n");

      // Budget: ~2000 tokens max
      const estimatedTokens = Math.ceil(recallText.length / 3.3);
      if (estimatedTokens > 2000) return null;

      log.debug("recall", `auto-recall: ${relevant.length} chunks (~${estimatedTokens} tokens)`);

      return {
        label: "recall",
        content: `Relevant context from past conversations:\n${recallText}`,
        placement: "user-prepend",
        sseEvents: [{ type: "recall", recall: { query: info.userQuery, chunks: relevant.length, tokens: estimatedTokens, results: relevant.map(r => ({ timestamp: r.timestamp, text: r.text, distance: r.distance })) } }],
      };
    } catch (err: any) {
      log.error("recall", `auto-recall failed: ${err.message}`);
      return null;
    }
  },

  commands: {
    "/recall-health": {
      description: "show recall embedding health and pipeline stalls",
      handler: async (ctx) => {
        try {
          const sessions = listRecallSessions(ctx.db.db);
          if (sessions.length === 0) {
            return "```text\nNo sessions found in recall.db\n```";
          }
          const activeId = ctx.sessionId();
          const targetSession = (activeId && sessions.some(s => s.session_id === activeId))
            ? activeId
            : sessions[0].session_id;

          const report = analyzeRecallHealth(ctx.db.db, targetSession);
          return "```text\n" + formatRecallHealthReport(report) + "\n```";
        } catch (err: any) {
          return `\`\`\`text\nrecall-health error: ${err.message}\n\`\`\``;
        }
      },
    },
    "/segment-health": {
      description: "show semantic segment health and rollup tiling",
      handler: async (ctx) => {
        try {
          const sessions = listSessions(ctx.db.db);
          if (sessions.length === 0) {
            return "```text\nNo sessions found in recall.db\n```";
          }
          const activeId = ctx.sessionId();
          const targetSession = (activeId && sessions.some(s => s.session_id === activeId))
            ? activeId
            : sessions[0].session_id;

          const maxTokens = ctx.config.maxContextTokens ?? 100_000;
          const ratio = ctx.config.summaryBudget ?? 0.75;
          const budgetTokens = Math.floor(maxTokens * ratio);

          const report = analyzeSegmentHealth(ctx.db.db, targetSession, { budgetTokens });
          return "```text\n" + formatHealthReport(report) + "\n```";
        } catch (err: any) {
          return `\`\`\`text\nsegment-health error: ${err.message}\n\`\`\``;
        }
      },
    },
  },

  onStatus(_ctx) {
    if (!recallIndex) return {};
    const stats = recallIndex.getStats();
    return {
      recall: { ...stats, building },
    };
  },
};

/** Expose recall index for segment snap boundaries and runtime access */
export function getRecallIndex(): RecallIndex | null {
  return recallIndex;
}
