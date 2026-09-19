/**
 * Recall Repair Engine.
 *
 * Recovery for recall.db instances that have orphaned chunks (chunks lacking rows
 * in vec_chunks, e.g. following an embedding dimension change).
 *
 * Strictly follows the segment-prune philosophy (pure SQLite, zero LLM calls):
 *  1. Inspects chunks vs vec_chunks.
 *  2. If 100% vector coverage and 0 lag, returns isClean: true (zero-op, 0 writes).
 *  3. On apply, deletes orphaned chunks from `chunks` and resets `index_state.last_indexed_msg`
 *     to the earliest missing chunk start (or 0 if all chunks were orphans).
 *  4. On next agent start or turn, the agent's native recallIndex.indexSession() picks up
 *     from the reset cursor, re-chunking and re-embedding cleanly in the background.
 *
 * planRecallRepair() is pure inspection; applyRecallRepair() runs in one SQLite transaction.
 */

import type Database from "better-sqlite3";

export interface OrphanChunk {
  id: number;
  session_id: string;
  msg_start: number;
  msg_end: number;
  text: string;
  token_count: number;
}

export interface RecallRepairPlan {
  sessionId: string;
  totalChunks: number;
  vectorChunks: number;
  orphanChunks: OrphanChunk[];
  totalMessages: number;
  lastIndexedMsg: number | null;
  tailLag: number;
  isClean: boolean;
  earliestOrphanStart: number | null;
  resetCursorTo: number;
}

export interface RepairResult {
  deletedChunks: number;
  resetCursorTo: number;
  previousCursor: number | null;
}

/**
 * Plan repair by inspecting chunks vs vec_chunks for a session.
 * Pure inspection over SQLite: never writes.
 */
export function planRecallRepair(db: Database.Database, sessionId: string): RecallRepairPlan {
  // Total chunks in chunks table
  const countRow = db.prepare(
    "SELECT count(*) as cnt FROM chunks WHERE session_id = ?"
  ).get(sessionId) as { cnt: number };
  const totalChunks = countRow.cnt;

  // Vector count via vec_chunks JOIN
  let vectorChunks = 0;
  let orphans: OrphanChunk[] = [];

  try {
    const vecRow = db.prepare(`
      SELECT count(v.rowid) as cnt
      FROM chunks c
      JOIN vec_chunks v ON v.rowid = c.id
      WHERE c.session_id = ?
    `).get(sessionId) as { cnt: number };
    vectorChunks = vecRow.cnt;

    // Find orphaned chunks lacking vec_chunks rows
    orphans = db.prepare(`
      SELECT c.id, c.session_id, c.msg_start, c.msg_end, c.text, c.token_count
      FROM chunks c
      LEFT JOIN vec_chunks v ON v.rowid = c.id
      WHERE c.session_id = ? AND v.rowid IS NULL
      ORDER BY c.id ASC
    `).all(sessionId) as OrphanChunk[];
  } catch {
    // If vec_chunks doesn't exist or isn't loaded, all chunks are effectively orphans
    orphans = db.prepare(`
      SELECT id, session_id, msg_start, msg_end, text, token_count
      FROM chunks
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId) as OrphanChunk[];
  }

  // Scan state vs messages count
  const stateRow = db.prepare(
    "SELECT last_indexed_msg FROM index_state WHERE session_id = ?"
  ).get(sessionId) as { last_indexed_msg: number } | undefined;
  const lastIndexedMsg = stateRow?.last_indexed_msg ?? null;

  const msgCountRow = db.prepare(
    "SELECT count(*) as cnt FROM messages WHERE session_id = ?"
  ).get(sessionId) as { cnt: number };
  const totalMessages = msgCountRow.cnt;
  const tailLag = lastIndexedMsg !== null ? Math.max(0, totalMessages - lastIndexedMsg) : totalMessages;

  const isClean = orphans.length === 0 && tailLag === 0;

  let earliestOrphanStart: number | null = null;
  if (orphans.length > 0) {
    earliestOrphanStart = Math.min(...orphans.map((o) => o.msg_start));
  }

  // If there are orphaned chunks, reset cursor to earliest missing position
  // so the agent's indexSession resumes from there on boot.
  // If no orphans, keep existing lastIndexedMsg or 0.
  const resetCursorTo = earliestOrphanStart !== null ? earliestOrphanStart : (lastIndexedMsg ?? 0);

  return {
    sessionId,
    totalChunks,
    vectorChunks,
    orphanChunks: orphans,
    totalMessages,
    lastIndexedMsg,
    tailLag,
    isClean,
    earliestOrphanStart,
    resetCursorTo,
  };
}

/**
 * Apply the repair plan purely within SQLite (zero LLM calls):
 *  - Deletes orphaned chunk rows from `chunks`.
 *  - Resets `index_state.last_indexed_msg` to `resetCursorTo`.
 *
 * On next agent restart or turn, indexSession() re-indexes missing messages cleanly.
 */
export function applyRecallRepair(db: Database.Database, plan: RecallRepairPlan): RepairResult {
  if (plan.isClean || plan.orphanChunks.length === 0) {
    return {
      deletedChunks: 0,
      resetCursorTo: plan.lastIndexedMsg ?? 0,
      previousCursor: plan.lastIndexedMsg,
    };
  }

  const deleteChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
  const updateState = db.prepare(
    "INSERT OR REPLACE INTO index_state (session_id, last_indexed_msg) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    for (const chunk of plan.orphanChunks) {
      deleteChunk.run(chunk.id);
    }
    updateState.run(plan.sessionId, plan.resetCursorTo);
  });
  tx();

  return {
    deletedChunks: plan.orphanChunks.length,
    resetCursorTo: plan.resetCursorTo,
    previousCursor: plan.lastIndexedMsg,
  };
}
