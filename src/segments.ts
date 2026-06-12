import { embed, embedMany, generateText } from "ai";
import { log } from "./log.js";
import { extractText } from "./util.js";
import { createEmbeddingModel, createSummaryModel } from "./model.js";
import type { KernConfig } from "./config.js";
import type { MemoryDB } from "./memory.js";
import type Database from "better-sqlite3";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Segmentation parameters
const TOPIC_THRESHOLD = 0.80;   // cosine distance — hard cut at topic shift
const TARGET_TOKENS = 15000;    // soft target per segment (~10-20k range)
const MIN_TOKENS = 5000;        // floor — don't create small fragments
const MERGE_THRESHOLD = 0.7;    // merge small segments if closer than this
const WINDOW_SIZE = 5;          // embed windows of N messages for smoother distances

// Batch size for embedding API calls
const MIN_MESSAGES = 10;        // minimum messages per segment — merge if fewer
const MIN_TAIL_MESSAGES = 10;  // minimum unsegmented messages before creating new segments
const MIN_TAIL_TOKENS = 10000; // minimum unsegmented tokens before creating new segments
const EMBED_BATCH_SIZE = 100;

// Max messages to process per indexSession call (prevents OOM on large backfills)
const MAX_CHUNK_SIZE = 500;

function readPromptFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8").trim();
  } catch {
    return null;
  }
}

function buildSummarizerContext(): string {
  const cwd = process.cwd();
  const identity = readPromptFile(join(cwd, "IDENTITY.md"));
  const users = readPromptFile(join(cwd, "USERS.md"));

  const parts = [
    "Agent context:",
    identity ? `\n<identity>\n${identity}\n</identity>` : "",
    users ? `\n<users>\n${users}\n</users>` : "",
    `\nIdentity preservation rules:\n- Preserve speaker distinctions when relevant. Do not flatten every inbound human into \"the user\".\n- Distinguish operator, system messages, and other people in channels/DMs.\n- Prefer names or roles when known (for example: operator, David on Slack, a participant in #di-agent-chat).\n- Do not include opaque platform user IDs unless they are the only identifier available and truly necessary.\n- Keep channel/interface context only when it matters to what happened.`,
  ].filter(Boolean);

  return parts.join("\n").trim();
}

const SUMMARIZER_CONTEXT = buildSummarizerContext();

function segmentSummaryPrompt(inputText: string, targetTokens: number): string {
  return `You are writing compact internal memory notes for your future self.

Task:
- Summarize only what happened in this conversation segment.
- Focus on: requests, actions taken, decisions made, concrete outcomes, and unresolved follow-ups.
- Keep this tightly scoped to the segment. Do not turn it into a multi-day or project-wide recap.

Style:
- Write concise bullet points.
- Prefer dense factual notes over polished narrative prose.
- Keep a light sense of narrative when useful: preserve why something happened, not just what happened.
- Prefer bullets that connect request or intent -> action -> outcome when that context matters.
- No section headers.
- No boilerplate like "Participants and Roles", "What I Did", "Results", "Open Items", or "Additional Notes".
- Do not explain the environment unless it directly affected what happened in this segment.
- Keep the specific details that give the event its identity.
- Avoid turning identifiable events into generic summaries.
- Remove repetition first; keep the details that will help future me recognize what this was.
- Omit low-value detail and repeated chatter.

Perspective and identity:
- Use first person when describing my actions or decisions.
- Preserve who said or wanted what when relevant.
- Do not collapse distinct humans/agents/channels into a generic "user".
- Prefer names or roles over raw IDs.

Compression:
- Favor 4-10 bullets unless the segment truly contains only one topic.
- Keep only details that would matter for future recall or rollups.
- IMPORTANT: Keep your response under ${targetTokens} tokens.

${SUMMARIZER_CONTEXT}

<conversation_segment>
${inputText}
</conversation_segment>`;
}

function rollupSummaryPrompt(inputText: string, targetTokens: number, childCount: number): string {
  return `You are writing compact internal memory notes for your future self.

Task:
- The input is ${childCount} sequential lower-level conversation summaries.
- Produce a higher-level rollup of the main themes, decisions, outcomes, and unresolved follow-ups across them.
- Stay faithful to the children. Do not introduce broad project recap or background that is not clearly supported.

Style:
- Write concise bullet points.
- No section headers.
- No boilerplate or executive-summary framing.
- Prefer dense factual notes that compress well for future rollups.
- Preserve important causal links: why a change happened, what I did, and what came out of it.
- Keep the specific details that make an event recognizable later; compress prose before compressing identity.

Perspective and identity:
- Use first person when describing my actions or decisions.
- Preserve important distinctions between operator, other humans, agents, and channels when they matter.
- Prefer names or roles over raw IDs.

Compression:
- Keep only details that matter at the higher level.
- Merge repetition.
- IMPORTANT: Keep your response under ${targetTokens} tokens.

${SUMMARIZER_CONTEXT}

<conversation_summaries>
${inputText}
</conversation_summaries>`;
}

interface MessageRow {
  id: number;
  msg_index: number;
  role: string;
  content: string;
  timestamp: string | null;
}

interface Segment {
  session_id: string;
  msg_start: number;
  msg_end: number;
  start_time: string | null;
  end_time: string | null;
  text: string;
  token_count: number;
  embedding: number[];
}

export class SegmentIndex {
  private db: Database.Database;
  private embeddingModel: Parameters<typeof embed>[0]["model"];
  private summaryModel: Parameters<typeof generateText>[0]["model"];
  // For Ollama: disable thinking on summary calls. Thinking models otherwise
  // burn the entire maxOutputTokens budget on reasoning, leaving zero tokens
  // for the actual summary. LM Studio / llama.cpp / vLLM silently ignore
  // this flag — users on those backends should set `summaryModel` to a
  // non-thinking model instead.
  private summaryProviderOptions: Parameters<typeof generateText>[0]["providerOptions"] | undefined;
  private abortController: AbortController | null = null;

  constructor(memoryDB: MemoryDB, config: KernConfig) {
    this.db = memoryDB.db;

    const embModel = createEmbeddingModel(config);
    if (!embModel) {
      throw new Error("No embedding model available (need OPENROUTER_API_KEY, OPENAI_API_KEY, or Ollama provider)");
    }
    this.embeddingModel = embModel;

    const sumModel = createSummaryModel(config);
    if (!sumModel) {
      throw new Error("No summary model available");
    }
    this.summaryModel = sumModel;

    this.summaryProviderOptions =
      config.provider === "ollama" ? { openai: { think: false } } : undefined;
  }

  /**
   * Build semantic segments for new messages in a session.
   * Reads from the messages table, computes embeddings, detects topic boundaries.
   * Returns the number of new segments created.
   */
  async indexSession(sessionId: string): Promise<number> {
    // Get last segmented position
    const state = this.db.prepare(
      "SELECT last_segmented_msg FROM segment_state WHERE session_id = ?"
    ).get(sessionId) as { last_segmented_msg: number } | undefined;
    const lastSegmented = state?.last_segmented_msg ?? 0;

    // Load new messages from the messages table — chunked to prevent OOM
    const allMessages = this.db.prepare(
      "SELECT id, msg_index, role, content, timestamp FROM messages WHERE session_id = ? AND msg_index >= ? ORDER BY msg_index"
    ).all(sessionId, lastSegmented) as MessageRow[];

    if (allMessages.length < 3) return 0;
    // For incremental indexing, wait for enough content to detect topic boundaries
    if (lastSegmented > 0) {
      if (allMessages.length < MIN_TAIL_MESSAGES) return 0;
      const tailTokens = allMessages.reduce((sum, m) => sum + Math.ceil(extractText(m.content).length / 4), 0);
      if (tailTokens < MIN_TAIL_TOKENS) return 0;
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    let totalCreated = 0;

    // Process in chunks
    for (let chunkStart = 0; chunkStart < allMessages.length; chunkStart += MAX_CHUNK_SIZE) {
      if (signal.aborted) {
        log("segments", "aborted");
        break;
      }
      const messages = allMessages.slice(chunkStart, chunkStart + MAX_CHUNK_SIZE);
      if (messages.length < 3) break;

      log.debug("segments", `processing chunk ${Math.floor(chunkStart / MAX_CHUNK_SIZE) + 1}/${Math.ceil(allMessages.length / MAX_CHUNK_SIZE)} (${messages.length} messages)`);

      // Build windowed text for embedding — smooths out per-message noise
      const windowTexts = this.buildWindowTexts(messages);

      // Embed windows
      const embeddings = await this.embedTexts(windowTexts);
      if (embeddings.length !== messages.length) {
        log.warn("segments", `embedding count mismatch: ${embeddings.length} vs ${messages.length}`);
        continue;
      }

      // Compute pairwise cosine distances between consecutive windows
      const distances: number[] = [0];
      for (let i = 1; i < embeddings.length; i++) {
        distances.push(cosineDistance(embeddings[i - 1], embeddings[i]));
      }

      // Segment: walk through messages, split at topic boundaries or token targets
      const rawSegments = this.buildSegments(messages, embeddings, distances, sessionId);

      // Merge tiny segments into neighbors
      const merged = this.mergeSmallSegments(rawSegments);

      if (merged.length === 0) continue;

      // Store segments
      const insertSeg = this.db.prepare(
        "INSERT OR IGNORE INTO semantic_segments (session_id, msg_start, msg_end, start_time, end_time, level, summary, token_count) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
      );
      const insertVec = this.db.prepare(
        "INSERT INTO vec_segments (rowid, embedding) VALUES (?, ?)"
      );
      const upsertState = this.db.prepare(
        "INSERT OR REPLACE INTO segment_state (session_id, last_segmented_msg) VALUES (?, ?)"
      );

      let created = 0;
      const lastMsgIndex = messages[messages.length - 1].msg_index;

      const tx = this.db.transaction(() => {
        for (const seg of merged) {
          const info = insertSeg.run(seg.session_id, seg.msg_start, seg.msg_end, seg.start_time, seg.end_time, seg.text, seg.token_count);
          if (info.changes === 0) continue;
          const segId = typeof info.lastInsertRowid === "bigint" ? info.lastInsertRowid : BigInt(info.lastInsertRowid);
          insertVec.run(segId, new Float32Array(seg.embedding));
          created++;
        }
        upsertState.run(sessionId, lastMsgIndex);
      });
      tx();

      totalCreated += created;

      if (created > 0) {
        log.debug("segments", `created ${created} segments from chunk`);
      }
    }

    if (totalCreated > 0) {
      log("segments", `total ${totalCreated} segments for session ${sessionId.slice(0, 8)}...`);
      // Summarize in background, then roll up higher levels
      this.summarizeUnsummarized().then(() => {
        return this.rollUpLevels(sessionId);
      }).catch((err) => {
        log.error("segments", `summarization/rollup failed: ${err.message}`);
      });
    }

    return totalCreated;
  }

  /**
   * Build windowed text for embedding — each entry is the concatenation of
   * WINDOW_SIZE messages centered on that position. Smooths out per-message noise.
   */
  private buildWindowTexts(messages: MessageRow[]): string[] {
    const half = Math.floor(WINDOW_SIZE / 2);
    return messages.map((_, i) => {
      const start = Math.max(0, i - half);
      const end = Math.min(messages.length, i + half + 1);
      return messages.slice(start, end).map(m => `${m.role}: ${this.messageText(m)}`).join("\n");
    });
  }

  async resummarizeSegment(id: number): Promise<{ ok: true; id: number; level: number }> {
    const seg = this.db.prepare(
      `SELECT id, session_id, msg_start, msg_end, level, summary, token_count
       FROM semantic_segments
       WHERE id = ?`
    ).get(id) as {
      id: number;
      session_id: string;
      msg_start: number;
      msg_end: number;
      level: number;
      summary: string;
      token_count: number;
    } | undefined;

    if (!seg) throw new Error(`segment ${id} not found`);

    let inputText = "";
    let targetTokens = 0;
    let prompt = "";

    if (seg.level === 0) {
      const rows = this.db.prepare(
        `SELECT role, content FROM messages
         WHERE session_id = ? AND msg_index >= ? AND msg_index < ?
         ORDER BY msg_index`
      ).all(seg.session_id, seg.msg_start, seg.msg_end) as Array<{ role: string; content: string }>;

      inputText = rows.map((m) => `${m.role}: ${extractText(m.content)}`).join("\n");
      inputText = inputText.replace(/^tool: .{500,}$/gm, (m) => m.slice(0, 300) + '... [truncated]').slice(0, 60000);
      targetTokens = Math.max(200, Math.min(1500, Math.round(seg.token_count / 10)));
      prompt = segmentSummaryPrompt(inputText, targetTokens);
    } else {
      const children = this.db.prepare(
        `SELECT msg_start, msg_end, summary
         FROM semantic_segments
         WHERE parent_id = ?
         ORDER BY msg_start`
      ).all(id) as Array<{ msg_start: number; msg_end: number; summary: string }>;

      if (children.length === 0) throw new Error(`segment ${id} has no children`);
      inputText = children.map((seg, i) => `[Segment ${i + 1}, msgs ${seg.msg_start}-${seg.msg_end}]\n${seg.summary}`).join("\n\n");
      targetTokens = 1500;
      prompt = rollupSummaryPrompt(inputText, targetTokens, children.length);
    }

    const result = await generateText({
      model: this.summaryModel,
      prompt,
      maxOutputTokens: targetTokens,
      providerOptions: this.summaryProviderOptions,
    });

    const summaryText = result.text.trim();
    if (!summaryText) throw new Error(`empty summary for segment ${id}`);

    const summaryTokens = result.usage?.outputTokens ?? Math.ceil(summaryText.length / 4);
    this.db.prepare(
      "UPDATE semantic_segments SET summary = ?, summarized = 1, summary_token_count = ? WHERE id = ?"
    ).run(summaryText, summaryTokens, id);

    return { ok: true, id, level: seg.level };
  }

  /**
   * Summarize all unsummarized segments.
   * Idempotent — safe to call repeatedly. Picks up segments from any session
   * that have summarized=0, including ones from crashed/interrupted runs.
   */
  async summarizeUnsummarized(): Promise<number> {
    const rows = this.db.prepare(
      "SELECT id, summary, token_count FROM semantic_segments WHERE summarized = 0 ORDER BY id"
    ).all() as Array<{ id: number; summary: string; token_count: number }>;

    if (rows.length === 0) return 0;

    log.debug("segments", `summarizing ${rows.length} segments...`);

    const update = this.db.prepare(
      "UPDATE semantic_segments SET summary = ?, summarized = 1, summary_token_count = ? WHERE id = ?"
    );

    const CONCURRENCY = 15;
    let summarized = 0;

    const summarizeOne = async (row: { id: number; summary: string; token_count: number }) => {
      if (this.abortController?.signal.aborted) return;
      try {
        const summaryInput = row.summary.replace(/^tool: .{500,}$/gm, (m) => m.slice(0, 300) + '... [truncated]');
        const inputText = summaryInput.slice(0, 60000);
        const targetTokens = Math.max(200, Math.min(1500, Math.round(row.token_count / 10)));

        const result = await generateText({
          model: this.summaryModel,
          prompt: segmentSummaryPrompt(inputText, targetTokens),
          maxOutputTokens: targetTokens,
          providerOptions: this.summaryProviderOptions,
        });

        const summaryText = result.text.trim();
        if (summaryText) {
          const summaryTokens = result.usage?.outputTokens ?? Math.ceil(summaryText.length / 4);
          update.run(summaryText, summaryTokens, row.id);
          summarized++;
        }
      } catch (err: any) {
        log.error("segments", `failed to summarize segment ${row.id}: ${err.message}`);
      }
    };

    // Process in batches of CONCURRENCY
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      if (this.abortController?.signal.aborted) {
        log.warn("segments", "summarization aborted");
        break;
      }
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(summarizeOne));
    }

    if (summarized > 0) {
      log.debug("segments", `summarized ${summarized} segments`);
    }
    return summarized;
  }

  /**
   * Roll up segments into higher levels.
   * For each level, find 10+ consecutive summarized segments with no parent_id.
   * Group them into a parent segment at level+1. Recurse until no more groups.
   */
  private async rollUpLevels(sessionId: string): Promise<void> {
    const ROLLUP_SIZE = 10;
    let rolled = true;

    while (rolled) {
      rolled = false;
      if (this.abortController?.signal.aborted) break;

      // Find the max level that exists
      const maxLevelRow = this.db.prepare(
        "SELECT MAX(level) as max_level FROM semantic_segments WHERE session_id = ?"
      ).get(sessionId) as { max_level: number | null };
      const maxLevel = maxLevelRow?.max_level ?? 0;

      for (let level = 0; level <= maxLevel; level++) {
        // Get consecutive summarized orphans at this level
        const orphans = this.db.prepare(
          `SELECT id, msg_start, msg_end, start_time, end_time, summary, token_count, summary_token_count
           FROM semantic_segments
           WHERE session_id = ? AND level = ? AND parent_id IS NULL AND summarized = 1
           ORDER BY msg_start`
        ).all(sessionId, level) as Array<{
          id: number; msg_start: number; msg_end: number;
          start_time: string | null; end_time: string | null;
          summary: string; token_count: number; summary_token_count: number;
        }>;

        if (orphans.length < ROLLUP_SIZE) continue;

        // Take groups of ROLLUP_SIZE
        const groupCount = Math.floor(orphans.length / ROLLUP_SIZE);
        for (let g = 0; g < groupCount; g++) {
          if (this.abortController?.signal.aborted) break;

          const group = orphans.slice(g * ROLLUP_SIZE, (g + 1) * ROLLUP_SIZE);
          const parentLevel = level + 1;
          const msgStart = group[0].msg_start;
          const msgEnd = group[group.length - 1].msg_end;
          const startTime = group[0].start_time;
          const endTime = group[group.length - 1].end_time;
          const totalTokens = group.reduce((s, seg) => s + seg.token_count, 0);

          // Concatenate child summaries as input for parent summary
          const childSummaries = group.map((seg, i) =>
            `[Segment ${i + 1}, msgs ${seg.msg_start}-${seg.msg_end}]\n${seg.summary}`
          ).join("\n\n");

          const targetTokens = 1500;

          try {
            const result = await generateText({
              model: this.summaryModel,
              prompt: rollupSummaryPrompt(childSummaries, targetTokens, group.length),
              maxOutputTokens: targetTokens,
              providerOptions: this.summaryProviderOptions,
            });

            const summaryText = result.text.trim();
            if (!summaryText) continue;

            const summaryTokens = result.usage?.outputTokens ?? Math.ceil(summaryText.length / 4);

            // Insert parent, set children's parent_id
            const tx = this.db.transaction(() => {
              const info = this.db.prepare(
                `INSERT OR IGNORE INTO semantic_segments (session_id, msg_start, msg_end, start_time, end_time, level, summary, token_count, summary_token_count, summarized)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
              ).run(sessionId, msgStart, msgEnd, startTime, endTime, parentLevel, summaryText, totalTokens, summaryTokens);

              if (info.changes === 0) return; // already exists

              const parentId = info.lastInsertRowid;
              const setParent = this.db.prepare(
                "UPDATE semantic_segments SET parent_id = ? WHERE id = ?"
              );
              for (const child of group) {
                setParent.run(parentId, child.id);
              }
            });
            tx();

            log("segments", `rolled up ${group.length} L${level} → 1 L${parentLevel} (msgs ${msgStart}-${msgEnd})`);
            rolled = true;
          } catch (err: any) {
            log.error("segments", `rollup failed for L${level} group: ${err.message}`);
          }
        }
      }
    }
  }

  /**
   * Split messages into segments based on semantic distance and token count.
   */
  private buildSegments(
    messages: MessageRow[],
    embeddings: number[][],
    distances: number[],
    sessionId: string,
  ): Segment[] {
    const segments: Segment[] = [];
    let segStart = 0;
    let segTokens = 0;

    const closeSegment = (end: number) => {
      if (end <= segStart) return;

      // Build segment text from full message content (not truncated embedding text)
      const segMsgs = messages.slice(segStart, end);
      const text = segMsgs.map((m) => `${m.role}: ${extractText(m.content)}`).join("\n");
      const tokenCount = Math.ceil(text.length / 4);

      // Average the embeddings for this segment
      const segEmbeddings = embeddings.slice(segStart, end);
      const avgEmbedding = averageEmbeddings(segEmbeddings);

      // Extract time range from first/last non-null message timestamps within the segment.
      // Edge messages are often assistant/tool rows with no embedded user metadata timestamp.
      const startTime = segMsgs.find((m) => m.timestamp)?.timestamp || null;
      const endTime = [...segMsgs].reverse().find((m) => m.timestamp)?.timestamp || null;

      segments.push({
        session_id: sessionId,
        msg_start: messages[segStart].msg_index,
        msg_end: messages[end - 1].msg_index + 1, // exclusive end
        start_time: startTime,
        end_time: endTime,
        text,
        token_count: tokenCount,
        embedding: avgEmbedding,
      });

      segStart = end;
      segTokens = 0;
    };

    for (let i = 0; i < messages.length; i++) {
      const msgTokens = Math.ceil(messages[i].content.length / 4);

      // Hard cut: topic shift
      if (i > segStart && distances[i] > TOPIC_THRESHOLD) {
        closeSegment(i);
      }

      // Soft cut: segment too large — find best split point
      if (segTokens + msgTokens > TARGET_TOKENS && i > segStart + 1) {
        // Find highest distance within current segment
        let bestSplit = segStart + 1;
        let bestDist = -1;
        for (let j = segStart + 1; j <= i; j++) {
          if (distances[j] > bestDist) {
            bestDist = distances[j];
            bestSplit = j;
          }
        }
        closeSegment(bestSplit);
      }

      segTokens += msgTokens;
    }

    // Close final segment
    closeSegment(messages.length);

    return segments;
  }

  /**
   * Merge segments below MIN_TOKENS into their closest neighbor.
   */
  private mergeSmallSegments(segments: Segment[]): Segment[] {
    if (segments.length <= 1) return segments;

    const result: Segment[] = [];
    let i = 0;

    while (i < segments.length) {
      const seg = segments[i];

      const msgCount = seg.msg_end - seg.msg_start;
      if ((seg.token_count >= MIN_TOKENS && msgCount >= MIN_MESSAGES) || segments.length <= 1) {
        result.push(seg);
        i++;
        continue;
      }

      // Tiny segment — check neighbors
      const prev = result.length > 0 ? result[result.length - 1] : null;
      const next = i + 1 < segments.length ? segments[i + 1] : null;

      const distPrev = prev ? cosineDistance(prev.embedding, seg.embedding) : Infinity;
      const distNext = next ? cosineDistance(seg.embedding, next.embedding) : Infinity;
      const minDist = Math.min(distPrev, distNext);

      // Force merge if very few messages, otherwise respect distance threshold
      if (minDist > MERGE_THRESHOLD && msgCount >= MIN_MESSAGES) {
        result.push(seg);
        i++;
        continue;
      }

      if (distPrev <= distNext && prev) {
        // Merge into previous
        prev.msg_end = seg.msg_end;
        prev.text += "\n" + seg.text;
        prev.token_count += seg.token_count;
        prev.embedding = averageEmbeddings([prev.embedding, seg.embedding].map(e => e));
        i++;
      } else if (next) {
        // Merge into next
        next.msg_start = seg.msg_start;
        next.text = seg.text + "\n" + next.text;
        next.token_count += seg.token_count;
        next.embedding = averageEmbeddings([seg.embedding, next.embedding].map(e => e));
        i++;
      } else {
        result.push(seg);
        i++;
      }
    }

    return result;
  }

  /**
   * Convert a message row to embeddable text.
   * Truncates tool outputs to keep embeddings focused.
   */
  private messageText(msg: MessageRow): string {
    const content = msg.content;
    // Tool results: truncate for embedding
    if (msg.role === "tool") {
      return content.length > 300 ? content.slice(0, 300) + "..." : content;
    }
    // Assistant tool calls or user messages with array content: parse and extract text
    if (content.startsWith("[")) {
      try {
        const parts = JSON.parse(content);
        if (Array.isArray(parts)) {
          return parts.map((p: any) => {
            if (p.type === "text") return p.text;
            if (p.type === "tool-call") return `[tool: ${p.toolName}]`;
            if (p.type === "image") return `[image]`;
            if (p.type === "file") return `[file: ${p.filename || p.mediaType || "file"}]`;
            return "";
          }).filter(Boolean).join(" ");
        }
      } catch {
        return content.length > 500 ? content.slice(0, 500) + "..." : content;
      }
    }
    return content.length > 500 ? content.slice(0, 500) + "..." : content;
  }

  /**
   * Embed texts in batches.
   */
  private async embedTexts(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (let b = 0; b < texts.length; b += EMBED_BATCH_SIZE) {
      const batch = texts.slice(b, b + EMBED_BATCH_SIZE);
      const result = await embedMany({ model: this.embeddingModel, values: batch });
      embeddings.push(...result.embeddings);
      if (texts.length > EMBED_BATCH_SIZE) {
        log.debug("segments", `embedded batch ${Math.floor(b / EMBED_BATCH_SIZE) + 1}/${Math.ceil(texts.length / EMBED_BATCH_SIZE)}`);
      }
    }
    return embeddings;
  }

  /**
   * Stop any running indexSession/summarization.
   */
  stop() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      log("segments", "stopped");
    }
  }

  /**
   * Clear all segments and state. Used before a full rebuild.
   */
  clear() {
    this.db.exec("DELETE FROM semantic_segments");
    this.db.exec("DELETE FROM segment_state");
    try { this.db.exec("DELETE FROM vec_segments"); } catch {}
    log("segments", "all segments cleared");
  }

  /**
   * Return sorted L0 segment msg_start values for a session.
   * Used to snap trim boundaries to stable segment edges for cache stability.
   */
  getL0Boundaries(sessionId: string): number[] {
    const rows = this.db.prepare(
      `SELECT msg_end FROM semantic_segments
       WHERE session_id = ? AND level = 0
       ORDER BY msg_end ASC`
    ).all(sessionId) as Array<{ msg_end: number }>;
    return rows.map(r => r.msg_end);
  }

  /**
   * Compose compressed history for context injection.
   * Fills a token budget with segment summaries from the trimmed region.
   * Recency bias: expands most recent segments to lower (more detailed) levels first.
   *
   * trimmedBeforeMsg is snapped down to the nearest L0 segment boundary
   * so the summary tree stays stable across consecutive turns (better cache hits).
   */
  composeHistory(sessionId: string, trimmedBeforeMsg: number, budgetTokens: number): {
    text: string;
    levelCounts: Record<number, number>;
    tokens: number;
    segments: Array<{
      id: number;
      level: number;
      msg_start: number;
      msg_end: number;
      start_time: string | null;
      end_time: string | null;
      summary: string;
      token_count: number;
      summary_token_count: number;
      parent_id: number | null;
    }>;
  } | null {
    // Get all summarized segments for this session
    const allSegments = this.db.prepare(
      `SELECT id, msg_start, msg_end, start_time, end_time, parent_id, level, summary, token_count, summary_token_count
       FROM semantic_segments
       WHERE session_id = ? AND summarized = 1
       ORDER BY level DESC, msg_start ASC`
    ).all(sessionId) as Array<{
      id: number; msg_start: number; msg_end: number;
      start_time: string | null; end_time: string | null;
      parent_id: number | null; level: number;
      summary: string; token_count: number; summary_token_count: number;
    }>;

    if (allSegments.length === 0) return null;

    // Snap trim boundary down to nearest L0 segment end for cache stability.
    // This prevents the summary from changing every turn as new messages shift
    // the trim boundary by 1-2 messages.
    const l0Boundaries = allSegments
      .filter(s => s.level === 0 && s.msg_end <= trimmedBeforeMsg)
      .map(s => s.msg_end);
    const snappedBoundary = l0Boundaries.length > 0
      ? Math.max(...l0Boundaries)
      : trimmedBeforeMsg;

    // Only segments covering the trimmed region (before snapped boundary)
    const trimmedSegments = allSegments.filter(s => s.msg_start < snappedBoundary);
    if (trimmedSegments.length === 0) return null;

    // Build a map of parent → children for expansion
    const childrenOf = new Map<number, typeof allSegments>();
    for (const seg of allSegments) {
      if (seg.parent_id != null) {
        const existing = childrenOf.get(seg.parent_id) || [];
        existing.push(seg);
        childrenOf.set(seg.parent_id, existing);
      }
    }

    // Start with top-level segments (no parent) covering trimmed region, sorted by msg_start
    let selected = trimmedSegments
      .filter(s => s.parent_id == null)
      .sort((a, b) => a.msg_start - b.msg_start);

    if (selected.length === 0) return null;

    let usedTokens = selected.reduce((s, seg) => s + seg.summary_token_count, 0);

    // Expand segments breadth-first by level, then recency within each level.
    // This ensures all L2s expand to L1s before any L1 expands to L0,
    // giving balanced coverage across the full history.
    let expanded = true;
    while (expanded && usedTokens < budgetTokens) {
      expanded = false;
      // Find the highest level segment that has children (breadth-first),
      // breaking ties by recency (rightmost)
      const maxLevel = Math.max(...selected.map(s => s.level));
      for (let i = selected.length - 1; i >= 0; i--) {
        const seg = selected[i];
        if (seg.level < maxLevel) continue; // expand highest level first
        const children = childrenOf.get(seg.id);
        if (!children || children.length === 0) continue;

        // Cost of expansion: remove parent summary, add all children summaries
        const parentCost = seg.summary_token_count;
        const childCost = children.reduce((s, c) => s + c.summary_token_count, 0);
        const delta = childCost - parentCost;

        if (usedTokens + delta <= budgetTokens) {
          // Replace parent with children
          const sortedChildren = [...children].sort((a, b) => a.msg_start - b.msg_start);
          selected.splice(i, 1, ...sortedChildren);
          usedTokens += delta;
          expanded = true;
          break; // restart from the end
        }
      }
    }

    // Count per level
    const levelCounts: Record<number, number> = {};
    for (const seg of selected) {
      levelCounts[seg.level] = (levelCounts[seg.level] || 0) + 1;
    }

    // Format output as explicit summary blocks.
    const lines: string[] = [];
    for (const seg of selected) {
      const summaryLines = [
        `<summary>`,
        `level: L${seg.level}`,
        `messages: ${seg.msg_start}-${seg.msg_end}`,
        ...(seg.start_time ? [`first: ${seg.start_time}`] : []),
        ...(seg.end_time ? [`last: ${seg.end_time}`] : []),
        ``,
        seg.summary,
        `</summary>`,
      ];
      lines.push(summaryLines.join("\n"));
    }

    return { text: lines.join('\n\n'), levelCounts, tokens: usedTokens, segments: selected };
  }

  getStats(): { segments: number; level0: number; levels: Record<number, number> } {
    const total = (this.db.prepare("SELECT COUNT(*) as n FROM semantic_segments").get() as any).n;
    const l0 = (this.db.prepare("SELECT COUNT(*) as n FROM semantic_segments WHERE level = 0").get() as any).n;
    const rows = this.db.prepare("SELECT level, COUNT(*) as n FROM semantic_segments GROUP BY level ORDER BY level").all() as Array<{ level: number; n: number }>;
    const levels: Record<number, number> = {};
    for (const row of rows) levels[row.level] = row.n;
    return { segments: total, level0: l0, levels };
  }

  /**
   * Get all segments for visualization.
   */
  getSegments(sessionId?: string): { segments: any[]; stats: any } {
    const where = sessionId ? "WHERE session_id = ?" : "";
    const params = sessionId ? [sessionId] : [];

    const segments = this.db.prepare(
      `SELECT id, session_id, msg_start, msg_end, start_time, end_time, parent_id, level, summary, token_count, summary_token_count, summarized, created_at
       FROM semantic_segments ${where} ORDER BY level, msg_start`
    ).all(...params) as any[];

    const stats = this.getStats();

    return { segments, stats };
  }
}

// --- Vector math ---

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

function averageEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  if (embeddings.length === 1) return embeddings[0];
  const dim = embeddings[0].length;
  const avg = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
  return avg;
}
