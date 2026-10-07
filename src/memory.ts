import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { join } from "path";
import { log } from "./log.js";
import { embed } from "ai";
import { createEmbeddingModel, resolveEmbeddingModel, embeddingFingerprint } from "./model.js";
import type { KernConfig } from "./config.js";

export interface EmbeddingProfile {
  dimensions: number;
  fingerprint: string;
}

/**
 * Central database for agent memory.
 * Owns .kern/recall.db — all tables, schema migrations.
 * Consumers (recall, notes) use the exposed db handle.
 */
export class MemoryDB {
  public db: Database.Database;
  public readonly embeddingsReady: boolean;
  private embeddingProfile: EmbeddingProfile | null;

  constructor(agentDir: string, profile: EmbeddingProfile | null = null) {
    const dbPath = join(agentDir, ".kern", "recall.db");
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.embeddingProfile = profile;
    this.embeddingsReady = profile !== null;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        msg_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT,
        UNIQUE(session_id, msg_index)
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        msg_start INTEGER NOT NULL,
        msg_end INTEGER NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        UNIQUE(session_id, msg_start, msg_end)
      );

      CREATE TABLE IF NOT EXISTS index_state (
        session_id TEXT PRIMARY KEY,
        last_indexed_msg INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        date_start TEXT NOT NULL,
        date_end TEXT NOT NULL,
        source_key TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(type, source_key)
      );

      CREATE TABLE IF NOT EXISTS semantic_segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        msg_start INTEGER NOT NULL,
        msg_end INTEGER NOT NULL,
        start_time TEXT,
        end_time TEXT,
        parent_id INTEGER REFERENCES semantic_segments(id),
        level INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        summarized INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS segment_state (
        session_id TEXT PRIMARY KEY,
        last_segmented_msg INTEGER NOT NULL
      );
    `);

    // Indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_segments_session_level ON semantic_segments(session_id, level, msg_start);
      CREATE INDEX IF NOT EXISTS idx_segments_parent ON semantic_segments(parent_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_unique ON semantic_segments(session_id, level, msg_start, msg_end);
    `);

    // Media table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        file TEXT NOT NULL,
        originalName TEXT,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        description TEXT,
        describedBy TEXT,
        timestamp TEXT NOT NULL,
        UNIQUE(session_id, file)
      );
    `);

    // Migrations — add columns to existing tables
    try { this.db.exec("ALTER TABLE semantic_segments ADD COLUMN start_time TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE semantic_segments ADD COLUMN end_time TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE semantic_segments ADD COLUMN summary_token_count INTEGER NOT NULL DEFAULT 0"); } catch {}

    // Create or migrate vec tables
    this.initVecTables();
  }

  /** Only a successful probe can create or replace vectors. Failed/offline startup is read-only here. */
  private initVecTables(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS embedding_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), fingerprint TEXT NOT NULL, dimensions INTEGER NOT NULL)");
    if (!this.embeddingProfile) return;
    const { dimensions, fingerprint } = this.embeddingProfile;
    if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("Invalid embedding dimensions");
    const previous = this.db.prepare("SELECT fingerprint FROM embedding_metadata WHERE id = 1").get() as { fingerprint: string } | undefined;
    const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_chunks'").get();
    this.db.transaction(() => {
      // Unidentified legacy vectors are rebuilt once, after successful validation.
      if (existing && previous?.fingerprint !== fingerprint) {
        log.warn("memory", "Embedding identity changed — rebuilding vectors, preserving messages and summary tree");
        this.db.exec("DROP TABLE IF EXISTS vec_chunks; DROP TABLE IF EXISTS vec_segments;");
        // Keep both cursors: backfill restores vectors, tail indexing handles new history.
      }
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_chunks'").get()) {
        this.db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding FLOAT[${dimensions}])`);
      }
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'vec_segments'").get()) {
        this.db.exec(`CREATE VIRTUAL TABLE vec_segments USING vec0(embedding FLOAT[${dimensions}])`);
      }
      this.db.prepare("INSERT OR REPLACE INTO embedding_metadata (id, fingerprint, dimensions) VALUES (1, ?, ?)").run(fingerprint, dimensions);
    })();
  }

  static async probeEmbeddingModel(config: KernConfig): Promise<EmbeddingProfile | null> {
    const ref = resolveEmbeddingModel(config);
    if (!ref) return null;
    try {
      const model = createEmbeddingModel(config)!;
      const result = await embed({ model, value: "dimension probe", maxRetries: 0, abortSignal: AbortSignal.timeout(10_000) });
      const dimensions = result.embedding.length;
      if (!dimensions || !result.embedding.every(Number.isFinite)) throw new Error("Embedding endpoint returned an invalid vector");
      if (ref.dimensions !== undefined && ref.dimensions !== dimensions) throw new Error(`Requested ${ref.dimensions} dimensions, received ${dimensions}`);
      log("memory", `Embedding validated: ${ref.model} @ ${ref.baseURL}, ${dimensions} dimensions`);
      return { dimensions, fingerprint: embeddingFingerprint(ref, dimensions) };
    } catch (err: any) {
      log.warn("memory", `Embedding unavailable: ${ref.model} @ ${ref.baseURL}: ${err.message} — existing vectors preserved; restart after fixing the connection`);
      return null;
    }
  }

  // --- Summary helpers ---

  getSummary(type: string, sourceKey: string): string | null {
    const row = this.db.prepare(
      "SELECT text FROM summaries WHERE type = ? AND source_key = ?"
    ).get(type, sourceKey) as { text: string } | undefined;
    return row?.text ?? null;
  }

  getLatestSummary(type: string): { source_key: string; text: string } | null {
    const row = this.db.prepare(
      "SELECT source_key, text FROM summaries WHERE type = ? ORDER BY id DESC LIMIT 1"
    ).get(type) as { source_key: string; text: string } | undefined;
    return row ?? null;
  }

  saveSummary(type: string, dateStart: string, dateEnd: string, sourceKey: string, text: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO summaries (type, date_start, date_end, source_key, text) VALUES (?, ?, ?, ?, ?)"
    ).run(type, dateStart, dateEnd, sourceKey, text);
  }

  // --- Session stats ---

  getSessionList(): Array<{ session_id: string; messages: number; first_ts: string | null; last_ts: string | null; roles: Record<string, number> }> {
    const rows = this.db.prepare(`
      SELECT session_id, COUNT(*) as messages,
        MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
      FROM messages GROUP BY session_id ORDER BY first_ts
    `).all() as Array<{ session_id: string; messages: number; first_ts: string | null; last_ts: string | null }>;

    return rows.map(r => {
      const roleRows = this.db.prepare(
        "SELECT role, COUNT(*) as count FROM messages WHERE session_id = ? GROUP BY role"
      ).all(r.session_id) as Array<{ role: string; count: number }>;
      const roles: Record<string, number> = {};
      for (const rr of roleRows) roles[rr.role] = rr.count;
      return { ...r, roles };
    });
  }

  getSessionActivity(sessionId: string): Array<{ date: string; count: number }> {
    return this.db.prepare(`
      SELECT DATE(timestamp) as date, COUNT(*) as count
      FROM messages
      WHERE session_id = ? AND timestamp IS NOT NULL
      GROUP BY DATE(timestamp)
      ORDER BY date
    `).all(sessionId) as Array<{ date: string; count: number }>;
  }

  getSessionHourlyActivity(sessionId: string): Array<{ hour: number; count: number }> {
    return this.db.prepare(`
      SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
      FROM messages
      WHERE session_id = ? AND timestamp IS NOT NULL
      GROUP BY hour ORDER BY hour
    `).all(sessionId) as Array<{ hour: number; count: number }>;
  }

  getAllSummaries(type?: string): Array<{ id: number; type: string; date_start: string; date_end: string; source_key: string; text: string; created_at: string }> {
    if (type) {
      return this.db.prepare(
        "SELECT id, type, date_start, date_end, source_key, text, created_at FROM summaries WHERE type = ? ORDER BY id DESC"
      ).all(type) as any[];
    }
    return this.db.prepare(
      "SELECT id, type, date_start, date_end, source_key, text, created_at FROM summaries ORDER BY id DESC"
    ).all() as any[];
  }

  getMediaList(): Array<{ file: string; originalName: string | null; mimeType: string; size: number; description: string | null; describedBy: string | null; timestamp: string; session_id: string }> {
    return this.db.prepare(
      "SELECT file, originalName, mimeType, size, description, describedBy, timestamp, session_id FROM media ORDER BY timestamp DESC"
    ).all() as any[];
  }

  getMediaStats(): { total: number; images: number; digested: number; totalSize: number } {
    const total = (this.db.prepare("SELECT COUNT(*) as c FROM media").get() as any).c;
    const images = (this.db.prepare("SELECT COUNT(*) as c FROM media WHERE mimeType LIKE 'image/%'").get() as any).c;
    const digested = (this.db.prepare("SELECT COUNT(*) as c FROM media WHERE description IS NOT NULL AND description != ''").get() as any).c;
    const totalSize = (this.db.prepare("SELECT COALESCE(SUM(size), 0) as s FROM media").get() as any).s;
    return { total, images, digested, totalSize };
  }

  close(): void {
    this.db.close();
  }
}
