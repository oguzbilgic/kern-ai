/**
 * Recall Health Analyzer.
 *
 * Read-only diagnostics over the vector embedding index in recall.db.
 * Analyzes both conversational chunks (chunks / vec_chunks) and semantic
 * segment embeddings (semantic_segments / vec_segments).
 *
 * Checks invariants:
 *  1. Index progress vs total messages (lag and coverage).
 *  2. Chunk token / character sizing & detection of oversized batch-blocking chunks (>8192 tokens or >16k chars).
 *  3. UTF-16 surrogate pair integrity (lone surrogates that trigger provider HTTP 400 invalid_json).
 *  4. 1:1 row sync between content tables and sqlite-vec virtual tables (orphan chunks, ghost vectors).
 *  5. Vector dimensionality uniformity (checks byte length / 4 across virtual tables).
 *  6. Exact identification of blocking stalls in the unindexed message tail.
 *
 * Pure: takes an open better-sqlite3 handle, never writes.
 * Used by `kern scripts recall-health`.
 */

import type Database from "better-sqlite3";

export interface SessionInfo {
  sessionId: string;
  totalMessages: number;
  minIndex: number;
  maxIndex: number;
}

export interface ChunkStats {
  totalChunks: number;
  minTokens: number;
  maxTokens: number;
  avgTokens: number;
  p50Tokens: number;
  p95Tokens: number;
  minChars: number;
  maxChars: number;
  avgChars: number;
  p50Chars: number;
  p95Chars: number;
  buckets: {
    under1k: number;
    from1kTo4k: number;
    from4kTo8k: number;
    over8k: number;
  };
  gt16kChars: number;
  gt8kTokens: number;
  loneSurrogates: number;
}

export interface VectorTableHealth {
  contentRows: number;
  vectorRows: number;
  orphanContent: number;      // in content table, missing in vec_*
  ghostVectors: number;       // in vec_*, missing in content table
  expectedDim: number | null; // detected dominant dimension
  mismatchedDims: number;     // vectors whose byte length doesn't match expectedDim * 4
  sampleDims: number | null;
}

export interface StalledBlocker {
  firstUnindexedMsg: number;
  firstUserMsg: number | null;
  candidateSpanMsgs: number;
  candidateChars: number;
  candidateEstTokens: number;
  largestMsg: {
    index: number;
    role: string;
    chars: number;
    preview: string;
    hasLoneSurrogate: boolean;
  } | null;
  reason: "oversized_chunk" | "lone_surrogate" | "pending_tail";
  detail: string;
}

export interface RecallHealthReport {
  sessionId: string;
  session: SessionInfo;
  recallState: {
    lastIndexedMsg: number | null;
    lagMsgs: number;
    coveragePct: number;
    scanPct: number;
  };
  chunkStats: ChunkStats;
  chunksVectorHealth: VectorTableHealth;
  segmentsVectorHealth: VectorTableHealth;
  blockers: StalledBlocker[];
  score: number;
  scoreBreakdown: Record<string, number>;
}

export interface SessionSummary {
  session_id: string;
  messages: number;
  chunks: number;
  last_indexed_msg: number | null;
}

export function listRecallSessions(db: Database.Database): SessionSummary[] {
  // Find distinct session IDs across index_state, messages, chunks
  const rows = db.prepare(`
    SELECT
      s.session_id,
      COALESCE(m.cnt, 0) as messages,
      COALESCE(c.cnt, 0) as chunks,
      idx.last_indexed_msg
    FROM (
      SELECT session_id FROM index_state
      UNION
      SELECT DISTINCT session_id FROM messages
      UNION
      SELECT DISTINCT session_id FROM chunks
    ) s
    LEFT JOIN (SELECT session_id, count(*) as cnt FROM messages GROUP BY session_id) m ON m.session_id = s.session_id
    LEFT JOIN (SELECT session_id, count(*) as cnt FROM chunks GROUP BY session_id) c ON c.session_id = s.session_id
    LEFT JOIN index_state idx ON idx.session_id = s.session_id
    ORDER BY m.cnt DESC
  `).all() as SessionSummary[];

  return rows;
}

// Check for lone UTF-16 surrogate pairs (unpaired high/low surrogates)
function hasLoneSurrogates(str: string): boolean {
  if (typeof (str as any).isWellFormed === "function") {
    if (!(str as any).isWellFormed()) return true;
  } else {
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= str.length) return true;
        const next = str.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) return true;
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
  }
  return false;
}

export function analyzeRecallHealth(db: Database.Database, sessionId: string): RecallHealthReport {
  // 1. Session info from messages table
  const msgStats = db.prepare(`
    SELECT
      count(*) as cnt,
      COALESCE(min(msg_index), 0) as min_idx,
      COALESCE(max(msg_index), 0) as max_idx
    FROM messages
    WHERE session_id = ?
  `).get(sessionId) as { cnt: number; min_idx: number; max_idx: number };

  const session: SessionInfo = {
    sessionId,
    totalMessages: msgStats.cnt,
    minIndex: msgStats.min_idx,
    maxIndex: msgStats.max_idx,
  };

  // 2. Index state
  const stateRow = db.prepare(
    "SELECT last_indexed_msg FROM index_state WHERE session_id = ?"
  ).get(sessionId) as { last_indexed_msg: number } | undefined;

  const lastIndexedMsg = stateRow?.last_indexed_msg ?? null;
  const effectiveIndexed = lastIndexedMsg !== null ? Math.min(lastIndexedMsg, session.totalMessages) : 0;
  const lagMsgs = Math.max(0, session.totalMessages - effectiveIndexed);
  const scanPct = session.totalMessages > 0
    ? Math.round((effectiveIndexed / session.totalMessages) * 1000) / 10
    : 100;

  // 3. Chunk sizing & distribution
  const chunkRows = db.prepare(`
    SELECT id, token_count, length(text) as char_len, text
    FROM chunks
    WHERE session_id = ?
    ORDER BY token_count ASC
  `).all(sessionId) as Array<{ id: number; token_count: number; char_len: number; text: string }>;

  const totalChunks = chunkRows.length;
  let minTokens = 0, maxTokens = 0, avgTokens = 0, p50Tokens = 0, p95Tokens = 0;
  let minChars = 0, maxChars = 0, avgChars = 0, p50Chars = 0, p95Chars = 0;
  let under1k = 0, from1kTo4k = 0, from4kTo8k = 0, over8k = 0;
  let gt16kChars = 0, gt8kTokens = 0;
  let loneSurrogates = 0;

  if (totalChunks > 0) {
    const tokensArr = chunkRows.map(r => r.token_count).sort((a, b) => a - b);
    const charsArr = chunkRows.map(r => r.char_len).sort((a, b) => a - b);

    minTokens = tokensArr[0];
    maxTokens = tokensArr[tokensArr.length - 1];
    avgTokens = Math.round(tokensArr.reduce((a, b) => a + b, 0) / totalChunks);
    p50Tokens = tokensArr[Math.floor(totalChunks * 0.5)];
    p95Tokens = tokensArr[Math.floor(totalChunks * 0.95)];

    minChars = charsArr[0];
    maxChars = charsArr[charsArr.length - 1];
    avgChars = Math.round(charsArr.reduce((a, b) => a + b, 0) / totalChunks);
    p50Chars = charsArr[Math.floor(totalChunks * 0.5)];
    p95Chars = charsArr[Math.floor(totalChunks * 0.95)];

    for (const r of chunkRows) {
      if (r.token_count < 1000) under1k++;
      else if (r.token_count <= 4000) from1kTo4k++;
      else if (r.token_count <= 8192) from4kTo8k++;
      else {
        over8k++;
        gt8kTokens++;
      }

      if (r.char_len > 16000) gt16kChars++;
      if (hasLoneSurrogates(r.text)) loneSurrogates++;
    }
  }

  const chunkStats: ChunkStats = {
    totalChunks,
    minTokens,
    maxTokens,
    avgTokens,
    p50Tokens,
    p95Tokens,
    minChars,
    maxChars,
    avgChars,
    p50Chars,
    p95Chars,
    buckets: { under1k, from1kTo4k, from4kTo8k, over8k },
    gt16kChars,
    gt8kTokens,
    loneSurrogates,
  };

  // 4. Vector Table Invariants for chunks -> vec_chunks
  const chunksVectorHealth = analyzeVirtualVecTable(db, "chunks", "vec_chunks", "id", sessionId);

  // 5. Vector Table Invariants for semantic_segments -> vec_segments
  // Only L0 leaf segments are vectorized; higher levels (L1, L2 rollup parents) are synthesized
  // summaries that are not embedded.
  const segmentsVectorHealth = analyzeVirtualVecTable(db, "semantic_segments", "vec_segments", "id", sessionId, "level = 0");

  // 6. True Vector Coverage & Blocker / Stalled tail analysis
  // True coverage requires both:
  // (a) messages have been scanned by index_state (scanPct)
  // (b) generated chunks actually have corresponding vectors in vec_chunks (vectorPct)
  const vectorPct = chunksVectorHealth.contentRows > 0
    ? Math.round(((chunksVectorHealth.contentRows - chunksVectorHealth.orphanContent) / chunksVectorHealth.contentRows) * 1000) / 10
    : (session.totalMessages === 0 ? 100 : 0);

  const coveragePct = Math.round((scanPct * (vectorPct / 100)) * 10) / 10;

  const blockers: StalledBlocker[] = [];
  if (lagMsgs > 0 && lastIndexedMsg !== null) {
    // Check candidate unindexed messages from lastIndexedMsg forward
    const unindexed = db.prepare(`
      SELECT msg_index, role, content, length(content) as len
      FROM messages
      WHERE session_id = ? AND msg_index >= ?
      ORDER BY msg_index ASC
      LIMIT 200
    `).all(sessionId, lastIndexedMsg) as Array<{ msg_index: number; role: string; content: string; len: number }>;

    if (unindexed.length > 0) {
      const firstUnindexedMsg = unindexed[0].msg_index;
      let firstUserMsg: number | null = null;
      for (const m of unindexed) {
        if (m.role === "user") {
          firstUserMsg = m.msg_index;
          break;
        }
      }

      // 1. Scan for individual oversized messages or lone surrogates across candidate unindexed window
      let worstMsg: StalledBlocker["largestMsg"] = null;
      let surrogateMsg: StalledBlocker["largestMsg"] = null;
      let totalCandidateChars = 0;

      for (const m of unindexed) {
        totalCandidateChars += m.len;
        const preview = m.content.replace(/\r?\n/g, " ").slice(0, 100);
        const hasSurr = hasLoneSurrogates(m.content);

        if (hasSurr && !surrogateMsg) {
          surrogateMsg = {
            index: m.msg_index,
            role: m.role,
            chars: m.len,
            preview,
            hasLoneSurrogate: true,
          };
        }

        if (!worstMsg || m.len > worstMsg.chars) {
          worstMsg = {
            index: m.msg_index,
            role: m.role,
            chars: m.len,
            preview,
            hasLoneSurrogate: hasSurr,
          };
        }
      }

      const totalEstTokens = Math.ceil(totalCandidateChars / 4);

      if (surrogateMsg) {
        blockers.push({
          firstUnindexedMsg,
          firstUserMsg,
          candidateSpanMsgs: unindexed.length,
          candidateChars: totalCandidateChars,
          candidateEstTokens: totalEstTokens,
          largestMsg: surrogateMsg,
          reason: "lone_surrogate",
          detail: `Msg ${surrogateMsg.index} (${surrogateMsg.role}, ${surrogateMsg.chars.toLocaleString()} chars) contains lone UTF-16 surrogates, triggering provider invalid_json error.`,
        });
      } else if (worstMsg && (worstMsg.chars > 30000 || totalEstTokens > 8192)) {
        blockers.push({
          firstUnindexedMsg,
          firstUserMsg,
          candidateSpanMsgs: unindexed.length,
          candidateChars: totalCandidateChars,
          candidateEstTokens: totalEstTokens,
          largestMsg: worstMsg,
          reason: "oversized_chunk",
          detail: `Unindexed tail contains oversized candidate (~${totalEstTokens.toLocaleString()} est tokens, msg ${worstMsg.index} is ${worstMsg.chars.toLocaleString()} chars, >8192 token limit). Triggers provider HTTP 400.`,
        });
      } else if (lagMsgs > 50) {
        blockers.push({
          firstUnindexedMsg,
          firstUserMsg,
          candidateSpanMsgs: unindexed.length,
          candidateChars: totalCandidateChars,
          candidateEstTokens: totalEstTokens,
          largestMsg: worstMsg,
          reason: "pending_tail",
          detail: `${lagMsgs.toLocaleString()} messages pending indexing since msg ${firstUnindexedMsg}.`,
        });
      }
    }
  }

  // 7. Deterministic Scoring
  // Baseline 100
  // Deductions:
  // - Lag percentage: up to -25 points
  // - Oversized chunks in DB (>8k tokens): -10 points each (max -20)
  // - Lone surrogates in DB: -10 points each (max -20)
  // - Vector table mismatch (orphans / ghost / dim mismatch): up to -25 points
  // - Stalled batch blockers: -20 points
  const scoreBreakdown: Record<string, number> = {};
  let score = 100;

  if (coveragePct < 95) {
    const lagPenalty = Math.min(25, Math.round((100 - coveragePct) * 0.5));
    if (lagPenalty > 0) {
      scoreBreakdown["lag"] = -lagPenalty;
      score -= lagPenalty;
    }
  }

  if (chunkStats.gt8kTokens > 0) {
    const p = Math.min(20, chunkStats.gt8kTokens * 10);
    scoreBreakdown["oversized_chunks"] = -p;
    score -= p;
  }

  if (chunkStats.loneSurrogates > 0) {
    const p = Math.min(20, chunkStats.loneSurrogates * 10);
    scoreBreakdown["lone_surrogates"] = -p;
    score -= p;
  }

  const vecDefects = chunksVectorHealth.orphanContent + chunksVectorHealth.ghostVectors + chunksVectorHealth.mismatchedDims
    + segmentsVectorHealth.orphanContent + segmentsVectorHealth.ghostVectors + segmentsVectorHealth.mismatchedDims;
  if (vecDefects > 0) {
    const p = Math.min(25, vecDefects * 5);
    scoreBreakdown["vector_invariants"] = -p;
    score -= p;
  }

  const activeStall = blockers.some(b => b.reason === "oversized_chunk" || b.reason === "lone_surrogate");
  if (activeStall) {
    scoreBreakdown["stalled_pipeline"] = -20;
    score -= 20;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    sessionId,
    session,
    recallState: {
      lastIndexedMsg,
      lagMsgs,
      coveragePct,
      scanPct,
    },
    chunkStats,
    chunksVectorHealth,
    segmentsVectorHealth,
    blockers,
    score,
    scoreBreakdown,
  };
}

function analyzeVirtualVecTable(
  db: Database.Database,
  contentTable: string,
  vecTable: string,
  idCol: string,
  sessionId: string,
  extraFilter?: string
): VectorTableHealth {
  // Check if vecTable exists
  const exists = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name=?").get(vecTable) as { c: number };
  if (!exists || exists.c === 0) {
    return {
      contentRows: 0,
      vectorRows: 0,
      orphanContent: 0,
      ghostVectors: 0,
      expectedDim: null,
      mismatchedDims: 0,
      sampleDims: null,
    };
  }

  // Content row count for this session
  const contentFilter = extraFilter
    ? `session_id = ? AND ${extraFilter}`
    : "session_id = ?";
  const cCount = db.prepare(`SELECT count(*) as c FROM ${contentTable} WHERE ${contentFilter}`).get(sessionId) as { c: number };

  // Sample vector dimension
  let sampleDims: number | null = null;
  let mismatchedDims = 0;
  let vectorRows = 0;

  try {
    const sample = db.prepare(`
      SELECT length(v.embedding) as len
      FROM ${vecTable} v
      JOIN ${contentTable} c ON c.${idCol} = v.rowid
      WHERE ${contentFilter}
      LIMIT 1
    `).get(sessionId) as { len: number } | undefined;

    if (sample && sample.len > 0) {
      sampleDims = Math.round(sample.len / 4);
    }

    const vStats = db.prepare(`
      SELECT count(*) as cnt, sum(case when length(v.embedding) != ? then 1 else 0 end) as mismatch
      FROM ${vecTable} v
      JOIN ${contentTable} c ON c.${idCol} = v.rowid
      WHERE ${contentFilter}
    `).get(sample ? sample.len : 0, sessionId) as { cnt: number; mismatch: number };

    vectorRows = vStats?.cnt ?? 0;
    mismatchedDims = vStats?.mismatch ?? 0;
  } catch {
    // sqlite-vec not loaded or query failed
  }

  // Orphan content: row in contentTable with no row in vecTable
  let orphanContent = 0;
  try {
    const o = db.prepare(`
      SELECT count(*) as cnt
      FROM ${contentTable} c
      LEFT JOIN ${vecTable} v ON v.rowid = c.${idCol}
      WHERE ${contentFilter} AND v.rowid IS NULL
    `).get(sessionId) as { cnt: number };
    orphanContent = o?.cnt ?? 0;
  } catch {
    // If querying vecTable fails (e.g. extension not loaded or module error),
    // treat all content rows as lacking verified vectors instead of reporting 0 orphans
    orphanContent = cCount.c;
  }

  // Ghost vectors: row in vecTable whose rowid does not exist in contentTable
  let ghostVectors = 0;
  try {
    const g = db.prepare(`
      SELECT count(*) as cnt
      FROM ${vecTable} v
      LEFT JOIN ${contentTable} c ON c.${idCol} = v.rowid AND ${contentFilter}
      WHERE c.${idCol} IS NULL
    `).get(sessionId) as { cnt: number };
    ghostVectors = g?.cnt ?? 0;
  } catch {
    // ignore
  }

  return {
    contentRows: cCount.c,
    vectorRows,
    orphanContent,
    ghostVectors,
    expectedDim: sampleDims,
    mismatchedDims,
    sampleDims,
  };
}

function pad(val: string | number, len: number, right = false): string {
  const s = String(val);
  return right ? s.padStart(len) : s.padEnd(len);
}

export function formatRecallHealthReport(r: RecallHealthReport, opts: { limit?: number; color?: boolean } = {}): string {
  const limit = opts.limit ?? 10;
  const color = opts.color ?? true;
  const c = {
    reset: color ? "\x1b[0m" : "",
    bold: color ? "\x1b[1m" : "",
    dim: color ? "\x1b[90m" : "",
    green: color ? "\x1b[32m" : "",
    red: color ? "\x1b[31m" : "",
    yellow: color ? "\x1b[33m" : "",
    blue: color ? "\x1b[34m" : "",
    cyan: color ? "\x1b[36m" : "",
    magenta: color ? "\x1b[35m" : "",
  };

  const out: string[] = [];

  const dimStr = r.chunksVectorHealth.expectedDim ? `${r.chunksVectorHealth.expectedDim} dims` : "unknown dims";
  out.push(
    `${c.blue}${c.bold}Session ${r.sessionId.slice(0, 8)}${c.reset}  messages ${r.session.minIndex}–${r.session.maxIndex} (${r.session.totalMessages.toLocaleString()} msgs)  ` +
    `scanned to ${c.cyan}${r.recallState.lastIndexedMsg ?? "—"}${c.reset}` +
    (r.recallState.lagMsgs > 0 ? ` (${c.yellow}lag ${r.recallState.lagMsgs.toLocaleString()} msgs${c.reset}, ${100 - r.recallState.scanPct}% unscanned)` : ` (${c.green}100% scanned${c.reset})`)
  );
  out.push(`Vector Table: sqlite-vec (${c.magenta}${dimStr}${c.reset})`);
  out.push("");

  // Targets summary table
  const hdr = [
    pad("Target", 18),
    pad("Rows", 8, true),
    pad("Indexed", 8, true),
    pad("Vectors", 8, true),
    pad("Orphan", 7, true),
    pad("Ghost", 6, true),
    pad("Gt8k", 6, true),
    pad("Gt16k", 6, true),
    pad("Surr", 5, true),
    "  Coverage",
  ];
  out.push(`${c.dim}${hdr.join(" ")}${c.reset}`);

  const cLagStr = r.recallState.lagMsgs > 0 ? `, ${r.recallState.lagMsgs.toLocaleString()} msgs gapped` : "";
  const orphanCol = r.chunksVectorHealth.orphanContent > 0 ? c.red : c.reset;
  const ghostCol = r.chunksVectorHealth.ghostVectors > 0 ? c.red : c.reset;
  const gt8kCol = r.chunkStats.gt8kTokens > 0 ? c.yellow : c.reset;
  const gt16kCol = r.chunkStats.gt16kChars > 0 ? c.red : c.reset;
  const surrCol = r.chunkStats.loneSurrogates > 0 ? c.red : c.reset;
  const covCol = r.recallState.coveragePct >= 99 ? c.green : r.recallState.coveragePct >= 90 ? c.yellow : c.red;

  out.push([
    pad("Chunks", 18),
    pad(r.chunkStats.totalChunks.toLocaleString(), 8, true),
    pad(r.recallState.lastIndexedMsg ?? 0, 8, true),
    pad(r.chunksVectorHealth.vectorRows.toLocaleString(), 8, true),
    orphanCol + pad(r.chunksVectorHealth.orphanContent, 7, true) + c.reset,
    ghostCol + pad(r.chunksVectorHealth.ghostVectors, 6, true) + c.reset,
    gt8kCol + pad(r.chunkStats.gt8kTokens, 6, true) + c.reset,
    gt16kCol + pad(r.chunkStats.gt16kChars, 6, true) + c.reset,
    surrCol + pad(r.chunkStats.loneSurrogates, 5, true) + c.reset,
    `  ${covCol}${r.recallState.coveragePct}%${cLagStr}${c.reset}`,
  ].join(" "));

  const segCovPct = r.segmentsVectorHealth.contentRows > 0
    ? Math.round(((r.segmentsVectorHealth.contentRows - r.segmentsVectorHealth.orphanContent) / r.segmentsVectorHealth.contentRows) * 1000) / 10
    : 100;
  const segCovCol = segCovPct >= 99 ? c.green : segCovPct >= 90 ? c.yellow : c.red;
  const segOrphanCol = r.segmentsVectorHealth.orphanContent > 0 ? c.red : c.reset;
  const segGhostCol = r.segmentsVectorHealth.ghostVectors > 0 ? c.red : c.reset;

  out.push([
    pad("Segment Leaves (L0)", 18),
    pad(r.segmentsVectorHealth.contentRows.toLocaleString(), 8, true),
    pad(r.segmentsVectorHealth.contentRows.toLocaleString(), 8, true),
    pad(r.segmentsVectorHealth.vectorRows.toLocaleString(), 8, true),
    segOrphanCol + pad(r.segmentsVectorHealth.orphanContent, 7, true) + c.reset,
    segGhostCol + pad(r.segmentsVectorHealth.ghostVectors, 6, true) + c.reset,
    pad(0, 6, true),
    pad(0, 6, true),
    pad(0, 5, true),
    `  ${segCovCol}${segCovPct}% (L0 vector coverage)${c.reset}`,
  ].join(" "));
  out.push("");

  // Sizing distributions
  out.push(`${c.bold}Chunk Size Distribution:${c.reset}`);
  out.push(
    `  Tokens:      min ${r.chunkStats.minTokens} · p50 ${r.chunkStats.p50Tokens} · p95 ${r.chunkStats.p95Tokens} · max ${r.chunkStats.maxTokens.toLocaleString()} · avg ${r.chunkStats.avgTokens}`
  );
  out.push(
    `  Characters:  min ${r.chunkStats.minChars} · p50 ${r.chunkStats.p50Chars.toLocaleString()} · p95 ${r.chunkStats.p95Chars.toLocaleString()} · max ${r.chunkStats.maxChars.toLocaleString()} · avg ${r.chunkStats.avgChars.toLocaleString()}`
  );
  const b = r.chunkStats.buckets;
  const tot = Math.max(1, r.chunkStats.totalChunks);
  const pUnder = ((b.under1k / tot) * 100).toFixed(1);
  const p1to4 = ((b.from1kTo4k / tot) * 100).toFixed(1);
  const p4to8 = ((b.from4kTo8k / tot) * 100).toFixed(1);
  const pOver = ((b.over8k / tot) * 100).toFixed(1);
  out.push(
    `  Size buckets:  <1k tok: ${b.under1k.toLocaleString()} (${pUnder}%) · 1k–4k: ${b.from1kTo4k.toLocaleString()} (${p1to4}%) · 4k–8k: ${b.from4kTo8k.toLocaleString()} (${p4to8}%) · >8k: ${b.over8k > 0 ? c.yellow : ""}${b.over8k.toLocaleString()} (${pOver}%)${c.reset}`
  );
  out.push("");

  // Blockers & Stalls
  if (r.blockers.length > 0) {
    out.push(`${c.red}${c.bold}Blockers & Pipeline Stalls (${r.blockers.length}):${c.reset}`);
    for (const blk of r.blockers.slice(0, limit)) {
      const tag = blk.reason === "oversized_chunk" ? `${c.red}STALL (oversized chunk)${c.reset}`
        : blk.reason === "lone_surrogate" ? `${c.red}STALL (lone surrogate)${c.reset}`
        : `${c.yellow}PENDING TAIL${c.reset}`;
      out.push(`  ✦ ${tag} at msg ${c.bold}${blk.firstUnindexedMsg}${c.reset}:`);
      out.push(`    Candidate span: ${blk.candidateSpanMsgs} msgs (${blk.candidateChars.toLocaleString()} chars, ~${blk.candidateEstTokens.toLocaleString()} est tokens)`);
      if (blk.largestMsg) {
        out.push(`    Largest: msg ${blk.largestMsg.index} (${blk.largestMsg.role}, ${c.yellow}${blk.largestMsg.chars.toLocaleString()} chars${c.reset}) — "${blk.largestMsg.preview}..."`);
      }
      out.push(`    Detail: ${blk.detail}`);
    }
    out.push("");
  } else {
    out.push(`Blockers: ${c.green}None (indexing pipeline is moving cleanly)${c.reset}`);
    out.push("");
  }

  // Vector table invariants
  out.push(`${c.bold}Vector Invariants:${c.reset}`);
  const cMismatch = r.chunksVectorHealth.mismatchedDims + r.segmentsVectorHealth.mismatchedDims;
  const cOrphan = r.chunksVectorHealth.orphanContent + r.segmentsVectorHealth.orphanContent;
  const cGhost = r.chunksVectorHealth.ghostVectors + r.segmentsVectorHealth.ghostVectors;

  out.push(`  Vector dimensions: ${dimStr} across all rows (${cMismatch > 0 ? c.red : c.green}${cMismatch} mismatched dims${c.reset})`);
  out.push(`  Orphan content (chunks without vectors): ${cOrphan > 0 ? c.red : c.green}${cOrphan}${c.reset}`);
  out.push(`  Ghost vectors (vectors without chunks): ${cGhost > 0 ? c.red : c.green}${cGhost}${c.reset}`);
  out.push(`  Surrogate pair anomalies in chunks: ${r.chunkStats.loneSurrogates > 0 ? c.red : c.green}${r.chunkStats.loneSurrogates}${c.reset}`);
  out.push("");

  // Score
  const bd = Object.entries(r.scoreBreakdown).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v}`).join(", ");
  const scoreCol = r.score >= 90 ? c.green : r.score >= 70 ? c.yellow : c.red;
  out.push(`Health: ${scoreCol}${c.bold}${r.score}/100${c.reset}${bd ? `  (${c.dim}${bd}${c.reset})` : ""}`);

  return out.join("\n");
}
