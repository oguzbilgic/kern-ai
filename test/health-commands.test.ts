import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { recallPlugin } from "../src/plugins/recall/plugin.js";
import type { PluginContext } from "../src/plugins/types.js";

function setupTestDb(): Database.Database {
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
      id INTEGER PRIMARY KEY,
      embedding float[4]
    );

    CREATE TABLE semantic_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      msg_start INTEGER NOT NULL,
      msg_end INTEGER NOT NULL,
      start_time TEXT,
      end_time TEXT,
      parent_id INTEGER,
      level INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      token_count INTEGER NOT NULL DEFAULT 0,
      summary_token_count INTEGER NOT NULL DEFAULT 0,
      summarized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE segment_state (
      session_id TEXT PRIMARY KEY,
      last_segmented_msg INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE vec_segments USING vec0(
      id INTEGER PRIMARY KEY,
      embedding float[4]
    );
  `);

  return db;
}

test("recallPlugin registers /embed-health and /segment-health commands", async () => {
  const commands = recallPlugin.commands;
  assert.ok(commands, "commands defined");
  assert.ok(commands["/embed-health"], "/embed-health registered");
  assert.ok(commands["/segment-health"], "/segment-health registered");

  assert.match(commands["/embed-health"].description, /embed/i);
  assert.match(commands["/segment-health"].description, /segment/i);
});

test("recallPlugin commands return error when no sessions exist", async () => {
  const db = setupTestDb();
  const ctx: PluginContext = {
    agentDir: "/tmp",
    config: { maxContextTokens: 100_000, summaryBudget: 0.75 } as any,
    db: { db } as any,
    sessionId: () => null,
  };

  const embedRes = await recallPlugin.commands!["/embed-health"].handler(ctx);
  assert.match(embedRes, /No sessions found in recall\.db/);

  const segRes = await recallPlugin.commands!["/segment-health"].handler(ctx);
  assert.match(segRes, /No sessions found in recall\.db/);

  db.close();
});

test("recallPlugin commands run successfully against a populated session", async () => {
  const db = setupTestDb();
  const sessionId = "test-session-001";

  // Insert test messages
  const insertMsg = db.prepare("INSERT INTO messages (session_id, msg_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)");
  insertMsg.run(sessionId, 0, "user", "hello agent", "2026-09-19T10:00:00.000Z");
  insertMsg.run(sessionId, 1, "assistant", "hello operator", "2026-09-19T10:00:01.000Z");

  // Insert chunk and vector
  db.prepare("INSERT INTO chunks (id, session_id, msg_start, msg_end, text, timestamp, token_count) VALUES (1, ?, 0, 1, 'turn 0', '2026-09-19T10:00:00.000Z', 10)").run(sessionId);
  db.prepare("INSERT INTO vec_chunks (id, embedding) VALUES (1, ?)").run(new Float32Array([0.1, 0.2, 0.3, 0.4]));
  db.prepare("INSERT INTO index_state (session_id, last_indexed_msg) VALUES (?, 1)").run(sessionId);

  // Insert segment and vector
  db.prepare("INSERT INTO semantic_segments (id, session_id, msg_start, msg_end, start_time, end_time, level, summary, token_count, summary_token_count, summarized, created_at) VALUES (1, ?, 0, 1, '2026-09-19T10:00:00.000Z', '2026-09-19T10:00:01.000Z', 0, 'brief summary', 10, 5, 1, '2026-09-19T10:00:02.000Z')").run(sessionId);
  db.prepare("INSERT INTO vec_segments (id, embedding) VALUES (1, ?)").run(new Float32Array([0.1, 0.2, 0.3, 0.4]));
  db.prepare("INSERT INTO segment_state (session_id, last_segmented_msg) VALUES (?, 1)").run(sessionId);

  const ctx: PluginContext = {
    agentDir: "/tmp",
    config: { maxContextTokens: 100_000, summaryBudget: 0.75 } as any,
    db: { db } as any,
    sessionId: () => sessionId,
  };

  const embedRes = await recallPlugin.commands!["/embed-health"].handler(ctx);
  assert.ok(embedRes.startsWith("```text\n"));
  assert.match(embedRes, /Session test-ses/);
  assert.match(embedRes, /Target\s+Rows/);

  const segRes = await recallPlugin.commands!["/segment-health"].handler(ctx);
  assert.ok(segRes.startsWith("```text\n"));
  assert.match(segRes, /Session test-ses/);
  assert.match(segRes, /100\/100/);

  db.close();
});
