import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { analyzeSegmentHealth, formatHealthReport } from "../src/segment-health.js";
import { selectHistorySegments, type HistorySegment } from "../src/segments.js";

const SID = "sess-1";

type Seg = {
  id: number; start: number; end: number; level?: number; parent?: number | null;
  tokens?: number; summarized?: number; created?: string;
};

function makeDb(msgCount: number, segs: Seg[], lastSegmented?: number): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, msg_index INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT, UNIQUE(session_id, msg_index));
    CREATE TABLE segment_state (session_id TEXT PRIMARY KEY, last_segmented_msg INTEGER NOT NULL);
    CREATE TABLE semantic_segments (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, msg_start INTEGER NOT NULL, msg_end INTEGER NOT NULL,
      start_time TEXT, end_time TEXT, parent_id INTEGER, level INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL,
      token_count INTEGER NOT NULL, summarized INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      summary_token_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  const insMsg = db.prepare("INSERT INTO messages (session_id, msg_index, role, content) VALUES (?, ?, 'user', 'x')");
  for (let i = 0; i < msgCount; i++) insMsg.run(SID, i);
  const insSeg = db.prepare(
    `INSERT INTO semantic_segments (id, session_id, msg_start, msg_end, parent_id, level, summary, token_count, summarized, created_at, summary_token_count)
     VALUES (?, ?, ?, ?, ?, ?, 's', ?, ?, ?, ?)`
  );
  for (const s of segs) {
    insSeg.run(s.id, SID, s.start, s.end, s.parent ?? null, s.level ?? 0, (s.end - s.start) * 100, s.summarized ?? 1, s.created ?? "2026-09-17 00:00:00", s.tokens ?? 100);
  }
  if (lastSegmented != null) db.prepare("INSERT INTO segment_state VALUES (?, ?)").run(SID, lastSegmented);
  return db;
}

// --- clean tree ---------------------------------------------------------------

test("segment-health: perfectly tiled tree scores 100 with no findings", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 30 },
    { id: 2, start: 30, end: 60 },
    { id: 3, start: 60, end: 90 },
  ], 89);
  const r = analyzeSegmentHealth(db, SID, { budgetTokens: 1000 });
  assert.equal(r.score, 100);
  assert.equal(r.overlaps.length, 0);
  assert.equal(r.fenceposts, 0);
  assert.equal(r.gaps.length, 0);
  assert.equal(r.stragglers.length, 0);
  assert.equal(r.parentIssues.length, 0);
  assert.deepEqual(r.unsegmentedTail, { from: 90, to: 100, msgs: 10 });
  assert.equal(r.segmentState.lagMsgs, 10);
  assert.equal(r.levels[0].coveragePct, 100);
  assert.equal(r.injection?.wastePct, 0);
  assert.equal(r.injection?.segments, 3);
});

// --- overlaps ------------------------------------------------------------------

test("segment-health: 1-msg boundary overlaps are counted as fenceposts, not real overlaps", () => {
  // Incremental indexer re-includes last_segmented_msg → [0,30) then [29,60)
  const db = makeDb(60, [
    { id: 1, start: 0, end: 30 },
    { id: 2, start: 29, end: 60 },
  ]);
  const r = analyzeSegmentHealth(db, SID);
  assert.equal(r.fenceposts, 1);
  assert.equal(r.levels[0].fenceposts, 1);
  assert.equal(r.overlaps.length, 0);
  assert.equal(r.levels[0].redundantTokens, 0);
  assert.equal(r.score, 100, "fenceposts must not affect the score");
});

test("segment-health: shadowed segment is flagged and penalized", () => {
  // Re-index produced [0,52) on top of the original [0,4) and [3,52)
  const db = makeDb(60, [
    { id: 1, start: 0, end: 4, created: "2026-09-14 19:50:38" },
    { id: 2, start: 3, end: 52, created: "2026-09-15 00:32:38" },
    { id: 4, start: 0, end: 52, created: "2026-09-15 02:51:40" },
    { id: 5, start: 52, end: 60 },
  ]);
  const r = analyzeSegmentHealth(db, SID);
  const shadowed = r.overlaps.filter(o => o.shadowed);
  assert.equal(shadowed.length, 2, "#1 and #2 are both inside #4");
  assert.equal(r.levels[0].shadowed, 2);
  assert.ok(r.overlaps.every(o => !o.fencepost));
  assert.ok(r.score < 100);
  assert.ok(r.scoreBreakdown.shadowed_segments < 0);
  // sorted by level then msg_start; earlier-starting segment is always `a`
  for (const o of r.overlaps) assert.ok(o.a.msg_start <= o.b.msg_start);
});

test("segment-health: partial overlap reports msgs and % of the smaller segment", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 50 },
    { id: 2, start: 40, end: 60 },   // 10 of its 20 msgs overlap #1 → 50%
    { id: 3, start: 60, end: 100 },
  ]);
  const r = analyzeSegmentHealth(db, SID);
  assert.equal(r.overlaps.length, 1);
  assert.equal(r.overlaps[0].msgs, 10);
  assert.equal(r.overlaps[0].pctOfSmaller, 50);
  assert.equal(r.overlaps[0].shadowed, false);
  assert.equal(r.levels[0].redundantMsgs, 10);
  assert.equal(r.levels[0].redundantTokens, 50, "half of the smaller segment's 100 tokens");
});

// --- gaps ----------------------------------------------------------------------

test("segment-health: uncovered message ranges are reported as gaps per level", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 30 },
    { id: 2, start: 45, end: 70 },   // hole 30–45
    { id: 3, start: 70, end: 100 },
  ]);
  const r = analyzeSegmentHealth(db, SID);
  assert.deepEqual(r.gaps, [{ level: 0, from: 30, to: 45, msgs: 15 }]);
  assert.equal(r.levels[0].gapMsgs, 15);
  assert.equal(r.levels[0].coveragePct, 85);
  assert.equal(r.unsegmentedTail, null, "tail fully covered");
  assert.ok(r.scoreBreakdown.l0_gaps < 0);
});

test("segment-health: L0 gap at the very start is detected (coverage anchored at first message)", () => {
  const db = makeDb(50, [{ id: 1, start: 10, end: 50 }]);
  const r = analyzeSegmentHealth(db, SID);
  assert.deepEqual(r.gaps, [{ level: 0, from: 0, to: 10, msgs: 10 }]);
});

// --- hierarchy -----------------------------------------------------------------

test("segment-health: stragglers are orphans sitting before the newest parent above them", () => {
  const db = makeDb(300, [
    { id: 1, start: 0, end: 100, parent: 10 },
    { id: 2, start: 100, end: 200, parent: 10 },
    { id: 3, start: 50, end: 60, parent: null, created: "2026-09-17 06:00:00" }, // late-summarized orphan inside a rolled-up range
    { id: 4, start: 200, end: 300, parent: null },                                // legit tail orphan
    { id: 10, start: 0, end: 200, level: 1 },
  ]);
  const r = analyzeSegmentHealth(db, SID);
  assert.equal(r.stragglers.length, 1);
  assert.equal(r.stragglers[0].id, 3);
  assert.equal(r.levels[0].orphans, 2);
  assert.equal(r.levels[0].stragglers, 1);
});

test("segment-health: parent/child inconsistencies — holes, range mismatch, childless, outside", () => {
  const db = makeDb(500, [
    // parent 20 claims [0,300) but children only cover [0,50) ∪ [250,300)
    { id: 1, start: 0, end: 50, parent: 20 },
    { id: 2, start: 250, end: 300, parent: 20 },
    { id: 20, start: 0, end: 300, level: 1 },
    // parent 21 [300,400) with a child that pokes outside
    { id: 3, start: 300, end: 420, parent: 21 },
    { id: 21, start: 300, end: 400, level: 1 },
    // parent 22 with no children
    { id: 22, start: 400, end: 500, level: 1 },
  ]);
  const r = analyzeSegmentHealth(db, SID);
  const kinds = r.parentIssues.map(p => `${p.parent.id}:${p.kind}`).sort();
  assert.deepEqual(kinds, [
    "20:non-contiguous-children",
    "21:child-outside-parent",
    "21:range-mismatch",
    "22:childless",
  ]);
  const hole = r.parentIssues.find(p => p.parent.id === 20)!;
  assert.match(hole.detail, /50–250/);
});

// --- injection simulation -------------------------------------------------------

test("segment-health: injection waste counts tokens of selected segments already covered", () => {
  // Two orphans overlapping by 60 of 100 msgs (neither contains the other, so the
  // #364 A4 root dedupe leaves both in) → 60% of the smaller one is redundant.
  const db = makeDb(140, [
    { id: 1, start: 0, end: 100, tokens: 400 },
    { id: 2, start: 40, end: 140, tokens: 600, created: "2026-09-17 09:00:00" },
  ]);
  const r = analyzeSegmentHealth(db, SID, { budgetTokens: 5000 });
  assert.ok(r.injection);
  assert.equal(r.injection.segments, 2);
  assert.equal(r.injection.tokens, 1000);
  assert.ok(r.injection.redundantTokens > 0);
  assert.ok(r.injection.wastePct > 0);
});

test("segment-health: a fully shadowed root is deduped out of the injection (A4)", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 100, tokens: 400 },
    { id: 2, start: 0, end: 100, tokens: 600, created: "2026-09-17 09:00:00" },
  ]);
  const r = analyzeSegmentHealth(db, SID, { budgetTokens: 5000 });
  assert.ok(r.injection);
  assert.equal(r.injection.segments, 1);
  assert.equal(r.injection.tokens, 400);
  assert.equal(r.injection.redundantTokens, 0);
  // The tree is still unhealthy — the shadow is reported as an overlap, just not injected.
  assert.equal(r.overlaps.length, 1);
});

test("segment-health: injection expands parents into children when budget allows, like composeHistory", () => {
  const db = makeDb(200, [
    { id: 1, start: 0, end: 100, parent: 10, tokens: 300 },
    { id: 2, start: 100, end: 200, parent: 10, tokens: 300 },
    { id: 10, start: 0, end: 200, level: 1, tokens: 200 },
  ]);
  const tight = analyzeSegmentHealth(db, SID, { budgetTokens: 250 });
  assert.deepEqual(tight.injection?.levelCounts, { 1: 1 });
  const roomy = analyzeSegmentHealth(db, SID, { budgetTokens: 1000 });
  assert.deepEqual(roomy.injection?.levelCounts, { 0: 2 });
  assert.equal(roomy.injection?.tokens, 600);
});

test("segment-health: unsummarized segments are excluded from injection but counted in the table", () => {
  const db = makeDb(100, [
    { id: 1, start: 0, end: 50 },
    { id: 2, start: 50, end: 100, summarized: 0 },
  ]);
  const r = analyzeSegmentHealth(db, SID);
  assert.equal(r.levels[0].segments, 2);
  assert.equal(r.levels[0].summarized, 1);
  assert.equal(r.injection?.segments, 1);
});

// --- selectHistorySegments (extracted from composeHistory) ---------------------

const hs = (id: number, level: number, start: number, end: number, tokens: number, parent: number | null = null): HistorySegment =>
  ({ id, level, msg_start: start, msg_end: end, start_time: null, end_time: null, summary: "s", token_count: 0, summary_token_count: tokens, parent_id: parent });

test("selectHistorySegments: snaps the trim boundary down to the nearest L0 end", () => {
  const segs = [hs(1, 0, 0, 30, 10), hs(2, 0, 30, 60, 10), hs(3, 0, 60, 90, 10)];
  const r = selectHistorySegments(segs, 75, 1000)!;
  assert.equal(r.snappedBoundary, 60);
  assert.deepEqual(r.selected.map(s => s.id), [1, 2]);
});

test("selectHistorySegments: returns null when nothing lies before the boundary", () => {
  assert.equal(selectHistorySegments([hs(1, 0, 50, 90, 10)], 10, 1000), null);
  assert.equal(selectHistorySegments([], 10, 1000), null);
});

test("selectHistorySegments: expands highest level first, most recent first", () => {
  const segs = [
    hs(1, 0, 0, 50, 100, 10), hs(2, 0, 50, 100, 100, 10),
    hs(3, 0, 100, 150, 100, 11), hs(4, 0, 150, 200, 100, 11),
    hs(10, 1, 0, 100, 50), hs(11, 1, 100, 200, 50),
  ];
  // budget 100 fits both L1s; budget 250 allows exactly one expansion (delta +150) → the recent one (#11)
  const r = selectHistorySegments(segs, 200, 250)!;
  assert.deepEqual(r.selected.map(s => s.id), [10, 3, 4]);
  assert.equal(r.tokens, 250);
});

// --- formatting ----------------------------------------------------------------

test("formatHealthReport: truncates long lists at --limit and says how many more", () => {
  const segs: Seg[] = [];
  for (let i = 0; i < 15; i++) {
    segs.push({ id: i * 2 + 1, start: i * 100, end: i * 100 + 60 });
    segs.push({ id: i * 2 + 2, start: i * 100 + 30, end: i * 100 + 100 }); // 30-msg overlap each
  }
  const r = analyzeSegmentHealth(makeDb(1500, segs), SID);
  assert.equal(r.overlaps.length, 15);
  const text = formatHealthReport(r, { limit: 10, color: false });
  assert.match(text, /Overlaps \(15\)/);
  assert.match(text, /… 5 more overlaps \(use --limit 15 to show all\)/);
  assert.equal((text.match(/→ 30 msgs/g) || []).length, 10);
  assert.match(text, /Health: \d+\/100/);
});

test("formatHealthReport: clean tree prints table, injection line, and 100/100", () => {
  const r = analyzeSegmentHealth(makeDb(100, [{ id: 1, start: 0, end: 100 }], 99), SID, { budgetTokens: 500 });
  const text = formatHealthReport(r, { color: false });
  assert.match(text, /^Session sess-1 {2}messages 0–99 \(100\) {2}indexed to 99$/m);
  assert.match(text, /^L0 +1 +1 +1 +0 +0 +0 +0 +0 +0 +0–100 \(100%\)$/m);
  assert.doesNotMatch(text, /Overlaps \(|Gaps \(|Stragglers \(|Parent\/child|Fencepost overlaps/);
  assert.match(text, /1 segments \(1×L0\), 100 tok, 0 redundant \(0% waste\)/);
  assert.match(text, /Health: 100\/100$/);
});
