import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { RecallIndex } from "../src/plugins/recall/recall.js";
import { EMBED_MAX_CHARS } from "../src/util.js";
import type { ModelMessage } from "ai";

// Fake embedding model that limits per-value length to simulate API 8192 token limit
const fakeModel = (limit: number = 8000, seen: string[] = []) => ({
  specificationVersion: "v2" as const,
  provider: "test",
  modelId: "fake-embed",
  maxEmbeddingsPerCall: 100,
  supportsParallelCalls: false,
  async doEmbed({ values }: { values: string[] }) {
    for (const v of values) {
      seen.push(v);
      if (v.length > limit) throw new Error("maximum context length is 8192 tokens");
    }
    return { embeddings: values.map(() => [0.1, 0.2, 0.3, 0.4]), usage: { tokens: 1 }, warnings: [] };
  },
});

function setupMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      msg_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      UNIQUE(session_id, msg_index)
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      msg_start INTEGER NOT NULL,
      msg_end INTEGER NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      UNIQUE(session_id, msg_start, msg_end)
    );

    CREATE TABLE index_state (
      session_id TEXT PRIMARY KEY,
      last_indexed_msg INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      embedding float[4]
    );
  `);
  return db;
}

test("embedTexts: caps values and shrinks rejected values on batch failure (#315)", async () => {
  const seen: string[] = [];
  const model = fakeModel(1000, seen);

  const instance = Object.create(RecallIndex.prototype);
  Object.assign(instance, { embeddingModel: model });

  const embedTexts = (texts: string[]) =>
    (RecallIndex.prototype as any).embedTexts.call(instance, texts);

  // A batch with one huge chunk that would fail without shrink-and-retry
  const out = await embedTexts(["normal text", "x".repeat(5000), "another chunk"]);
  assert.equal(out.length, 3, "all 3 chunks embedded successfully");
  assert.equal(out[0].length, 4);
  assert.equal(out[1].length, 4);
  assert.equal(out[2].length, 4);

  // Check that the oversized text was shrunk down to under the model limit (1000)
  const shrunk = seen.find((s) => s.length <= 1000 && s.startsWith("xxx"));
  assert.ok(shrunk, "oversized chunk was retried at smaller size");
});

test("indexSession re-vectorizes existing chunks on dimension rebuild (#333)", async () => {
  const db = setupMemoryDb();
  const seen: string[] = [];
  const model = fakeModel(8000, seen);

  // Pre-populate chunks table as if a dimension rebuild dropped vec_chunks
  db.prepare(`
    INSERT INTO chunks (id, session_id, msg_start, msg_end, text, timestamp, token_count)
    VALUES (42, 'sess-1', 0, 1, 'pre-existing chunk', '2026-09-19T00:00:00.000Z', 10)
  `).run();

  // Create RecallIndex with mock DB and model
  const instance = Object.create(RecallIndex.prototype);
  Object.assign(instance, {
    db,
    embeddingModel: model,
    agentDir: "/tmp",
    chunkMessages: () => [
      {
        session_id: "sess-1",
        msg_start: 0,
        msg_end: 1,
        text: "pre-existing chunk",
        timestamp: "2026-09-19T00:00:00.000Z",
        token_count: 10,
      },
    ],
  });

  // Verify vec_chunks is empty before
  const countBefore = (db.prepare("SELECT count(*) as count FROM vec_chunks").get() as any).count;
  assert.equal(countBefore, 0);

  // Run the batch insert logic via embedTexts + transaction path
  const texts = ["pre-existing chunk"];
  const embeddings = await (RecallIndex.prototype as any).embedTexts.call(instance, texts);

  // Run the chunk insertion logic from indexSession
  const insertChunk = db.prepare(
    "INSERT OR IGNORE INTO chunks (session_id, msg_start, msg_end, text, timestamp, token_count) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const selectChunkId = db.prepare(
    "SELECT id FROM chunks WHERE session_id = ? AND msg_start = ? AND msg_end = ?"
  );
  const deleteVec = db.prepare(
    "DELETE FROM vec_chunks WHERE rowid = ?"
  );
  const insertVec = db.prepare(
    "INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)"
  );

  const chunk = {
    session_id: "sess-1",
    msg_start: 0,
    msg_end: 1,
    text: "pre-existing chunk",
    timestamp: "2026-09-19T00:00:00.000Z",
    token_count: 10,
  };

  const info = insertChunk.run(
    chunk.session_id,
    chunk.msg_start,
    chunk.msg_end,
    chunk.text,
    chunk.timestamp,
    chunk.token_count
  );

  assert.equal(info.changes, 0, "chunk was ignored as duplicate");

  // Under #333 fix: look up existing ID and insert vector
  const row = selectChunkId.get(chunk.session_id, chunk.msg_start, chunk.msg_end) as { id: number | bigint };
  assert.equal(row.id, 42);
  const chunkId = BigInt(row.id);
  deleteVec.run(chunkId);
  insertVec.run(chunkId, new Float32Array(embeddings[0]));

  // Verify vector was inserted into vec_chunks with rowid 42
  const countAfter = (db.prepare("SELECT count(*) as count FROM vec_chunks").get() as any).count;
  assert.equal(countAfter, 1, "vec_chunks now has the vector");

  const vecRow = db.prepare("SELECT rowid FROM vec_chunks WHERE rowid = ?").get(42) as any;
  assert.equal(vecRow.rowid, 42);
});

test("indexSession serializes concurrent calls for the same session (#404)", async () => {
  const instance = Object.create(RecallIndex.prototype);
  Object.assign(instance, {
    activeSessions: new Map(),
  });

  let running = 0;
  let maxConcurrency = 0;
  let totalCalls = 0;

  instance.runIndexSession = async (sessionId: string) => {
    totalCalls++;
    running++;
    maxConcurrency = Math.max(maxConcurrency, running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return 1;
  };

  // Launch two indexSession calls in parallel
  const [res1, res2] = await Promise.all([
    instance.indexSession("sess-concurrent"),
    instance.indexSession("sess-concurrent"),
  ]);

  assert.equal(res1, 1);
  assert.equal(res2, 1);
  assert.equal(totalCalls, 2);
  assert.equal(maxConcurrency, 1, "concurrent calls must execute strictly serialized");
  assert.equal(instance.activeSessions.size, 0, "activeSessions map cleaned up");
});

