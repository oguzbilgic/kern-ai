import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { analyzeSegmentHealth } from "../src/segment-health.js";
import { applyPrune, formatPrunePlan, loadSegmentRows, planPrune } from "../src/segment-prune.js";

const SID = "sess-1";

type Seg = {
  id: number; start: number; end: number; level?: number; parent?: number | null;
  summarized?: number; created?: string;
};

// Same schema as production, including the parent_id FK — applyPrune must respect it.
function makeDb(msgCount: number, segs: Seg[], lastSegmented?: number): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, msg_index INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT, UNIQUE(session_id, msg_index));
    CREATE TABLE segment_state (session_id TEXT PRIMARY KEY, last_segmented_msg INTEGER NOT NULL);
    CREATE TABLE semantic_segments (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, msg_start INTEGER NOT NULL, msg_end INTEGER NOT NULL,
      start_time TEXT, end_time TEXT, parent_id INTEGER REFERENCES semantic_segments(id), level INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL,
      token_count INTEGER NOT NULL, summarized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      summary_token_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, level, msg_start, msg_end)
    );
  `);
  const insMsg = db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, 'user', 'x')");
  for (let i = 0; i < msgCount; i++) insMsg.run(SID, i);
  const insSeg = db.prepare(
    `INSERT INTO semantic_segments (id, session_id, msg_start, msg_end, parent_id, level, summary, token_count, summarized, created_at, summary_token_count)
     VALUES (?, ?, ?, ?, ?, ?, 's', ?, ?, ?, 100)`
  );
  // Insert parents before children so the FK holds.
  for (const s of [...segs].sort((a, b) => (b.level ?? 0) - (a.level ?? 0))) {
    insSeg.run(s.id, SID, s.start, s.end, s.parent ?? null, s.level ?? 0, (s.end - s.start) * 100, s.summarized ?? 1, s.created ?? "2026-09-17 00:00:00");
  }
  db.prepare("INSERT INTO segment_state VALUES (?, ?)").run(SID, lastSegmented ?? Math.max(...segs.map(s => s.end)) - 1);
  return db;
}

function ids(db: Database.Database, level?: number): number[] {
  const rows = level == null
    ? db.prepare("SELECT id FROM semantic_segments ORDER BY id").all()
    : db.prepare("SELECT id FROM semantic_segments WHERE level = ? ORDER BY id").all(level);
  return (rows as Array<{ id: number }>).map(r => r.id);
}

// --- no-op --------------------------------------------------------------------

test("segment-prune: clean tree is a no-op", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 30, parent: 10 }, { id: 2, start: 30, end: 60, parent: 10 }, { id: 3, start: 60, end: 90, parent: 10 },
    { id: 10, start: 0, end: 90, level: 1 },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.equal(plan.deletions.length, 0);
  assert.equal(plan.orphans.length, 0);
  assert.equal(plan.residual.length, 0);
  assert.equal(plan.levels[0].kept, 3);
  assert.equal(plan.levels[1].kept, 1);
  assert.equal(plan.levels[0].pathOverlap, 0);
  assert.equal(plan.levels[0].pathGap, 0);
});

test("segment-prune: legacy 1-msg fencepost is free — not deleted, not residual", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 31 }, { id: 2, start: 30, end: 61 }, { id: 3, start: 60, end: 90 },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.equal(plan.deletions.length, 0);
  assert.equal(plan.residual.length, 0);
  assert.equal(plan.levels[0].pathOverlap, 0);
});

// --- re-index shift: parallel tiling ------------------------------------------

test("segment-prune: shifted re-index tiling is removed; original (with parent, older) kept", () => {
  const db = makeDb(120, [
    // original tiling, rolled up
    { id: 1, start: 0, end: 40, parent: 10, created: "2026-04-01" },
    { id: 2, start: 40, end: 80, parent: 10, created: "2026-04-01" },
    { id: 3, start: 80, end: 120, parent: 10, created: "2026-04-01" },
    { id: 10, start: 0, end: 120, level: 1, created: "2026-04-02" },
    // re-index one message off, no parents yet
    { id: 21, start: 0, end: 39, created: "2026-09-01" },
    { id: 22, start: 39, end: 81, created: "2026-09-01" },
    { id: 23, start: 81, end: 120, created: "2026-09-01" },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.deepEqual(plan.deletions.map(d => d.id).sort((a, b) => a - b), [21, 22, 23]);
  assert.ok(plan.deletions.every(d => d.reason === "off-path"));
  assert.equal(plan.orphans.length, 0);
  applyPrune(db, plan);
  assert.deepEqual(ids(db, 0), [1, 2, 3]);
  assert.deepEqual(ids(db, 1), [10]);
  const h = analyzeSegmentHealth(db, SID, { budgetTokens: 10_000 });
  assert.equal(h.overlaps.length, 0);
  assert.equal(h.score, 100);
});

test("segment-prune: parallel tilings both rolled up — loser's parents go too", () => {
  const db = makeDb(120, [
    { id: 1, start: 0, end: 40, parent: 10, created: "2026-04-01" },
    { id: 2, start: 40, end: 80, parent: 10, created: "2026-04-01" },
    { id: 3, start: 80, end: 120, parent: 10, created: "2026-04-01" },
    { id: 10, start: 0, end: 120, level: 1, created: "2026-04-02" },
    { id: 21, start: 0, end: 39, parent: 30, created: "2026-09-01" },
    { id: 22, start: 39, end: 81, parent: 30, created: "2026-09-01" },
    { id: 23, start: 81, end: 120, created: "2026-09-01" },
    { id: 30, start: 0, end: 81, level: 1, created: "2026-09-02" },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  const del = new Map(plan.deletions.map(d => [d.id, d.reason]));
  assert.deepEqual([...del.keys()].sort((a, b) => a - b), [21, 22, 23, 30]);
  assert.equal(del.get(30), "invalid-parent");
  applyPrune(db, plan);
  assert.deepEqual(ids(db), [1, 2, 3, 10]);
});

// --- straggler mega-parent ------------------------------------------------------

test("segment-prune: parent with a hole in its children is deleted, surviving children orphaned", () => {
  // L1 #10 owns [0,40)+[40,80); L1 #11 is a straggler rollup spanning [80,200) but only
  // actually has children [80,120) and [160,200) — the middle belongs to #12.
  const db = makeDb(200, [
    { id: 1, start: 0, end: 40, parent: 10 }, { id: 2, start: 40, end: 80, parent: 10 },
    { id: 3, start: 80, end: 120, parent: 11 }, { id: 4, start: 120, end: 160, parent: 12 }, { id: 5, start: 160, end: 200, parent: 11 },
    { id: 10, start: 0, end: 80, level: 1 },
    { id: 11, start: 80, end: 200, level: 1 },
    { id: 12, start: 120, end: 160, level: 1 },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.deepEqual(plan.deletions.map(d => d.id), [11]);
  assert.equal(plan.deletions[0].reason, "invalid-parent");
  assert.match(plan.deletions[0].detail!, /hole 120–160/);
  assert.deepEqual(plan.orphans.map(o => o.id).sort((a, b) => a - b), [3, 5]);
  applyPrune(db, plan);
  const p = db.prepare("SELECT parent_id FROM semantic_segments WHERE id IN (3,5)").all() as Array<{ parent_id: number | null }>;
  assert.ok(p.every(r => r.parent_id === null));
  assert.deepEqual(ids(db, 1), [10, 12]);
  // L1 now has a hole [80,120) (and lost its tail past 160) — fine, those L0s are orphans awaiting rollup.
  assert.equal(plan.levels[1].pathGap, 40);
  assert.equal(plan.levels[1].coverageEnd, 160);
  assert.equal(plan.levels[1].pathOverlap, 0);
});

test("segment-prune: invalidation cascades only where survivors no longer tile", () => {
  // L0 shadow #7 inside #10's range. Removing #7 leaves #10's children tiling exactly → #10 survives,
  // and so does its parent #20.
  const db = makeDb(120, [
    { id: 1, start: 0, end: 40, parent: 10 }, { id: 2, start: 40, end: 80, parent: 10 }, { id: 3, start: 80, end: 120, parent: 11 },
    { id: 7, start: 40, end: 70, parent: 10, created: "2026-09-10" },
    { id: 10, start: 0, end: 80, level: 1, parent: 20 }, { id: 11, start: 80, end: 120, level: 1, parent: 20 },
    { id: 20, start: 0, end: 120, level: 2 },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.deepEqual(plan.deletions.map(d => d.id), [7]);
  assert.equal(plan.orphans.length, 0);
  applyPrune(db, plan);
  assert.deepEqual(ids(db), [1, 2, 3, 10, 11, 20]);
});

// --- pending intruder -----------------------------------------------------------

test("segment-prune: unsummarized re-index intruder is dropped, unsummarized tail is kept", () => {
  const db = makeDb(150, [
    { id: 1, start: 0, end: 40 }, { id: 2, start: 40, end: 80 }, { id: 3, start: 80, end: 120 },
    { id: 8, start: 35, end: 85, summarized: 0, created: "2026-09-17" },   // overlaps 1–3, nothing to lose
    { id: 9, start: 120, end: 150, summarized: 0, created: "2026-09-17" }, // genuine new tail chunk
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.deepEqual(plan.deletions.map(d => d.id), [8]);
  applyPrune(db, plan);
  assert.deepEqual(ids(db, 0), [1, 2, 3, 9]);
});

// --- L0 gap vs overlap priority ---------------------------------------------------

test("segment-prune: at L0 a hole is worse than an overlap — overlapping cover is kept, reported as residual", () => {
  // Only cover for [40,60) is via #2 which overlaps #3 by 10. Deleting #2 would open a hole
  // indexSession can never refill, so keep it and report.
  const db = makeDb(100, [
    { id: 1, start: 0, end: 40 }, { id: 2, start: 40, end: 70 }, { id: 3, start: 60, end: 100 },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.equal(plan.deletions.length, 0);
  assert.deepEqual(plan.residual, [{ level: 0, a: 2, b: 3, msgs: 10 }]);
  assert.equal(plan.levels[0].pathOverlap, 10);
});

test("segment-prune: at L1+ overlap loses to a gap — the overlapping parent is dropped and its children orphaned", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 40, parent: 10 }, { id: 2, start: 40, end: 70, parent: 11 }, { id: 3, start: 60, end: 100, parent: 12 },
    { id: 10, start: 0, end: 40, level: 1 }, { id: 11, start: 40, end: 70, level: 1 }, { id: 12, start: 60, end: 100, level: 1 },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  const l1 = plan.deletions.filter(d => d.level === 1);
  assert.equal(l1.length, 1);
  assert.ok(l1[0].id === 11 || l1[0].id === 12);
  assert.equal(plan.levels[1].pathOverlap, 0);
  assert.ok(plan.levels[1].pathGap > 0);
  assert.equal(plan.orphans.length, 1);
});

// --- apply --------------------------------------------------------------------------

test("segment-prune: applyPrune respects the parent_id FK (orphans detached before parents deleted)", () => {
  const db = makeDb(120, [
    { id: 1, start: 0, end: 40, parent: 10 }, { id: 2, start: 40, end: 80, parent: 10 }, { id: 3, start: 80, end: 120, parent: 11 },
    { id: 10, start: 0, end: 80, level: 1, parent: 20 }, { id: 11, start: 80, end: 120, level: 1, parent: 20 },
    { id: 20, start: 0, end: 100, level: 2 },   // range mismatch → deleted, 10 & 11 orphaned
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.deepEqual(plan.deletions.map(d => d.id), [20]);
  assert.doesNotThrow(() => applyPrune(db, plan));
  assert.deepEqual(ids(db), [1, 2, 3, 10, 11]);
  const p = db.prepare("SELECT parent_id FROM semantic_segments WHERE level = 1").all() as Array<{ parent_id: number | null }>;
  assert.ok(p.every(r => r.parent_id === null));
});

test("segment-prune: formatPrunePlan renders table, reasons, orphans", () => {
  const db = makeDb(120, [
    { id: 1, start: 0, end: 40, parent: 10 }, { id: 2, start: 40, end: 80, parent: 10 }, { id: 3, start: 80, end: 120 },
    { id: 21, start: 0, end: 39, created: "2026-09-01" },
    { id: 10, start: 0, end: 80, level: 1, parent: 20 },
    { id: 20, start: 0, end: 90, level: 2 },
  ]);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  const out = formatPrunePlan(plan);
  assert.match(out, /Level\s+Before\s+Kept\s+Del/);
  assert.match(out, /off-path \(1\)/);
  assert.match(out, /invalid-parent \(1\)/);
  assert.match(out, /Orphaned .*L1 1/);
  assert.match(out, /Zero LLM calls/);
});

test("segment-prune: sessionStart anchors L0 so a leading gap is charged like segment-health does", () => {
  const db = makeDb(100, [{ id: 1, start: 20, end: 60 }, { id: 2, start: 60, end: 100 }]);
  const noAnchor = planPrune(loadSegmentRows(db, SID), SID);
  assert.equal(noAnchor.levels[0].pathGap, 0);
  const anchored = planPrune(loadSegmentRows(db, SID), SID, { sessionStart: 0 });
  assert.equal(anchored.levels[0].pathGap, 20);
  assert.equal(anchored.deletions.length, 0);
});

test("segment-prune: applyPrune deletes matching vec_segments rows when the table exists", () => {
  const db = makeDb(120, [
    { id: 1, start: 0, end: 40 }, { id: 2, start: 40, end: 80 }, { id: 3, start: 80, end: 120 },
    { id: 21, start: 0, end: 39, created: "2026-09-01" },
  ]);
  // Plain table stands in for the vec0 virtual table; same rowid = segment id contract.
  db.exec("CREATE TABLE vec_segments (rowid INTEGER PRIMARY KEY, embedding BLOB)");
  for (const id of [1, 2, 3, 21]) db.prepare("INSERT INTO vec_segments (rowid, embedding) VALUES (?, x'00')").run(id);
  const plan = planPrune(loadSegmentRows(db, SID), SID);
  assert.deepEqual(plan.deletions.map(d => d.id), [21]);
  applyPrune(db, plan);
  const left = (db.prepare("SELECT rowid FROM vec_segments ORDER BY rowid").all() as Array<{ rowid: number }>).map(r => r.rowid);
  assert.deepEqual(left, [1, 2, 3]);
});
