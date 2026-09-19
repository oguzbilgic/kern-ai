import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { analyzeRecallHealth, formatRecallHealthReport, listRecallSessions } from "../src/plugins/recall/health.js";

function setupTestDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE messages (
      session_id TEXT,
      msg_index INTEGER,
      role TEXT,
      content TEXT,
      timestamp TEXT,
      PRIMARY KEY (session_id, msg_index)
    );

    CREATE TABLE index_state (
      session_id TEXT PRIMARY KEY,
      last_indexed_msg INTEGER
    );

    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      msg_start INTEGER,
      msg_end INTEGER,
      text TEXT,
      timestamp TEXT,
      token_count INTEGER
    );

    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      embedding float[4]
    );

    CREATE TABLE semantic_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      level INTEGER,
      msg_start INTEGER,
      msg_end INTEGER,
      summary TEXT,
      token_count INTEGER,
      created_at TEXT,
      parent_id INTEGER
    );

    CREATE VIRTUAL TABLE vec_segments USING vec0(
      embedding float[4]
    );
  `);

  return db;
}

test("recall-health: reports 100/100 on perfectly indexed session", () => {
  const db = setupTestDb();
  const sessionId = "test-session-1";

  // Insert 20 messages
  const insertMsg = db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 20; i++) {
    insertMsg.run(sessionId, i, i % 2 === 0 ? "user" : "assistant", `Message number ${i}`);
  }

  // Index state says all 20 are indexed
  db.prepare("INSERT INTO index_state (session_id, last_indexed_msg) VALUES (?, ?)").run(sessionId, 20);

  // Insert 2 chunks with vectors
  const insertChunk = db.prepare("INSERT INTO chunks (session_id, msg_start, msg_end, text, token_count) VALUES (?, ?, ?, ?, ?)");
  const insertVec = db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");

  for (let c = 1; c <= 2; c++) {
    insertChunk.run(sessionId, (c - 1) * 10, c * 10, `Chunk text ${c}`, 100);
    insertVec.run(BigInt(c), new Float32Array([0.1, 0.2, 0.3, 0.4]));
  }

  const report = analyzeRecallHealth(db, sessionId);
  assert.equal(report.score, 100);
  assert.equal(report.recallState.lagMsgs, 0);
  assert.equal(report.recallState.coveragePct, 100);
  assert.equal(report.chunkStats.totalChunks, 2);
  assert.equal(report.chunksVectorHealth.orphanContent, 0);
  assert.equal(report.chunksVectorHealth.ghostVectors, 0);
  assert.equal(report.blockers.length, 0);

  const formatted = formatRecallHealthReport(report, { color: false });
  assert.match(formatted, /Health: 100\/100/);
  assert.match(formatted, /100% scanned/);
});

test("recall-health: detects oversized chunk blocking batch and deducts score", () => {
  const db = setupTestDb();
  const sessionId = "test-session-stalled";

  const insertMsg = db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 30; i++) {
    insertMsg.run(sessionId, i, i % 2 === 0 ? "user" : "assistant", `Message number ${i}`);
  }

  // Insert a huge message at 21
  const hugeContent = "x".repeat(40000);
  insertMsg.run(sessionId, 30, "user", hugeContent);

  // Indexed up to 20, lag is 11 msgs
  db.prepare("INSERT INTO index_state (session_id, last_indexed_msg) VALUES (?, ?)").run(sessionId, 20);

  const report = analyzeRecallHealth(db, sessionId);
  assert.ok(report.recallState.lagMsgs > 0);
  assert.equal(report.blockers.length, 1);
  assert.equal(report.blockers[0].reason, "oversized_chunk");
  assert.ok(report.score < 100);
  assert.ok(report.scoreBreakdown.stalled_pipeline !== undefined);

  const formatted = formatRecallHealthReport(report);
  assert.match(formatted, /STALL \(oversized chunk\)/);
  assert.match(formatted, /stalled_pipeline/);
});

test("recall-health: checks surrogates via isWellFormed", () => {
  const db = setupTestDb();
  const sessionId = "test-session-surrogate";

  db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, ?, ?)").run(sessionId, 0, "user", "hi");
  db.prepare("INSERT INTO index_state (session_id, last_indexed_msg) VALUES (?, ?)").run(sessionId, 1);

  // Normal text passes cleanly
  const normalText = "Normal text with unicode 🚀 and valid chars";
  db.prepare("INSERT INTO chunks (session_id, msg_start, msg_end, text, token_count) VALUES (?, ?, ?, ?, ?)").run(
    sessionId, 0, 1, normalText, 10
  );
  db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)").run(BigInt(1), new Float32Array([0.1, 0.2, 0.3, 0.4]));

  const report = analyzeRecallHealth(db, sessionId);
  assert.equal(report.chunkStats.loneSurrogates, 0);
  assert.equal(report.score, 100);
});

test("recall-health: accurately reflects true vector coverage when chunks lack vectors", () => {
  const db = setupTestDb();
  const sessionId = "test-session-orphans";

  // 100 messages scanned
  const insertMsg = db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 100; i++) {
    insertMsg.run(sessionId, i, "user", `Message ${i}`);
  }
  db.prepare("INSERT INTO index_state (session_id, last_indexed_msg) VALUES (?, ?)").run(sessionId, 100);

  // 10 chunks generated, but only 2 have vectors in vec_chunks
  const insertChunk = db.prepare("INSERT INTO chunks (session_id, msg_start, msg_end, text, token_count) VALUES (?, ?, ?, ?, ?)");
  const insertVec = db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");

  for (let c = 1; c <= 10; c++) {
    insertChunk.run(sessionId, (c - 1) * 10, c * 10, `Chunk text ${c}`, 100);
    if (c <= 2) {
      insertVec.run(BigInt(c), new Float32Array([0.1, 0.2, 0.3, 0.4]));
    }
  }

  const report = analyzeRecallHealth(db, sessionId);
  assert.equal(report.recallState.scanPct, 100);
  // Only 2 of 10 chunks have vectors = 20% coverage
  assert.equal(report.recallState.coveragePct, 20);
  assert.equal(report.chunksVectorHealth.orphanContent, 8);
  assert.ok(report.score < 100);

  const formatted = formatRecallHealthReport(report, { color: false });
  assert.match(formatted, /100% scanned/);
  assert.match(formatted, /20%/);
});

test("recall-health: listRecallSessions discovers sessions across tables", () => {
  const db = setupTestDb();
  db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, ?, ?)").run("s1", 0, "user", "m1");
  db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, ?, ?)").run("s2", 0, "user", "m2");

  const list = listRecallSessions(db);
  assert.equal(list.length, 2);
  const ids = list.map(s => s.session_id).sort();
  assert.deepEqual(ids, ["s1", "s2"]);
});
