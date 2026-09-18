import { embed, embedMany, generateText } from "ai";
import { log } from "./log.js";
import { extractText, capForEmbedding, EMBED_MAX_CHARS } from "./util.js";
import { createEmbeddingModel, createSummaryModel, summaryViaOpenRouter } from "./model.js";
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
// Floor for the shrink-and-retry in embedOne: 500 code units is ~2000 tokens
// even at the worst measured 4 tokens/code unit, so it fits any 8192-token
// model. Below this a rejection isn't about length, and rethrowing is right.
const EMBED_MIN_CHARS = 500;

// Max characters of text extracted from a multi-part message when building
// embedding windows (plain strings cap at 500, tool output at 300).
// A window joins WINDOW_SIZE messages, so one unbounded message can push the
// window past the embedding model's token limit and 400 the whole batch.
// Only affects boundary detection input — stored content is untouched.
const MAX_MESSAGE_CHARS = 2000;

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

export interface HistorySegment {
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
}

/**
 * Pure selection step of composeHistory(): pick which summarized segments
 * fill a token budget for the trimmed region [0, trimmedBeforeMsg).
 *
 * - trimmedBeforeMsg is snapped down to the nearest L0 segment end so the
 *   selection stays stable across consecutive turns (cache hits).
 * - Starts from top-level (orphan) segments, then expands breadth-first by
 *   level (all L2s → L1s before any L1 → L0s), most recent first, while the
 *   budget allows.
 *
 * Exported so offline tools (kern scripts segment-health) can reproduce the
 * exact injection an agent would get, without a live SegmentIndex.
 */
export function selectHistorySegments(
  allSegments: HistorySegment[],
  trimmedBeforeMsg: number,
  budgetTokens: number,
): { selected: HistorySegment[]; tokens: number; snappedBoundary: number; shadowed: HistorySegment[] } | null {
  if (allSegments.length === 0) return null;

  const l0Boundaries = allSegments
    .filter(s => s.level === 0 && s.msg_end <= trimmedBeforeMsg)
    .map(s => s.msg_end);
  const snappedBoundary = l0Boundaries.length > 0
    ? Math.max(...l0Boundaries)
    : trimmedBeforeMsg;

  const trimmedSegments = allSegments.filter(s => s.msg_start < snappedBoundary);
  if (trimmedSegments.length === 0) return null;

  const childrenOf = new Map<number, HistorySegment[]>();
  for (const seg of allSegments) {
    if (seg.parent_id != null) {
      const existing = childrenOf.get(seg.parent_id) || [];
      existing.push(seg);
      childrenOf.set(seg.parent_id, existing);
    }
  }

  const roots = trimmedSegments
    .filter(s => s.parent_id == null)
    .sort((a, b) => a.msg_start - b.msg_start || b.msg_end - a.msg_end || a.id - b.id);
  // Safety net (#364 A4): a root whose range sits inside another root's range is a
  // shadow — inject only the covering one. Children tile their parent exactly, so
  // deduping the roots is enough; expansion below cannot reintroduce an overlap.
  const selected: HistorySegment[] = [];
  const shadowed: HistorySegment[] = [];
  for (const r of roots) {
    const covered = selected.some(s => s.msg_start <= r.msg_start && r.msg_end <= s.msg_end);
    if (covered) shadowed.push(r); else selected.push(r);
  }
  if (selected.length === 0) return null;

  let usedTokens = selected.reduce((s, seg) => s + seg.summary_token_count, 0);

  let expanded = true;
  while (expanded && usedTokens < budgetTokens) {
    expanded = false;
    const maxLevel = Math.max(...selected.map(s => s.level));
    for (let i = selected.length - 1; i >= 0; i--) {
      const seg = selected[i];
      if (seg.level < maxLevel) continue;
      const children = childrenOf.get(seg.id);
      if (!children || children.length === 0) continue;

      const parentCost = seg.summary_token_count;
      const childCost = children.reduce((s, c) => s + c.summary_token_count, 0);
      const delta = childCost - parentCost;

      if (usedTokens + delta <= budgetTokens) {
        const sortedChildren = [...children].sort((a, b) => a.msg_start - b.msg_start);
        selected.splice(i, 1, ...sortedChildren);
        usedTokens += delta;
        expanded = true;
        break;
      }
    }
  }

  return { selected, tokens: usedTokens, snappedBoundary, shadowed };
}

export const ROLLUP_SIZE = 10;

export interface RollupRow {
  id: number;
  msg_start: number;
  msg_end: number;
  start_time: string | null;
  end_time: string | null;
  summary: string;
  token_count: number;
  summary_token_count: number;
  parent_id: number | null;
  summarized: number;
}

/** Adjacent, allowing the 1-message overlap that pre-#364 chunk boundaries produced. */
export function isAdjacent(prevEnd: number, nextStart: number): boolean {
  return nextStart === prevEnd || nextStart === prevEnd - 1;
}

/**
 * Pure grouping step of rollUpLevels(): given every segment at one level (sorted by
 * msg_start), return the groups of summarized orphans to roll up, in order.
 * See rollUpLevels() for the rules. Exported for tests.
 */
export function planRollupGroups(rows: RollupRow[]): RollupRow[][] {
  if (rows.length === 0) return [];
  const levelStart = rows[0].msg_start;
  const parented = rows.filter(r => r.parent_id != null);
  const hasParentedEndingAt = (pos: number) => parented.some(p => isAdjacent(p.msg_end, pos));
  const hasParentedStartingAt = (pos: number) => parented.some(p => isAdjacent(pos, p.msg_start));

  // Contiguous runs of summarized orphans, walked over the full position-ordered
  // stream: any parented or pending row ends the current run, so a run can never
  // straddle a row that already belongs to a parent (possible only in pre-prune
  // trees where a parented row overlaps its neighbours).
  // An orphan that itself overlaps a parented row (≥2 msgs; legacy fencepost tolerated)
  // is likewise ineligible — that ground already belongs to a parent, and rolling it up
  // would recreate an overlapping branch (pre-prune trees only; prune removes such rows).
  const overlapsParented = (r: RollupRow) =>
    parented.some(p => Math.min(p.msg_end, r.msg_end) - Math.max(p.msg_start, r.msg_start) >= 2);
  const runs: RollupRow[][] = [];
  let run: RollupRow[] | null = null;
  for (const r of rows) {
    const eligible = r.parent_id == null && r.summarized === 1 && !overlapsParented(r);
    if (!eligible) { run = null; continue; }
    if (run && isAdjacent(run[run.length - 1].msg_end, r.msg_start)) run.push(r);
    else { run = [r]; runs.push(run); }
  }

  const groups: RollupRow[][] = [];
  for (const run of runs) {
    const runStart = run[0].msg_start;
    const runEnd = run[run.length - 1].msg_end;
    const boundedLeft = runStart === levelStart || hasParentedEndingAt(runStart);
    const boundedRight = hasParentedStartingAt(runEnd);
    const interior = boundedLeft && boundedRight;

    const full = Math.floor(run.length / ROLLUP_SIZE);
    for (let g = 0; g < full; g++) groups.push(run.slice(g * ROLLUP_SIZE, (g + 1) * ROLLUP_SIZE));
    const rest = run.slice(full * ROLLUP_SIZE);
    if (rest.length === 0 || !interior) continue;
    // Hole filler: fold the remainder into the last full group if there is one
    // (a parent of 10–19 is fine), otherwise it becomes a small parent on its own.
    if (full > 0) groups[groups.length - 1].push(...rest);
    else groups.push(rest);
  }
  return groups;
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
      config.provider === "ollama" && !summaryViaOpenRouter(config)
        ? { openai: { think: false } }
        : undefined;
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
    // last_segmented_msg is the index of the last message already inside a segment
    // (inclusive). Resume strictly after it — re-including it made every chunk
    // boundary a 1-message overlap (#364 A1).
    let resumeFrom = state ? state.last_segmented_msg + 1 : 0;
    // Cursor missing or behind the tree (pre-#364 embedding-dimension change reset it;
    // a restored DB can leave it stale): fast-forward to the end of the *contiguous* L0
    // coverage that starts at the cursor, instead of re-segmenting covered messages.
    // Re-indexing covered ground re-embedded the whole history and laid a shifted second
    // tiling next to the first one; with a stale cursor a candidate straddling the
    // coverage edge would be rejected by the overlap guard below and its uncovered tail
    // lost. A stray segment further ahead with a hole before it does not move the cursor —
    // the hole gets indexed and the stray is handled by the overlap guard.
    const ahead = this.db.prepare(
      "SELECT msg_start, msg_end FROM semantic_segments WHERE session_id = ? AND level = 0 AND msg_end > ? ORDER BY msg_start"
    ).all(sessionId, resumeFrom) as Array<{ msg_start: number; msg_end: number }>;
    let frontier = resumeFrom;
    for (const seg of ahead) {
      if (seg.msg_start > frontier) break;
      frontier = Math.max(frontier, seg.msg_end);
    }
    if (frontier > resumeFrom) {
      log.warn("segments", `segment_state ${state ? `at ${state.last_segmented_msg}` : "missing"} for ${sessionId.slice(0, 8)} but L0 covers through ${frontier} — cursor fast-forwarded`);
      resumeFrom = frontier;
      this.db.prepare("INSERT OR REPLACE INTO segment_state (session_id, last_segmented_msg) VALUES (?, ?)").run(sessionId, frontier - 1);
    }

    // Load new messages from the messages table — chunked to prevent OOM
    const allMessages = this.db.prepare(
      "SELECT id, msg_index, role, content, timestamp FROM messages WHERE session_id = ? AND msg_index >= ? ORDER BY msg_index"
    ).all(sessionId, resumeFrom) as MessageRow[];

    if (allMessages.length < 3) return 0;
    // For incremental indexing, wait for enough content to detect topic boundaries
    if (resumeFrom > 0) {
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
      // Same-level overlap check. UNIQUE(session, level, start, end) only blocks exact
      // duplicates; a re-index that cuts one message differently would otherwise lay a
      // second tiling alongside the first (#364 A3). Any overlap → the range is already
      // covered → skip. segment_state still advances so we never re-embed this stretch.
      const overlapping = this.db.prepare(
        "SELECT 1 FROM semantic_segments WHERE session_id = ? AND level = 0 AND msg_start < ? AND msg_end > ? LIMIT 1"
      );

      let created = 0;
      let rejected = 0;
      const lastMsgIndex = messages[messages.length - 1].msg_index;

      const tx = this.db.transaction(() => {
        for (const seg of merged) {
          if (overlapping.get(sessionId, seg.msg_end, seg.msg_start)) { rejected++; continue; }
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
      if (rejected > 0) {
        log.warn("segments", `skipped ${rejected} segment(s) overlapping existing L0 coverage (msgs ${messages[0].msg_index}–${lastMsgIndex}); segment_state was behind the tree`);
      }

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
   * Roll orphaned, summarized segments up into parents one level higher.
   *
   * Invariant (#364): every level tiles the indexed range with exactly one branch,
   * so a parent must cover exactly the contiguous run of its children. Orphans are
   * therefore grouped only along contiguous runs (next.msg_start == prev.msg_end,
   * or == prev.msg_end − 1 for legacy fencepost segments); a discontinuity ends
   * the run. Never batch by position alone — that produced parents spanning
   * weeks of siblings they did not own.
   *
   * Per run:
   *   - full groups of ROLLUP_SIZE always roll up;
   *   - the remainder rolls up only if the run is *interior* — bounded on the right
   *     by an already-parented segment and on the left by one too (or by the start
   *     of the level). Such a hole would otherwise stay orphaned forever;
   *   - the remainder of the trailing (open-ended) run stays orphan until it grows.
   * Recurse until no level rolls anything.
   */
  private async rollUpLevels(sessionId: string): Promise<void> {
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
        const rows = this.db.prepare(
          `SELECT id, msg_start, msg_end, start_time, end_time, summary, token_count, summary_token_count, parent_id, summarized
           FROM semantic_segments
           WHERE session_id = ? AND level = ?
           ORDER BY msg_start, msg_end`
        ).all(sessionId, level) as RollupRow[];

        const groups = planRollupGroups(rows);
        if (groups.length === 0) continue;

        for (const group of groups) {
          if (this.abortController?.signal.aborted) break;
          if (await this.rollUpGroup(sessionId, level, group)) rolled = true;
        }
      }
    }
  }

  /** Summarize one contiguous group of orphans into a parent at level+1. */
  private async rollUpGroup(sessionId: string, level: number, group: RollupRow[]): Promise<boolean> {
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
      if (!summaryText) return false;

      const summaryTokens = result.usage?.outputTokens ?? Math.ceil(summaryText.length / 4);

      // Insert parent, set children's parent_id
      const tx = this.db.transaction(() => {
        const info = this.db.prepare(
          `INSERT OR IGNORE INTO semantic_segments (session_id, msg_start, msg_end, start_time, end_time, level, summary, token_count, summary_token_count, summarized)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(sessionId, msgStart, msgEnd, startTime, endTime, parentLevel, summaryText, totalTokens, summaryTokens);

        let parentId: number | bigint = info.lastInsertRowid;
        if (info.changes === 0) {
          // Already exists — find existing parent ID so children don't loop endlessly as orphans
          const existing = this.db.prepare(
            `SELECT id FROM semantic_segments
             WHERE session_id = ? AND level = ? AND msg_start = ? AND msg_end = ?`
          ).get(sessionId, parentLevel, msgStart, msgEnd) as { id: number } | undefined;
          if (!existing) return;
          parentId = existing.id;
        }

        const setParent = this.db.prepare(
          "UPDATE semantic_segments SET parent_id = ? WHERE id = ?"
        );
        for (const child of group) {
          setParent.run(parentId, child.id);
        }
      });
      tx();

      log("segments", `rolled up ${group.length} L${level} → 1 L${parentLevel} (msgs ${msgStart}-${msgEnd})`);
      return true;
    } catch (err: any) {
      log.error("segments", `rollup failed for L${level} group: ${err.message}`);
      return false;
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
      return content.length > 300 ? capForEmbedding(content, 300) + "..." : content;
    }
    // Assistant tool calls or user messages with array content: parse and extract text
    if (content.startsWith("[")) {
      try {
        const parts = JSON.parse(content);
        if (Array.isArray(parts)) {
          const text = parts.map((p: any) => {
            if (p.type === "text") return p.text;
            if (p.type === "tool-call") return `[tool: ${p.toolName}]`;
            if (p.type === "image") return `[image]`;
            if (p.type === "file") return `[file: ${p.filename || p.mediaType || "file"}]`;
            return "";
          }).filter(Boolean).join(" ");
          // Cap like the other branches — an assistant reply or user paste of
          // any length lands here, and uncapped it can break the batch.
          return text.length > MAX_MESSAGE_CHARS
            ? capForEmbedding(text, MAX_MESSAGE_CHARS) + "..."
            : text;
        }
      } catch {
        return content.length > 500 ? capForEmbedding(content, 500) + "..." : content;
      }
    }
    return content.length > 500 ? capForEmbedding(content, 500) + "..." : content;
  }

  /**
   * Embed texts in batches.
   */
  private async embedTexts(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (let b = 0; b < texts.length; b += EMBED_BATCH_SIZE) {
      const batch = texts.slice(b, b + EMBED_BATCH_SIZE).map((t) => capForEmbedding(t));
      try {
        const result = await embedMany({ model: this.embeddingModel, values: batch });
        embeddings.push(...result.embeddings);
      } catch (err) {
        // One rejected value fails the whole batch, and indexSession then
        // throws without advancing segment_state — the same messages get
        // retried forever, freezing segmentation for good. Fall back to
        // one-at-a-time so a single bad window can't take out 99 good ones.
        log.warn("segments", `embed batch failed (${err instanceof Error ? err.message : String(err)}) — retrying values individually`);
        for (const value of batch) {
          embeddings.push(await this.embedOne(value));
        }
      }
      if (texts.length > EMBED_BATCH_SIZE) {
        log.debug("segments", `embedded batch ${Math.floor(b / EMBED_BATCH_SIZE) + 1}/${Math.ceil(texts.length / EMBED_BATCH_SIZE)}`);
      }
    }
    return embeddings;
  }

  /**
   * Embed a single value, halving it until the provider accepts it.
   *
   * Character caps can't guarantee a token limit (rare glyphs run up to 4
   * tokens per UTF-16 code unit), so the only reliable way to stay under it
   * is to let the provider tell us. Boundary detection only needs the window
   * to be representative, so trimming a pathological one is a fair trade for
   * segmentation continuing to advance.
   */
  private async embedOne(value: string): Promise<number[]> {
    let chars = Math.min(value.length, EMBED_MAX_CHARS);
    for (;;) {
      try {
        const { embedding } = await embed({
          model: this.embeddingModel,
          value: capForEmbedding(value, chars),
        });
        return embedding;
      } catch (err) {
        if (chars <= EMBED_MIN_CHARS) throw err;
        chars = Math.max(EMBED_MIN_CHARS, Math.floor(chars / 2));
        log.warn("segments", `embed value rejected — retrying at ${chars} chars`);
      }
    }
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
   * Return sorted L0 segment msg_end values (exclusive) for a session.
   * Used to snap trim boundaries to stable segment edges for cache stability.
   *
   * With summarizedOnly, only segments whose summary has been generated are
   * returned — composeHistory() can only inject summarized=1 segments, so
   * coverage checks must not count segments that are merely segmented (#311).
   */
  getL0Boundaries(sessionId: string, summarizedOnly = false): number[] {
    const rows = this.db.prepare(
      `SELECT msg_end FROM semantic_segments
       WHERE session_id = ? AND level = 0${summarizedOnly ? " AND summarized = 1" : ""}
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
    segments: HistorySegment[];
  } | null {
    // Get all summarized segments for this session
    const allSegments = this.db.prepare(
      `SELECT id, msg_start, msg_end, start_time, end_time, parent_id, level, summary, token_count, summary_token_count
       FROM semantic_segments
       WHERE session_id = ? AND summarized = 1
       ORDER BY level DESC, msg_start ASC`
    ).all(sessionId) as HistorySegment[];

    const picked = selectHistorySegments(allSegments, trimmedBeforeMsg, budgetTokens);
    if (!picked) return null;
    const { selected, tokens: usedTokens, shadowed } = picked;
    if (shadowed.length > 0) {
      const ranges = shadowed.map(s => `#${s.id} L${s.level} [${s.msg_start},${s.msg_end})`).join(", ");
      log.warn("segments", `composeHistory dropped ${shadowed.length} shadowed root(s) for ${sessionId.slice(0, 8)} (${shadowed.reduce((n, s) => n + s.summary_token_count, 0)} tokens): ${ranges}`);
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
