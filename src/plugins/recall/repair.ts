/**
 * Recall Repair Engine.
 *
 * Inspects and repairs recall index deficiencies (orphaned chunks, missing vectors).
 * Pure analysis via planRecallRepair(), transactional execution via applyRecallRepair().
 *
 * Guaranteed:
 *  1. Zero-op if already healthy (0 API calls, 0 DB writes).
 *  2. Embeds only chunks that lack rows in vec_chunks.
 *  3. Caps input text and shrinks/retries on batch failures.
 *  4. Transactional batch inserts into vec_chunks.
 */

import type Database from "better-sqlite3";
import { embed, embedMany } from "ai";
import { capForEmbedding, EMBED_MAX_CHARS } from "../../util.js";
import { createEmbeddingModel } from "../../model.js";
import type { KernConfig } from "../../config.js";

const EMBED_BATCH_SIZE = 100;
const EMBED_MIN_CHARS = 500;

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
  estBatches: number;
  totalChars: number;
}

export interface RepairProgress {
  batch: number;
  totalBatches: number;
  chunksInBatch: number;
  vectorsInserted: number;
}

export interface RepairResult {
  vectorsInserted: number;
  totalVectors: number;
  totalChunks: number;
  coveragePct: number;
  elapsedMs: number;
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

  const totalChars = orphans.reduce((sum, c) => sum + (c.text?.length || 0), 0);
  const estBatches = Math.ceil(orphans.length / EMBED_BATCH_SIZE);
  const isClean = orphans.length === 0 && tailLag === 0;

  return {
    sessionId,
    totalChunks,
    vectorChunks,
    orphanChunks: orphans,
    totalMessages,
    lastIndexedMsg,
    tailLag,
    isClean,
    estBatches,
    totalChars,
  };
}

/**
 * Apply the repair plan by embedding orphaned chunks and inserting into vec_chunks.
 */
export async function applyRecallRepair(
  db: Database.Database,
  config: KernConfig,
  plan: RecallRepairPlan,
  onProgress?: (p: RepairProgress) => void
): Promise<RepairResult> {
  const start = Date.now();
  if (plan.orphanChunks.length === 0) {
    return {
      vectorsInserted: 0,
      totalVectors: plan.vectorChunks,
      totalChunks: plan.totalChunks,
      coveragePct: plan.totalChunks > 0 ? (plan.vectorChunks / plan.totalChunks) * 100 : 100,
      elapsedMs: Date.now() - start,
    };
  }

  const model = createEmbeddingModel(config);
  if (!model) {
    throw new Error("No embedding model available (need OPENROUTER_API_KEY, OPENAI_API_KEY, or Ollama provider)");
  }

  const insertVec = db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");
  const deleteVec = db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");

  let vectorsInserted = 0;
  const totalBatches = plan.estBatches;

  for (let b = 0; b < plan.orphanChunks.length; b += EMBED_BATCH_SIZE) {
    const batchChunks = plan.orphanChunks.slice(b, b + EMBED_BATCH_SIZE);
    const batchTexts = batchChunks.map((c) => capForEmbedding(c.text));

    let embeddings: number[][];
    try {
      const result = await embedMany({ model, values: batchTexts });
      embeddings = result.embeddings;
    } catch {
      // Retry values individually with halving fallback
      embeddings = [];
      for (const val of batchTexts) {
        embeddings.push(await embedOne(model, val));
      }
    }

    // Insert batch transactionally
    const tx = db.transaction(() => {
      for (let i = 0; i < batchChunks.length; i++) {
        const chunk = batchChunks[i];
        const emb = embeddings[i];
        const rowid = typeof chunk.id === "bigint" ? chunk.id : BigInt(chunk.id);
        deleteVec.run(rowid);
        insertVec.run(rowid, new Float32Array(emb));
        vectorsInserted++;
      }
    });
    tx();

    if (onProgress) {
      onProgress({
        batch: Math.floor(b / EMBED_BATCH_SIZE) + 1,
        totalBatches,
        chunksInBatch: batchChunks.length,
        vectorsInserted,
      });
    }
  }

  const finalVectors = plan.vectorChunks + vectorsInserted;
  return {
    vectorsInserted,
    totalVectors: finalVectors,
    totalChunks: plan.totalChunks,
    coveragePct: plan.totalChunks > 0 ? (finalVectors / plan.totalChunks) * 100 : 100,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Embed a single value with halving fallback.
 */
async function embedOne(model: Parameters<typeof embed>[0]["model"], value: string): Promise<number[]> {
  let chars = Math.min(value.length, EMBED_MAX_CHARS);
  for (;;) {
    try {
      const { embedding } = await embed({
        model,
        value: capForEmbedding(value, chars),
      });
      return embedding;
    } catch (err: any) {
      if (chars <= EMBED_MIN_CHARS) throw err;
      chars = Math.max(EMBED_MIN_CHARS, Math.floor(chars / 2));
    }
  }
}
