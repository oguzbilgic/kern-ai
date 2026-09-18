/**
 * Segment tree prune.
 *
 * Recovery for recall.db summary trees that violate the single-branch invariant
 * (each level tiles [0, indexed_end) with no gaps and no overlaps; every child
 * lies inside its parent). Damage comes from three sources — re-index shifts
 * that lay a second tiling next to the first, straggler rollups that build a
 * parent over siblings it doesn't own, and the 1-msg fencepost at chunk
 * boundaries. See kern-ai#364 / #365.
 *
 * Prune is pure selection — zero LLM calls. Per level, bottom-up:
 *
 *   1. Validate parents (level ≥ 1): a parent survives only if every child it
 *      had is still alive and the children tile its range exactly. Otherwise
 *      delete the parent and orphan the surviving children.
 *   2. Select the tiling: min-overlap path from msg 0 to the level's coverage
 *      end over the surviving segments. Edge A→B allowed if B.start ≤ A.end,
 *      cost = overlap msgs (1-msg fencepost is free). Ties: prefer segments
 *      that already have a parent, then oldest created_at — the original
 *      tiling is what the tree above was built on; the re-index is the intruder.
 *   3. Delete everything at the level not on the path.
 *
 * Upper levels regrow on their own: the next indexSession → rollUpLevels pass
 * re-batches the orphans (requires the contiguity fix from #364 to be live).
 *
 * planPrune() is pure over rows; applyPrune() runs the plan in one transaction.
 */

import type Database from "better-sqlite3";
import type { SegRow } from "./segment-health.js";

export type DeleteReason =
  | "off-path"          // same-level segment not on the selected tiling
  | "invalid-parent"    // children missing or children union ≠ parent range
  | "childless-parent"; // level ≥ 1 with no children at all

export interface PruneDeletion {
  id: number;
  level: number;
  msg_start: number;
  msg_end: number;
  parent_id: number | null;
  created_at: string;
  reason: DeleteReason;
  detail?: string;
}

export interface PruneOrphan {
  id: number;
  level: number;
  msg_start: number;
  msg_end: number;
  formerParent: number;
}

export interface ResidualOverlap {
  level: number;
  a: number;
  b: number;
  msgs: number;
}

export interface LevelPlan {
  level: number;
  before: number;
  kept: number;
  deleted: number;
  orphaned: number;        // segments at this level whose parent (level+1) was deleted
  pathOverlap: number;     // non-fencepost overlap msgs remaining on the selected tiling
  pathGap: number;         // msgs at this level left uncovered by the selected tiling (L1+: orphans below, self-heals)
  coverageEnd: number;
  tilingFound: boolean;    // false → level left untouched
}

export interface PrunePlan {
  sessionId: string;
  deletions: PruneDeletion[];
  orphans: PruneOrphan[];
  residual: ResidualOverlap[];   // nonzero-cost edges left on the path (kept; needs re-index to clean)
  levels: LevelPlan[];
}

interface Node extends SegRow {
  alive: boolean;
}

function isFencepost(prevEnd: number, nextStart: number): boolean {
  return nextStart === prevEnd - 1;
}

/**
 * Min-cost cover of [from, target) by a chain of segments, in msg_start order.
 * Edge A→B for any B that starts after A and extends coverage; gaps and
 * overlaps both allowed and both costed:
 *   overlap = msgs both cover (1-msg fencepost is free)
 *   gap     = msgs neither covers
 * Cost is lexicographic. At L0 gaps come first — a hole at L0 never heals
 * (indexSession only moves forward), an overlap only wastes tokens. At L1+
 * overlap comes first — a hole there is just orphans below, and the next
 * rollUpLevels fills it. Then: fewer orphans, then oldest created_at.
 * Returns null only if nothing survives at the level.
 */
function selectTiling(segs: Node[], from: number, target: number, level: number): { path: Node[]; overlap: number; gap: number } | null {
  const alive = segs.filter(s => s.alive).sort((a, b) => a.msg_start - b.msg_start || a.msg_end - b.msg_end);
  if (alive.length === 0) return null;

  const byAge = [...alive].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  const ageRank = new Map<number, number>(byAge.map((s, i) => [s.id, i]));

  // [primary, secondary, unsummarized, orphans, age]  where primary/secondary = (gap, overlap) at L0, (overlap, gap) at L1+
  type Cost = [number, number, number, number, number];
  const less = (x: Cost, y: Cost) => {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  };
  const pref = (seg: Node): [number, number, number] => [seg.summarized ? 0 : 1, seg.parent_id == null ? 1 : 0, ageRank.get(seg.id) ?? 0];
  const step = (x: Cost, seg: Node, overlap: number, gap: number): Cost => {
    const [u, o, a] = pref(seg);
    return level === 0
      ? [x[0] + gap, x[1] + overlap, x[2] + u, x[3] + o, x[4] + a]
      : [x[0] + overlap, x[1] + gap, x[2] + u, x[3] + o, x[4] + a];
  };
  const edgeCost = (prevEnd: number, next: Node): { overlap: number; gap: number } => {
    const d = prevEnd - next.msg_start;
    if (d > 0) return { overlap: isFencepost(prevEnd, next.msg_start) ? 0 : d, gap: 0 };
    return { overlap: 0, gap: -d };
  };

  const best = new Map<number, Cost>();
  const prev = new Map<number, number | null>();
  for (const s of alive) {
    const { overlap, gap } = edgeCost(from, s);
    const c = step([0, 0, 0, 0, 0], s, overlap, gap);
    if (!best.has(s.id) || less(c, best.get(s.id)!)) { best.set(s.id, c); prev.set(s.id, null); }
  }

  // Segments sorted by msg_start form a DAG under "starts later and ends later" — single forward pass relaxes all.
  for (const a of alive) {
    const ca = best.get(a.id);
    if (!ca) continue;
    for (const b of alive) {
      if (b.msg_start <= a.msg_start) continue;
      if (b.msg_end <= a.msg_end) continue;
      const { overlap, gap } = edgeCost(a.msg_end, b);
      const cb = step(ca, b, overlap, gap);
      if (!best.has(b.id) || less(cb, best.get(b.id)!)) { best.set(b.id, cb); prev.set(b.id, a.id); }
    }
  }

  // Terminal: lowest cost including the trailing gap to target.
  let end: Node | null = null;
  let endCost: Cost | null = null;
  for (const s of alive) {
    const c = best.get(s.id);
    if (!c) continue;
    const tail = Math.max(0, target - s.msg_end);
    const total: Cost = level === 0 ? [c[0] + tail, c[1], c[2], c[3], c[4]] : [c[0], c[1] + tail, c[2], c[3], c[4]];
    if (!endCost || less(total, endCost)) { end = s; endCost = total; }
  }
  if (!end || !endCost) return null;

  const byId = new Map<number, Node>(alive.map(s => [s.id, s]));
  const path: Node[] = [];
  let cur: number | null = end.id;
  while (cur != null) {
    path.unshift(byId.get(cur)!);
    cur = prev.get(cur) ?? null;
  }
  const overlap = level === 0 ? endCost[1] : endCost[0];
  const gap = level === 0 ? endCost[0] : endCost[1];
  return { path, overlap, gap };
}

export interface PlanOptions {
  /** First message index of the session (`MIN(msg_index)`). Anchors the L0 tiling so a
   *  leading gap is charged exactly as segment-health reports it. Defaults to the
   *  earliest segment start when unknown. */
  sessionStart?: number;
}

export function planPrune(rows: SegRow[], sessionId: string, opts: PlanOptions = {}): PrunePlan {
  const nodes: Node[] = rows.map(r => ({ ...r, alive: true }));
  const byId = new Map<number, Node>(nodes.map(n => [n.id, n]));
  const byLevel = new Map<number, Node[]>();
  for (const n of nodes) {
    const arr = byLevel.get(n.level) || [];
    arr.push(n);
    byLevel.set(n.level, arr);
  }
  const levelsPresent = [...byLevel.keys()].sort((a, b) => a - b);

  // Children as recorded in the DB (before any prune) — a parent is judged
  // against the children it actually had, not just the survivors.
  const childrenOf = new Map<number, Node[]>();
  const deletions: PruneDeletion[] = [];
  const orphans: PruneOrphan[] = [];
  for (const n of nodes) {
    if (n.parent_id == null) continue;
    if (!byId.has(n.parent_id)) {
      // Dangling reference: the parent row is gone (FKs are not enforced on the production
      // connection). rollUpLevels only re-batches `parent_id IS NULL`, so this child would
      // never be re-rolled — detach it now so it becomes a real orphan.
      orphans.push({ id: n.id, level: n.level, msg_start: n.msg_start, msg_end: n.msg_end, formerParent: n.parent_id });
      n.parent_id = null;
      continue;
    }
    const arr = childrenOf.get(n.parent_id) || [];
    arr.push(n);
    childrenOf.set(n.parent_id, arr);
  }

  const residual: ResidualOverlap[] = [];
  const levels: LevelPlan[] = [];
  // One floor for every level, on purpose: the invariant is that each level tiles the
  // whole indexed range. An L1 that only starts at msg 8056 while L0 starts at 0 has a
  // real gap — those L0s are parentless — and the plan should say so. A leading gap costs
  // the same on every candidate path, so it never changes which segments are selected.
  const floor = opts.sessionStart ?? (nodes.length ? Math.min(...nodes.map(n => n.msg_start)) : 0);

  const kill = (n: Node, reason: DeleteReason, detail?: string) => {
    if (!n.alive) return;
    n.alive = false;
    deletions.push({
      id: n.id, level: n.level, msg_start: n.msg_start, msg_end: n.msg_end,
      parent_id: n.parent_id, created_at: n.created_at, reason, detail,
    });
    // Surviving children lose their parent.
    for (const c of childrenOf.get(n.id) || []) {
      if (c.alive && c.parent_id === n.id) {
        orphans.push({ id: c.id, level: c.level, msg_start: c.msg_start, msg_end: c.msg_end, formerParent: n.id });
        c.parent_id = null;
      }
    }
  };

  for (const level of levelsPresent) {
    const all = byLevel.get(level)!;
    const before = all.length;

    // 1. Parent validation (level ≥ 1). Judged against surviving children only:
    //    losing a shadowed duplicate is fine as long as what's left still tiles
    //    the parent's range exactly. A hole means the parent summarizes content
    //    it never saw (or claims a range it doesn't own) → delete.
    if (level > 0) {
      // Every parent row, summarized or pending: rollUpLevels assigns children at
      // creation, so the tiling invariant holds from the moment the row exists.
      for (const p of all) {
        const had = childrenOf.get(p.id) || [];
        const kids = had.filter(k => k.alive).sort((a, b) => a.msg_start - b.msg_start);
        if (had.length === 0) { kill(p, "childless-parent"); continue; }
        if (kids.length === 0) { kill(p, "invalid-parent", `all ${had.length} children pruned`); continue; }
        let ok = kids[0].msg_start === p.msg_start && kids[kids.length - 1].msg_end === p.msg_end;
        let hole: string | null = null;
        for (let i = 1; ok && i < kids.length; i++) {
          const d = kids[i].msg_start - kids[i - 1].msg_end;
          if (d !== 0 && !isFencepost(kids[i - 1].msg_end, kids[i].msg_start)) {
            ok = false;
            hole = d > 0 ? `hole ${kids[i - 1].msg_end}–${kids[i].msg_start}` : `children overlap ${-d} msgs at ${kids[i].msg_start}`;
          }
        }
        if (!ok) {
          const union = `[${kids[0].msg_start}–${kids[kids.length - 1].msg_end})`;
          const pruned = had.length - kids.length;
          kill(p, "invalid-parent", `${hole ?? `children union ${union} ≠ range`}${pruned ? ` (${pruned}/${had.length} children pruned)` : ""}`);
        }
      }
    }

    // 2. Tiling selection over survivors — pending (unsummarized) rows included so a
    //    fresh re-index intruder is removed before it costs a summarizer call; the
    //    cost function prefers summarized rows so a pending tail segment only wins
    //    where nothing summarized covers that range.
    const survivors = all.filter(s => s.alive);
    const coverageEnd = survivors.length ? Math.max(...survivors.map(s => s.msg_end)) : 0;
    const sel = survivors.length ? selectTiling(survivors, floor, coverageEnd, level) : null;

    if (!sel) {
      levels.push({
        level, before, kept: survivors.length, deleted: before - survivors.length,
        orphaned: 0, pathOverlap: 0, pathGap: 0, coverageEnd, tilingFound: false,
      });
      continue;
    }

    const onPath = new Set(sel.path.map(s => s.id));
    for (const s of survivors) {
      if (!onPath.has(s.id)) kill(s, "off-path");
    }
    for (let i = 1; i < sel.path.length; i++) {
      const a = sel.path[i - 1], b = sel.path[i];
      const raw = a.msg_end - b.msg_start;
      if (raw > 0 && !isFencepost(a.msg_end, b.msg_start)) residual.push({ level, a: a.id, b: b.id, msgs: raw });
    }

    const keptCount = sel.path.length;
    levels.push({
      level, before, kept: keptCount, deleted: before - keptCount,
      orphaned: 0, pathOverlap: sel.overlap, pathGap: sel.gap, coverageEnd, tilingFound: true,
    });
  }

  // Orphan counts per level (children of parents deleted above them).
  for (const lp of levels) lp.orphaned = orphans.filter(o => o.level === lp.level).length;

  return { sessionId, deletions, orphans, residual, levels };
}

export function sessionStart(db: Database.Database, sessionId: string): number | undefined {
  const r = db.prepare("SELECT MIN(msg_index) AS m FROM messages WHERE session_id = ?").get(sessionId) as { m: number | null } | undefined;
  return r?.m ?? undefined;
}

/** True if `vec_segments` exists on this connection (needs sqlite-vec loaded to be usable). */
export function hasVecSegments(db: Database.Database): boolean {
  const r = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_segments'").get();
  return !!r;
}

export function loadSegmentRows(db: Database.Database, sessionId: string): SegRow[] {
  return db.prepare(
    `SELECT id, session_id, msg_start, msg_end, start_time, end_time, parent_id, level, summary,
            token_count, summary_token_count, summarized, created_at
     FROM semantic_segments WHERE session_id = ? ORDER BY level ASC, msg_start ASC, msg_end ASC`
  ).all(sessionId) as SegRow[];
}

/**
 * Run the plan. One transaction: null orphaned parent_ids, delete rows, and delete the
 * matching `vec_segments` rows (segment embeddings, rowid = segment id).
 *
 * `vec_segments` is a sqlite-vec `vec0` virtual table; the caller's connection must have
 * `sqliteVec.load(db)` applied or the DELETE cannot be prepared. That is an error, not a
 * skip — leaving embeddings for deleted segments would make recall return dead ids.
 * A DB with no `vec_segments` table at all (test fixtures, stripped copies) is fine.
 */
export function applyPrune(db: Database.Database, plan: PrunePlan): { deleted: number; orphaned: number } {
  const delStmt = db.prepare("DELETE FROM semantic_segments WHERE id = ?");
  const orphanStmt = db.prepare("UPDATE semantic_segments SET parent_id = NULL WHERE id = ?");
  let vecStmt: Database.Statement | null = null;
  if (hasVecSegments(db)) {
    try {
      vecStmt = db.prepare("DELETE FROM vec_segments WHERE rowid = ?");
    } catch (err) {
      throw new Error(`vec_segments exists but cannot be opened (sqlite-vec not loaded on this connection?): ${(err as Error).message}`);
    }
  }

  const tx = db.transaction(() => {
    // parent_id has a FK to semantic_segments.id: detach surviving children first,
    // then delete lower levels before their parents (deletions are level-ascending).
    for (const o of plan.orphans) orphanStmt.run(o.id);
    for (const d of [...plan.deletions].sort((a, b) => a.level - b.level)) {
      delStmt.run(d.id);
      if (vecStmt) vecStmt.run(d.id);
    }
  });
  tx();
  return { deleted: plan.deletions.length, orphaned: plan.orphans.length };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function pad(s: string | number, w: number, right = false): string {
  const str = String(s);
  return right ? str.padEnd(w) : str.padStart(w);
}

export function formatPrunePlan(plan: PrunePlan, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 10;
  const out: string[] = [];

  out.push(`${pad("Level", 6, true)} ${pad("Before", 7)} ${pad("Kept", 6)} ${pad("Del", 6)} ${pad("Orph", 6)} ${pad("Ovlp", 6)} ${pad("Gap", 6)}  Coverage`);
  for (const l of plan.levels) {
    out.push(
      `${pad(`L${l.level}`, 6, true)} ${pad(l.before, 7)} ${pad(l.kept, 6)} ${pad(l.deleted, 6)} ${pad(l.orphaned, 6)} ${pad(l.pathOverlap, 6)} ${pad(l.pathGap, 6)}  0–${l.coverageEnd}${l.tilingFound ? "" : "  (nothing alive)"}`
    );
  }
  out.push("");

  const byReason: Record<string, PruneDeletion[]> = {};
  for (const d of plan.deletions) (byReason[d.reason] ||= []).push(d);
  for (const [reason, ds] of Object.entries(byReason)) {
    out.push(`Delete — ${reason} (${ds.length}):`);
    for (const d of ds.slice(0, limit)) {
      out.push(`  L${d.level} #${d.id} [${d.msg_start}–${d.msg_end}) ${d.created_at.slice(5, 16)}${d.parent_id != null ? ` parent #${d.parent_id}` : ""}${d.detail ? `  — ${d.detail}` : ""}`);
    }
    if (ds.length > limit) out.push(`  … ${ds.length - limit} more`);
    out.push("");
  }

  if (plan.orphans.length) {
    const perLevel = new Map<number, number>();
    for (const o of plan.orphans) perLevel.set(o.level, (perLevel.get(o.level) || 0) + 1);
    out.push(`Orphaned (parent deleted; next rollUpLevels re-batches): ${[...perLevel.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `L${l} ${n}`).join(", ")}`);
    out.push("");
  }

  if (plan.residual.length) {
    out.push(`Residual overlaps kept on the tiling (need re-index to clean) (${plan.residual.length}):`);
    for (const r of plan.residual.slice(0, limit)) out.push(`  L${r.level} #${r.a} → #${r.b}  ${r.msgs} msgs`);
    if (plan.residual.length > limit) out.push(`  … ${plan.residual.length - limit} more`);
    out.push("");
  }

  out.push(`Total: delete ${plan.deletions.length}, orphan ${plan.orphans.length}. Zero LLM calls.`);
  return out.join("\n");
}
