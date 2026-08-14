import { join } from "path";
import { embed, embedMany } from "ai";
import { readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { log } from "../../log.js";
import { extractText } from "../../util.js";
import { createEmbeddingModel } from "../../model.js";
import type { ModelMessage } from "ai";
import type { MemoryDB } from "../../memory.js";
import type { KernConfig } from "../../config.js";

const MAX_CHUNK_TOKENS = 1000; // rough token limit per chunk

// Max characters sent to the embedding model per chunk. Embedding APIs reject
// inputs over their token limit (8192 for text-embedding-3-small and
// nomic-embed-text) with HTTP 400 — and one oversized chunk fails the whole
// embedMany batch, permanently: the indexer retries the same chunks forever,
// so every chunk batched with it stays unindexed too. chunkMessages() caps
// chunk *growth*, but a single oversized message bypasses the cap, and the
// chars/4 token estimate undercounts dense text. 16k chars stays safely under
// 8192 tokens even at ~2 chars/token. Only the embedded representation is
// truncated — the full chunk text is still stored and returned by search.
const EMBED_MAX_CHARS = 16000;

/** Truncate text for embedding without splitting a surrogate pair at the cut. */
export function capForEmbedding(text: string, max: number = EMBED_MAX_CHARS): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  // A cut mid-emoji leaves a lone high surrogate — ill-formed UTF-16
  // serializes to invalid JSON, which providers reject.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

// Normalize an ISO8601 string (UTC `Z` or `±HH:MM` offset) to canonical UTC
// `Z` form for storage. Ensures `recall.db` timestamp column is UTC-normalized
// regardless of the envelope format the model saw.
function toUTC(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

interface RecallResult {
  text: string;
  timestamp: string;
  session_id: string;
  msg_start: number;
  msg_end: number;
  distance: number;
}

export class RecallIndex {
  private db: MemoryDB["db"];
  private embeddingModel: Parameters<typeof embed>[0]["model"];
  private agentDir: string;

  constructor(memoryDB: MemoryDB, agentDir: string, config: KernConfig) {
    this.agentDir = agentDir;
    this.db = memoryDB.db;

    const model = createEmbeddingModel(config);
    if (!model) {
      throw new Error("No embedding model available (need OPENROUTER_API_KEY, OPENAI_API_KEY, or Ollama provider)");
    }
    this.embeddingModel = model;
  }

  /**
   * Index new messages from a session's JSONL file.
   * Only reads and parses new lines since last indexed position.
   */
  async indexSession(sessionId: string): Promise<number> {
    const jsonlPath = join(this.agentDir, ".kern", "sessions", `${sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) return 0;

    const content = await readFile(jsonlPath, "utf-8");
    let lines = content.trim().split("\n").filter(Boolean);
    // The runtime may be appending while we read — a torn trailing line is
    // possible. Exclude it; it gets indexed once complete.
    if (lines.length > 1) {
      try {
        JSON.parse(lines[lines.length - 1]);
      } catch {
        lines = lines.slice(0, -1);
      }
    }
    if (lines.length <= 1) return 0; // only metadata line

    const totalMessages = lines.length - 1; // exclude metadata line

    // Get last indexed position
    const state = this.db.prepare("SELECT last_indexed_msg FROM index_state WHERE session_id = ?").get(sessionId) as { last_indexed_msg: number } | undefined;
    const lastIndexed = state?.last_indexed_msg ?? 0;

    if (lastIndexed >= totalMessages) return 0;

    // Parse only new lines (from lastIndexed onward)
    const newLines = lines.slice(1 + lastIndexed);
    const newMessages: ModelMessage[] = newLines.map((l) => JSON.parse(l));

    // Parse session metadata for timestamp interpolation
    const meta = JSON.parse(lines[0]);
    const sessionCreated = new Date(meta.createdAt).getTime();
    // Sessions are append-only: the header's updatedAt is only written at
    // creation. File mtime reflects the latest append, so use that.
    const sessionUpdated = Math.max(sessionCreated, (await stat(jsonlPath)).mtimeMs);

    // Store raw messages in sqlite
    const insertMsg = this.db.prepare(
      "INSERT OR IGNORE INTO messages (session_id, msg_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
    );
    const msgTx = this.db.transaction(() => {
      for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        const msgIndex = lastIndexed + i;
        const msgContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

        // Extract timestamp from message metadata. Envelopes may be UTC (`...Z`,
        // legacy) or offset (`...±HH:MM`, v0.32+). Normalize to UTC for storage.
        let timestamp: string | null = null;
        const textForTimestamp = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        const timeMatch = textForTimestamp.match(/time: (\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/);
        if (timeMatch) timestamp = toUTC(timeMatch[1]);

        insertMsg.run(sessionId, msgIndex, msg.role, msgContent, timestamp);
      }
    });
    msgTx();

    // Chunk new messages into turns
    // We need context: if lastIndexed lands mid-turn (after a user msg, before next user msg),
    // we need to find the right start point. Load a few messages before to find turn boundary.
    const chunkStartOffset = lastIndexed;
    const chunks = this.chunkMessages(newMessages, chunkStartOffset, totalMessages, sessionId, sessionCreated, sessionUpdated);
    if (chunks.length === 0) {
      // Still update state — messages were stored even if no complete turns yet
      this.db.prepare("INSERT OR REPLACE INTO index_state (session_id, last_indexed_msg) VALUES (?, ?)").run(sessionId, totalMessages);
      return 0;
    }

    // Embed chunks in batches (API limits)
    const BATCH_SIZE = 100;
    const texts = chunks.map((c) => capForEmbedding(c.text));
    log.debug("recall", `embedding ${texts.length} chunks (${texts.reduce((a, t) => a + t.length, 0)} chars)`);

    const embeddings: number[][] = [];
    try {
      for (let b = 0; b < texts.length; b += BATCH_SIZE) {
        const batch = texts.slice(b, b + BATCH_SIZE);
        const result = await embedMany({ model: this.embeddingModel, values: batch });
        embeddings.push(...result.embeddings);
        if (texts.length > BATCH_SIZE) {
          log.debug("recall", `embedded batch ${Math.floor(b / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)}`);
        }
      }
    } catch (err: any) {
      log.error("recall", `embedding failed: ${err.message}`);
      return 0;
    }

    // Insert chunks + embeddings
    const insertChunk = this.db.prepare(
      "INSERT OR IGNORE INTO chunks (session_id, msg_start, msg_end, text, timestamp, token_count) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insertVec = this.db.prepare(
      "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)"
    );
    const upsertState = this.db.prepare(
      "INSERT OR REPLACE INTO index_state (session_id, last_indexed_msg) VALUES (?, ?)"
    );

    let indexed = 0;
    const tx = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const info = insertChunk.run(
          chunk.session_id,
          chunk.msg_start,
          chunk.msg_end,
          chunk.text,
          chunk.timestamp,
          chunk.token_count
        );
        if (info.changes === 0) continue; // duplicate chunk, skip vec insert
        const chunkId = typeof info.lastInsertRowid === "bigint" ? info.lastInsertRowid : BigInt(info.lastInsertRowid);
        insertVec.run(chunkId, new Float32Array(embeddings[i]));
        indexed++;
      }
      upsertState.run(sessionId, totalMessages);
    });
    tx();

    log("recall", `indexed ${indexed} chunks for session ${sessionId.slice(0, 8)}...`);
    return indexed;
  }

  /**
   * Search for relevant chunks by query.
   */
  async search(query: string, limit: number = 5): Promise<RecallResult[]> {
    const { embedding } = await embed({ model: this.embeddingModel, value: query });

    const rows = this.db.prepare(`
      SELECT
        v.rowid,
        v.distance,
        c.text,
        c.timestamp,
        c.session_id,
        c.msg_start,
        c.msg_end
      FROM vec_chunks v
      JOIN chunks c ON c.id = v.rowid
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(new Float32Array(embedding), limit) as Array<{
      rowid: number;
      distance: number;
      text: string;
      timestamp: string;
      session_id: string;
      msg_start: number;
      msg_end: number;
    }>;

    return rows.map((r) => ({
      text: r.text,
      timestamp: r.timestamp,
      session_id: r.session_id,
      msg_start: r.msg_start,
      msg_end: r.msg_end,
      distance: r.distance,
    }));
  }

  /**
   * Load raw messages from sqlite by session and index range.
   * Falls back to JSONL if messages aren't in sqlite yet.
   */
  async loadMessages(sessionId: string, start: number, end: number): Promise<string> {
    const from = Math.max(0, start);
    const to = end;

    // Try sqlite first
    const rows = this.db.prepare(
      "SELECT msg_index, role, content FROM messages WHERE session_id = ? AND msg_index >= ? AND msg_index < ? ORDER BY msg_index"
    ).all(sessionId, from, to) as Array<{ msg_index: number; role: string; content: string }>;

    if (rows.length > 0) {
      return rows.map((r) => {
        const preview = r.content.length > 500 ? r.content.slice(0, 500) + "..." : r.content;
        return `[${r.msg_index}] ${r.role}: ${preview}`;
      }).join("\n\n");
    }

    // Fallback to JSONL for messages not yet in sqlite
    const jsonlPath = join(this.agentDir, ".kern", "sessions", `${sessionId}.jsonl`);
    if (!existsSync(jsonlPath)) return "Session not found.";

    const content = await readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const totalMessages = lines.length - 1;

    const actualTo = Math.min(totalMessages, to);
    const result: string[] = [];
    for (let i = from; i < actualTo; i++) {
      const msg: ModelMessage = JSON.parse(lines[i + 1]); // +1 for metadata line
      const msgContent = extractText(msg.content);
      const preview = msgContent.length > 500 ? msgContent.slice(0, 500) + "..." : msgContent;
      result.push(`[${i}] ${msg.role}: ${preview}`);
    }

    return result.length > 0 ? result.join("\n\n") : "No messages found in range.";
  }

  /**
   * Chunk messages into turns.
   * Messages are passed starting from an offset — msg_start/msg_end use absolute indices.
   */
  private chunkMessages(
    messages: ModelMessage[],
    absoluteOffset: number,
    totalMessages: number,
    sessionId: string,
    sessionCreated: number,
    sessionUpdated: number
  ): Array<{ session_id: string; msg_start: number; msg_end: number; text: string; timestamp: string; token_count: number }> {
    const chunks: Array<{ session_id: string; msg_start: number; msg_end: number; text: string; timestamp: string; token_count: number }> = [];

    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];

      // Start a turn at a user message
      if (msg.role !== "user") {
        i++;
        continue;
      }

      const turnStart = i;
      const parts: string[] = [];
      let tokenCount = 0;

      // Collect user message
      const userText = this.messageToText(msg);
      parts.push(`User: ${userText}`);
      tokenCount += Math.ceil(userText.length / 4);
      i++;

      // Collect assistant + tool messages until next user message or end
      while (i < messages.length && messages[i].role !== "user") {
        const m = messages[i];
        const text = this.messageToText(m);
        const textTokens = Math.ceil(text.length / 4);

        // Don't let chunks get too big
        if (tokenCount + textTokens > MAX_CHUNK_TOKENS * 2 && parts.length > 1) {
          break;
        }

        if (m.role === "assistant") {
          parts.push(`Assistant: ${text}`);
        } else if (m.role === "tool") {
          // Truncate tool results
          const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
          parts.push(`Tool: ${truncated}`);
        }
        tokenCount += textTokens;
        i++;
      }

      const turnEnd = i;
      const chunkText = parts.join("\n");

      // Absolute indices
      const absTurnStart = absoluteOffset + turnStart;
      const absTurnEnd = absoluteOffset + turnEnd;

      // Extract timestamp from message metadata (normalize to UTC for storage).
      let timestamp = "";
      for (let j = turnStart; j < turnEnd && !timestamp; j++) {
        const content = typeof messages[j].content === "string" ? messages[j].content as string : "";
        const timeMatch = content.match(/time: (\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))/);
        if (timeMatch) timestamp = toUTC(timeMatch[1]) || "";
      }
      // Fallback: interpolate from position in session
      if (!timestamp) {
        const progress = totalMessages > 1 ? absTurnStart / (totalMessages - 1) : 0;
        const estimated = sessionCreated + progress * (sessionUpdated - sessionCreated);
        timestamp = new Date(estimated).toISOString();
      }

      chunks.push({
        session_id: sessionId,
        msg_start: absTurnStart,
        msg_end: absTurnEnd,
        text: chunkText,
        timestamp,
        token_count: Math.ceil(chunkText.length / 4),
      });
    }

    return chunks;
  }

  private messageToText(msg: ModelMessage): string {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return (msg.content as any[]).map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "image") return `[image: ${part.mediaType || "image"}]`;
        if (part.type === "file") return `[file: ${part.filename || part.mediaType || "file"}]`;
        if (part.type === "tool-call") return `[tool: ${part.toolName}]`;
        if (part.type === "tool-result") {
          const out = typeof part.output === "string" ? part.output : JSON.stringify(part.output);
          return out.length > 200 ? out.slice(0, 200) + "..." : out;
        }
        return JSON.stringify(part);
      }).join(" ");
    }
    return JSON.stringify(msg.content);
  }

  getStats(): { chunks: number; sessions: number; messages: number; firstTimestamp: string | null; lastTimestamp: string | null } {
    const chunks = (this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as any).count;
    const sessions = (this.db.prepare("SELECT COUNT(*) as count FROM index_state").get() as any).count;
    const messages = (this.db.prepare("SELECT COUNT(*) as count FROM messages").get() as any).count;
    const first = (this.db.prepare("SELECT MIN(timestamp) as ts FROM messages WHERE timestamp IS NOT NULL").get() as any)?.ts || null;
    const last = (this.db.prepare("SELECT MAX(timestamp) as ts FROM messages WHERE timestamp IS NOT NULL").get() as any)?.ts || null;
    return { chunks, sessions, messages, firstTimestamp: first, lastTimestamp: last };
  }

}
