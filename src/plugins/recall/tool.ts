import { tool } from "ai";
import { z } from "zod";
import type { RecallIndex } from "./recall.js";

let _recallIndex: RecallIndex | null = null;
let _contextSessionId: string | null = null;
let _contextTrimmedCount = 0;

export function setRecallIndex(index: RecallIndex | null) {
  _recallIndex = index;
}

export function setContextBounds(sessionId: string, trimmedCount: number) {
  _contextSessionId = sessionId;
  _contextTrimmedCount = trimmedCount;
}

export const recallTool = tool({
  description:
    "Search your long-term memory for old conversations outside your current context window. " +
    "Two modes: (1) Search: provide a query to find relevant past conversations. " +
    "(2) Load: provide sessionId + messageStart + messageEnd to load raw messages around a search hit.",
  inputSchema: z.object({
    query: z
      .string()
      .optional()
      .describe("Search query to find relevant past conversations"),
    limit: z
      .number()
      .optional()
      .describe("Max results to return (default 5)"),
    sessionId: z
      .string()
      .optional()
      .describe("Session ID to load messages from (for load mode)"),
    messageStart: z
      .number()
      .optional()
      .describe("Start message index (for load mode)"),
    messageEnd: z
      .number()
      .optional()
      .describe("End message index (for load mode)"),
    before: z
      .string()
      .optional()
      .describe("Only return results before this date (ISO 8601 or YYYY-MM-DD)"),
    after: z
      .string()
      .optional()
      .describe("Only return results after this date (ISO 8601 or YYYY-MM-DD)"),
  }),
  execute: async (args) => {
    if (!_recallIndex) {
      return "Recall is not available.";
    }

    try {
      // Load mode
      if (args.sessionId && args.messageStart !== undefined && args.messageEnd !== undefined) {
        return await _recallIndex.loadMessages(args.sessionId, args.messageStart, args.messageEnd);
      }

      // Search mode
      if (args.query) {
        let results = await _recallIndex.search(args.query, (args.limit || 5) * 3); // fetch extra for filtering
        
        // Apply date filters. `recall.db` stores UTC-normalized timestamps, so
        // lexicographic string comparison is correct.
        if (args.after) {
          const after = new Date(args.after).toISOString();
          results = results.filter((r) => r.timestamp >= after);
        }
        if (args.before) {
          const before = new Date(args.before).toISOString();
          results = results.filter((r) => r.timestamp <= before);
        }

        // Filter out chunks already in context window
        if (_contextSessionId && _contextTrimmedCount > 0) {
          results = results.filter(r =>
            !(r.session_id === _contextSessionId && r.msg_end >= _contextTrimmedCount)
          );
        }
        
        results = results.slice(0, args.limit || 5);
        if (results.length === 0) {
          return "No relevant past conversations found.";
        }

        return results
          .map((r, i) => {
            return [
              `--- Result ${i + 1} (distance: ${r.distance.toFixed(3)}) ---`,
              `Session: ${r.session_id}`,
              `Messages: ${r.msg_start}-${r.msg_end}`,
              `Time: ${r.timestamp}`,
              ``,
              r.text,
            ].join("\n");
          })
          .join("\n\n");
      }

      return "Provide either a 'query' for search or 'sessionId'+'messageStart'+'messageEnd' to load messages.";
    } catch (err: any) {
      return `Recall error: ${err.message}`;
    }
  },
});
