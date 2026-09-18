import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SegmentIndex, planRollupGroups, selectHistorySegments, type RollupRow, type HistorySegment } from "../src/segments.js";
import { analyzeSegmentHealth } from "../src/segment-health.js";
import { applyPrune, loadSegmentRows, planPrune } from "../src/segment-prune.js";

const SID = "sess-1";

// ── fixtures ──────────────────────────────────────────────────────────────────

function schema(db: Database.Database) {
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, msg_index INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT, UNIQUE(session_id, msg_index));
    CREATE TABLE segment_state (session_id TEXT PRIMARY KEY, last_segmented_msg INTEGER NOT NULL);
    CREATE TABLE semantic_segments (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, msg_start INTEGER NOT NULL, msg_end INTEGER NOT NULL,
      start_time TEXT, end_time TEXT, parent_id INTEGER REFERENCES semantic_segments(id), level INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL,
      token_count INTEGER NOT NULL, summarized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      summary_token_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, level, msg_start, msg_end)
    );
    CREATE TABLE vec_segments (rowid INTEGER PRIMARY KEY, embedding BLOB);
  `);
}

/** N messages of ~1k chars each → ~250 tokens/msg, so TARGET_TOKENS (15k) cuts every ~60 msgs. */
function seedMessages(db: Database.Database, n: number, from = 0) {
  const ins = db.prepare("INSERT INTO messages (session_id, msg_index, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)");
  for (let i = from; i < from + n; i++) ins.run(SID, i, `message ${i} ` + "x".repeat(1000), `2026-09-17T00:${String(i % 60).padStart(2, "0")}:00Z`);
}

/** A SegmentIndex over `db` with a constant embedder and no LLM calls. */
function makeIndex(db: Database.Database): SegmentIndex {
  const idx = Object.create(SegmentIndex.prototype) as any;
  idx.db = db;
  idx.abortController = null;
  // Topic flips every 50 messages → a hard cut (cosine distance 1 > threshold) there.
  idx.embedTexts = async (texts: string[]) => texts.map((_, i) => (Math.floor(i / 50) % 2 === 0 ? [1, 0, 0] : [0, 1, 0]));
  idx.summarizeUnsummarized = async () => 0;
  idx.rollUpLevels = async () => {};
  return idx as SegmentIndex;
}

function row(o: Partial<RollupRow> & { id: number; msg_start: number; msg_end: number }): RollupRow {
  return {
    start_time: null, end_time: null, summary: "s", token_count: 100, summary_token_count: 10,
    parent_id: null, summarized: 1, ...o,
  };
}

/** k contiguous L0 rows [from, from+k*w) with ids starting at idFrom. */
function tiles(k: number, from: number, w: number, idFrom: number, extra: Partial<RollupRow> = {}): RollupRow[] {
  return Array.from({ length: k }, (_, i) => row({ id: idFrom + i, msg_start: from + i * w, msg_end: from + (i + 1) * w, ...extra }));
}

// ── A1 + A3: indexSession ────────────────────────────────────────────────────

test("A1: consecutive indexSession runs produce contiguous L0 segments (no fencepost)", async () => {
  const db = new Database(":memory:");
  schema(db);
  seedMessages(db, 200);
  const idx = makeIndex(db);
  const first = await idx.indexSession(SID);
  assert.ok(first >= 2, `expected ≥2 segments, got ${first}`);
  seedMessages(db, 200, 200);
  const second = await idx.indexSession(SID);
  assert.ok(second >= 2, `expected ≥2 more segments, got ${second}`);

  const segs = db.prepare("SELECT msg_start, msg_end FROM semantic_segments WHERE level = 0 ORDER BY msg_start").all() as Array<{ msg_start: number; msg_end: number }>;
  assert.equal(segs[0].msg_start, 0);
  assert.equal(segs[segs.length - 1].msg_end, 400);
  for (let i = 1; i < segs.length; i++) {
    assert.equal(segs[i].msg_start, segs[i - 1].msg_end, `boundary ${i}: ${segs[i - 1].msg_end} → ${segs[i].msg_start}`);
  }
  const health = analyzeSegmentHealth(db, SID);
  assert.equal(health.overlaps.length, 0);
  assert.equal(health.levels[0].fenceposts, 0);
});

test("A3/A6: missing segment_state with an existing tree fast-forwards the cursor instead of re-indexing", async () => {
  const db = new Database(":memory:");
  schema(db);
  seedMessages(db, 400);
  const idx = makeIndex(db);
  await idx.indexSession(SID);
  const before = db.prepare("SELECT id, msg_start, msg_end FROM semantic_segments ORDER BY msg_start").all();
  assert.ok(before.length >= 4);

  // What initVecTables used to do on an embedding-dimension change.
  db.exec("DELETE FROM segment_state");
  const created = await idx.indexSession(SID);
  assert.equal(created, 0);
  assert.deepEqual(db.prepare("SELECT id, msg_start, msg_end FROM semantic_segments ORDER BY msg_start").all(), before);
  const state = db.prepare("SELECT last_segmented_msg FROM segment_state").get() as { last_segmented_msg: number };
  assert.equal(state.last_segmented_msg, 399);

  // And indexing resumes cleanly from there.
  seedMessages(db, 200, 400);
  assert.ok((await idx.indexSession(SID)) >= 2);
  const health = analyzeSegmentHealth(db, SID);
  assert.equal(health.overlaps.length, 0);
  assert.equal(health.gaps.length, 0);
  assert.equal(health.levels[0].fenceposts, 0);
});

test("A3: a new L0 segment overlapping existing coverage is rejected at insert, cursor still advances", async () => {
  const db = new Database(":memory:");
  schema(db);
  seedMessages(db, 400);
  const idx = makeIndex(db);
  // Tree covers [0,200) with the cursor at 199, plus a stray L0 [250,260) ahead of the cursor.
  const ins = db.prepare("INSERT INTO semantic_segments (session_id, msg_start, msg_end, level, summary, token_count, summarized, created_at) VALUES (?, ?, ?, 0, 's', 100, 1, '2026-09-01')");
  for (let s = 0; s < 200; s += 50) ins.run(SID, s, s + 50);
  ins.run(SID, 250, 260);
  db.prepare("INSERT INTO segment_state VALUES (?, ?)").run(SID, 199);

  const created = await idx.indexSession(SID);
  // Cuts every 50 from the chunk start: [200,250) [250,300) [300,350) [350,400). [250,300) overlaps the stray → skipped.
  assert.equal(created, 3);
  const segs = db.prepare("SELECT msg_start, msg_end FROM semantic_segments WHERE level = 0 ORDER BY msg_start").all() as Array<{ msg_start: number; msg_end: number }>;
  assert.ok(!segs.some(x => x.msg_start === 250 && x.msg_end === 300));
  const health = analyzeSegmentHealth(db, SID);
  assert.equal(health.overlaps.length, 0);
  assert.deepEqual(health.gaps.map(g => [g.from, g.to]), [[260, 300]]);
  const state = db.prepare("SELECT last_segmented_msg FROM segment_state").get() as { last_segmented_msg: number };
  assert.equal(state.last_segmented_msg, 399);
});

test("A3: a cursor behind contiguous coverage fast-forwards; a candidate straddling the edge is never dropped", async () => {
  const db = new Database(":memory:");
  schema(db);
  seedMessages(db, 400);
  const idx = makeIndex(db);
  const ins = db.prepare("INSERT INTO semantic_segments (session_id, msg_start, msg_end, level, summary, token_count, summarized, created_at) VALUES (?, ?, ?, 0, 's', 100, 1, '2026-09-01')");
  for (let s = 0; s < 200; s += 50) ins.run(SID, s, s + 50);
  // Stale cursor: tree covers [0,200) but state says 149 (e.g. restored DB).
  db.prepare("INSERT INTO segment_state VALUES (?, ?)").run(SID, 149);

  const created = await idx.indexSession(SID);
  assert.equal(created, 4);
  const health = analyzeSegmentHealth(db, SID);
  assert.equal(health.overlaps.length, 0);
  assert.equal(health.gaps.length, 0);
  assert.equal(health.levels[0].fenceposts, 0);
  const state = db.prepare("SELECT last_segmented_msg FROM segment_state").get() as { last_segmented_msg: number };
  assert.equal(state.last_segmented_msg, 399);
});

// ── A2: planRollupGroups ─────────────────────────────────────────────────────

test("A2: only contiguous runs are grouped; a discontinuity breaks the group", () => {
  // 12 contiguous, then a hole, then 12 more contiguous. Old code: [0..9], [10..19] straddling the hole.
  const a = tiles(12, 0, 10, 1);
  const b = tiles(12, 500, 10, 101);
  const groups = planRollupGroups([...a, ...b]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map(r => r.id), a.slice(0, 10).map(r => r.id));
  assert.deepEqual(groups[1].map(r => r.id), b.slice(0, 10).map(r => r.id));
  for (const g of groups) {
    for (let i = 1; i < g.length; i++) assert.equal(g[i].msg_start, g[i - 1].msg_end);
  }
});

test("A2: legacy 1-msg fencepost overlap counts as adjacent", () => {
  const rows: RollupRow[] = [];
  let start = 0;
  for (let i = 0; i < 10; i++) {
    rows.push(row({ id: i + 1, msg_start: start, msg_end: start + 10 }));
    start += 9; // next starts one before prev ends
  }
  const groups = planRollupGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 10);
});

test("A2: trailing remainder (<10) stays orphan", () => {
  const groups = planRollupGroups(tiles(14, 0, 10, 1));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 10);
});

test("A2: hole filler — a short interior run bounded by parents on both sides rolls up", () => {
  // [0,100) parented, [100,160) six orphans, [160,260) parented
  const left = tiles(10, 0, 10, 1, { parent_id: 900 });
  const hole = tiles(6, 100, 10, 11);
  const right = tiles(10, 160, 10, 21, { parent_id: 901 });
  const groups = planRollupGroups([...left, ...hole, ...right]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map(r => r.id), hole.map(r => r.id));
});

test("A2: hole filler — leading run at level start bounded by a parent on the right rolls up", () => {
  const lead = tiles(4, 0, 10, 1);
  const right = tiles(10, 40, 10, 11, { parent_id: 900 });
  const groups = planRollupGroups([...lead, ...right]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 4);
});

test("A2: interior remainder folds into the last full group (10–19 children)", () => {
  const left = tiles(10, 0, 10, 1, { parent_id: 900 });
  const run = tiles(13, 100, 10, 11);
  const right = tiles(10, 230, 10, 31, { parent_id: 901 });
  const groups = planRollupGroups([...left, ...run, ...right]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 13);
});

test("A2: a parented row overlapping its neighbours (pre-prune tree) breaks the run — no group straddles it", () => {
  // Orphans [0,10) and [10,20) are adjacent to each other, but parented [5,15) sits between them in position order.
  const rows = [
    row({ id: 1, msg_start: 0, msg_end: 10 }),
    row({ id: 2, msg_start: 5, msg_end: 15, parent_id: 99 }),
    row({ id: 3, msg_start: 10, msg_end: 20 }),
    ...tiles(10, 20, 10, 4),
  ];
  const groups = planRollupGroups(rows);
  for (const g of groups) assert.ok(!(g.some(r => r.id === 1) && g.some(r => r.id === 3)), "run must not straddle the parented row");
  // [0,10) and [10,20) both overlap the parented row → ineligible; the ten tiles after form the only group.
  assert.ok(groups.some(g => g.length === 10 && g[0].id === 4));
});

test("A2: an orphan overlapping a parented row (not positionally between) is ineligible — no overlapping parent is recreated", () => {
  // Ten orphans tile [0,100); an existing L1 child [95,200) sorts after all of them.
  const rows = [...tiles(10, 0, 10, 1), row({ id: 11, msg_start: 95, msg_end: 200, parent_id: 99 })];
  const groups = planRollupGroups(rows);
  for (const g of groups) assert.ok(!g.some(r => r.id === 10), "[90,100) overlaps the parented row and must not roll up");
  // The remaining nine [0,90) are not bounded on the right by a parented row (the ineligible
  // orphan is not a boundary) → they stay orphan roots; prune sorts this stretch out later.
  assert.deepEqual(groups, []);
});

test("A2: unsummarized orphan breaks a run and is never grouped", () => {
  const rows = tiles(21, 0, 10, 1);
  rows[10].summarized = 0;
  const groups = planRollupGroups(rows);
  // [0..9] and [11..20] are each exactly 10 → two groups; row 10 is in neither.
  assert.equal(groups.length, 2);
  assert.ok(!groups.flat().some(r => r.id === rows[10].id));
  assert.deepEqual(groups.map(g => [g[0].msg_start, g[g.length - 1].msg_end]), [[0, 100], [110, 210]]);
});

// ── A4: selectHistorySegments dedupe ─────────────────────────────────────────

test("A4: a root shadowed by another root is not injected", () => {
  const seg = (id: number, s: number, e: number, level = 0): HistorySegment =>
    ({ id, level, msg_start: s, msg_end: e, start_time: null, end_time: null, summary: "s", token_count: 100, summary_token_count: 10, parent_id: null });
  const all = [seg(1, 0, 100), seg(2, 1, 100), seg(3, 100, 200)];
  const picked = selectHistorySegments(all, 200, 10_000)!;
  assert.deepEqual(picked.selected.map(s => s.id), [1, 3]);
  assert.equal(picked.tokens, 20);
  assert.deepEqual(picked.shadowed.map(s => s.id), [2], "dropped roots are reported so composeHistory can log them");
});

// ── e2e: prune → rollup plan leaves no stragglers ────────────────────────────

test("e2e: after pruning a mega-parent, one rollup pass re-covers every straggler including a <10 hole", () => {
  const db = new Database(":memory:");
  schema(db);
  seedMessages(db, 400);
  const ins = db.prepare(
    `INSERT INTO semantic_segments (id, session_id, msg_start, msg_end, parent_id, level, summary, token_count, summarized, summary_token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 's', 100, 1, 10, ?)`
  );
  // L1 parents: #100 [0,100), #102 [200,300) valid. #101 is a straggler mega-parent
  // claiming [100,400) but only owning children in [100,140) and [300,400).
  ins.run(100, SID, 0, 100, null, 1, "2026-09-01");
  ins.run(101, SID, 100, 400, null, 1, "2026-09-02");
  ins.run(102, SID, 200, 300, null, 1, "2026-09-03");
  let id = 1;
  for (let s = 0; s < 400; s += 10) {
    const parent = s < 100 ? 100 : s < 140 ? 101 : s < 200 ? null : s < 300 ? 102 : 101;
    ins.run(id++, SID, s, s + 10, parent, 0, "2026-09-01");
  }
  db.prepare("INSERT INTO segment_state VALUES (?, ?)").run(SID, 399);

  const plan = planPrune(loadSegmentRows(db, SID), SID, { sessionStart: 0 });
  assert.deepEqual(plan.deletions.map(d => d.id), [101]);
  applyPrune(db, plan);
  const mid = analyzeSegmentHealth(db, SID);
  assert.ok(mid.stragglers.length > 0, "prune leaves stragglers for rollup");

  // One rollup planning pass over L0.
  const rows = db.prepare("SELECT * FROM semantic_segments WHERE session_id = ? AND level = 0 ORDER BY msg_start, msg_end").all(SID) as RollupRow[];
  const groups = planRollupGroups(rows);
  // Orphans: [100,200) = 10 contiguous (interior) → one group; [300,400) = 10 (trailing, full) → one group.
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => [g[0].msg_start, g[g.length - 1].msg_end]), [[100, 200], [300, 400]]);
  for (const g of groups) for (let i = 1; i < g.length; i++) assert.equal(g[i].msg_start, g[i - 1].msg_end);

  // Apply the grouping as rollUpGroup would (minus the LLM) and check the tree is whole.
  let pid = 200;
  for (const g of groups) {
    db.prepare("INSERT INTO semantic_segments (id, session_id, msg_start, msg_end, level, summary, token_count, summarized, summary_token_count, created_at) VALUES (?, ?, ?, ?, 1, 's', 100, 1, 10, '2026-09-18')")
      .run(pid, SID, g[0].msg_start, g[g.length - 1].msg_end);
    for (const c of g) db.prepare("UPDATE semantic_segments SET parent_id = ? WHERE id = ?").run(pid, c.id);
    pid++;
  }
  const after = analyzeSegmentHealth(db, SID);
  assert.equal(after.overlaps.length, 0);
  assert.equal(after.stragglers.length, 0);
  assert.equal(after.parentIssues.length, 0);
  assert.equal(after.gaps.length, 0);
  assert.equal(after.score, 100);
});
