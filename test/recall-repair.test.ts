import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { planRecallRepair, applyRecallRepair } from "../src/plugins/recall/repair.js";

function setupTestDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      msg_start INTEGER NOT NULL,
      msg_end INTEGER NOT NULL,
      text TEXT NOT NULL,
      timestamp TEXT,
      token_count INTEGER
    );

    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      embedding float[4]
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      msg_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT
    );

    CREATE TABLE index_state (
      session_id TEXT PRIMARY KEY,
      last_indexed_msg INTEGER
    );
  `);

  return db;
}

test("planRecallRepair: detects clean/healthy index as no-op", () => {
  const db = setupTestDb();
  const sessionId = "clean-session";

  // Insert 3 chunks, 3 vectors, and up-to-date index_state
  db.exec(`
    INSERT INTO chunks (id, session_id, msg_start, msg_end, text) VALUES
      (1, '${sessionId}', 0, 1, 'chunk 1'),
      (2, '${sessionId}', 2, 3, 'chunk 2'),
      (3, '${sessionId}', 4, 5, 'chunk 3');

    INSERT INTO vec_chunks (rowid, embedding) VALUES
      (1, '[0.1, 0.2, 0.3, 0.4]'),
      (2, '[0.2, 0.3, 0.4, 0.5]'),
      (3, '[0.3, 0.4, 0.5, 0.6]');

    INSERT INTO messages (session_id, msg_index, role, content) VALUES
      ('${sessionId}', 0, 'user', 'msg 0'),
      ('${sessionId}', 1, 'assistant', 'msg 1');

    INSERT INTO index_state (session_id, last_indexed_msg) VALUES
      ('${sessionId}', 2);
  `);

  const plan = planRecallRepair(db, sessionId);

  assert.equal(plan.isClean, true);
  assert.equal(plan.orphanChunks.length, 0);
  assert.equal(plan.totalChunks, 3);
  assert.equal(plan.vectorChunks, 3);
  assert.equal(plan.tailLag, 0);
});

test("planRecallRepair: identifies orphaned chunks without vec_chunks entries", () => {
  const db = setupTestDb();
  const sessionId = "orphan-session";

  // Insert 4 chunks, but only vector 1 is in vec_chunks (3 orphans)
  db.exec(`
    INSERT INTO chunks (id, session_id, msg_start, msg_end, text) VALUES
      (1, '${sessionId}', 0, 1, 'chunk 1'),
      (2, '${sessionId}', 2, 3, 'chunk 2'),
      (3, '${sessionId}', 4, 5, 'chunk 3'),
      (4, '${sessionId}', 6, 7, 'chunk 4');

    INSERT INTO vec_chunks (rowid, embedding) VALUES
      (1, '[0.1, 0.2, 0.3, 0.4]');

    INSERT INTO index_state (session_id, last_indexed_msg) VALUES
      ('${sessionId}', 8);
  `);

  const plan = planRecallRepair(db, sessionId);

  assert.equal(plan.isClean, false);
  assert.equal(plan.totalChunks, 4);
  assert.equal(plan.vectorChunks, 1);
  assert.equal(plan.orphanChunks.length, 3);
  assert.deepEqual(
    plan.orphanChunks.map((o) => o.id),
    [2, 3, 4]
  );
  assert.equal(plan.earliestOrphanStart, 2);
  assert.equal(plan.resetCursorTo, 2);
});

test("applyRecallRepair: clean plan is immediate no-op", () => {
  const db = setupTestDb();
  const sessionId = "noop-session";

  const plan = {
    sessionId,
    totalChunks: 2,
    vectorChunks: 2,
    orphanChunks: [],
    totalMessages: 5,
    lastIndexedMsg: 5,
    tailLag: 0,
    isClean: true,
    earliestOrphanStart: null,
    resetCursorTo: 5,
  };

  const result = applyRecallRepair(db, plan);

  assert.equal(result.deletedChunks, 0);
  assert.equal(result.resetCursorTo, 5);
  assert.equal(result.previousCursor, 5);
});

test("applyRecallRepair: prunes orphan chunks and rewinds index_state cursor", () => {
  const db = setupTestDb();
  const sessionId = "repair-session";

  db.exec(`
    INSERT INTO chunks (id, session_id, msg_start, msg_end, text) VALUES
      (1, '${sessionId}', 0, 1, 'chunk 1'),
      (2, '${sessionId}', 2, 3, 'chunk 2'),
      (3, '${sessionId}', 4, 5, 'chunk 3');

    INSERT INTO vec_chunks (rowid, embedding) VALUES
      (1, '[0.1, 0.2, 0.3, 0.4]');

    INSERT INTO index_state (session_id, last_indexed_msg) VALUES
      ('${sessionId}', 6);
  `);

  const plan = planRecallRepair(db, sessionId);
  assert.equal(plan.orphanChunks.length, 2);
  assert.equal(plan.resetCursorTo, 2);

  const result = applyRecallRepair(db, plan);
  assert.equal(result.deletedChunks, 2);
  assert.equal(result.resetCursorTo, 2);
  assert.equal(result.previousCursor, 6);

  // Verify only chunk 1 remains in chunks table
  const remainingChunks = db.prepare("SELECT id FROM chunks WHERE session_id = ?").all(sessionId) as Array<{ id: number }>;
  assert.deepEqual(remainingChunks.map((c) => c.id), [1]);

  // Verify index_state was reset to msg 2
  const state = db.prepare("SELECT last_indexed_msg FROM index_state WHERE session_id = ?").get(sessionId) as { last_indexed_msg: number };
  assert.equal(state.last_indexed_msg, 2);
});
