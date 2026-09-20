/**
 * Segment health analyzer.
 *
 * Read-only diagnostics over the semantic summary tree in recall.db. The tree
 * has one invariant that should hold at every level: segments tile the message
 * range exactly — no overlaps, no gaps — and every child lies inside its parent.
 * Everything reported here is a violation of that invariant, plus the practical
 * consequence: how many redundant tokens the agent is actually injecting.
 *
 * Pure: takes an open better-sqlite3 handle, never writes.
 * Used by `kern scripts segment-health`.
 */

import type Database from "better-sqlite3";
import { selectHistorySegments, type HistorySegment } from "../../segments.js";

// msg_end is EXCLUSIVE throughout (segments.ts stores messages[end-1].msg_index + 1),
// so [3,52) and [52,73) are contiguous with zero overlap.

export interface SegRow extends HistorySegment {
  summarized: number;
  created_at: string;
}

export interface Overlap {
  a: SegRef;
  b: SegRef;
  msgs: number;            // overlapping message count
  pctOfSmaller: number;    // overlap / min(span a, span b), 0–100
  shadowed: boolean;       // one range fully contains the other
  fencepost: boolean;      // exactly 1 msg at a chunk boundary — indexSession off-by-one, not a re-index artifact
}

export interface Gap {
  from: number;            // first uncovered msg index
  to: number;              // exclusive
  msgs: number;
}

export interface SegRef {
  id: number;
  level: number;
  msg_start: number;
  msg_end: number;
  summary_tokens: number;
  created_at: string;
  parent_id: number | null;
}

export interface ParentIssue {
  parent: SegRef;
  kind: "range-mismatch" | "non-contiguous-children" | "childless" | "child-outside-parent";
  detail: string;
}

export interface LevelReport {
  level: number;
  segments: number;
  summarized: number;
  orphans: number;         // parent_id IS NULL
  stragglers: number;      // orphans that sit before the last parent at level+1 — will be mis-batched
  overlaps: number;        // real overlaps (≥2 msgs or shadowed); fenceposts excluded
  fenceposts: number;      // 1-msg boundary overlaps (incremental indexer re-includes last_segmented_msg)
  shadowed: number;        // segments fully contained in another same-level segment
  redundantMsgs: number;   // sum of overlapping message counts (fenceposts excluded)
  redundantTokens: number; // summary tokens attributable to real overlap (approx, fenceposts excluded)
  gaps: number;
  gapMsgs: number;
  span: [number, number];  // [min start, max end)
  coveredMsgs: number;     // distinct messages covered
  coveragePct: number;     // coveredMsgs / (span width)
}

export interface InjectionReport {
  budgetTokens: number;
  trimmedBeforeMsg: number;
  snappedBoundary: number;
  segments: number;
  levelCounts: Record<number, number>;
  tokens: number;
  redundantTokens: number; // tokens in selected segments whose message range is already covered by an earlier selected segment
  wastePct: number;
  coveredMsgs: number;
  gapMsgs: number;         // messages in [0, snappedBoundary) not covered by any selected segment
}

export interface HealthReport {
  sessionId: string;
  messages: { count: number; minIndex: number; maxIndex: number };
  segmentState: { lastSegmentedMsg: number | null; lagMsgs: number };
  unsegmentedTail: { from: number; to: number; msgs: number } | null;
  levels: LevelReport[];
  overlaps: Overlap[];        // real overlaps only, sorted by level asc then msg_start
  fenceposts: number;         // total 1-msg boundary overlaps across levels
  gaps: Array<Gap & { level: number }>;
  stragglers: SegRef[];
  parentIssues: ParentIssue[];
  injection: InjectionReport | null;
  score: number;              // 0–100
  scoreBreakdown: Record<string, number>;
}

function ref(s: SegRow): SegRef {
  return {
    id: s.id, level: s.level, msg_start: s.msg_start, msg_end: s.msg_end,
    summary_tokens: s.summary_token_count, created_at: s.created_at, parent_id: s.parent_id,
  };
}

function overlapMsgs(a: { msg_start: number; msg_end: number }, b: { msg_start: number; msg_end: number }): number {
  return Math.max(0, Math.min(a.msg_end, b.msg_end) - Math.max(a.msg_start, b.msg_start));
}

/** Count distinct messages covered by a set of [start,end) ranges, and the holes between them. */
function coverage(ranges: Array<{ msg_start: number; msg_end: number }>, from?: number, to?: number): { covered: number; gaps: Gap[]; span: [number, number] } {
  if (ranges.length === 0) return { covered: 0, gaps: [], span: [0, 0] };
  const sorted = [...ranges].sort((a, b) => a.msg_start - b.msg_start || a.msg_end - b.msg_end);
  const lo = from ?? sorted[0].msg_start;
  const hi = to ?? Math.max(...sorted.map(r => r.msg_end));
  const gaps: Gap[] = [];
  let covered = 0;
  let cursor = lo;
  for (const r of sorted) {
    const s = Math.max(r.msg_start, lo);
    const e = Math.min(r.msg_end, hi);
    if (e <= s) continue;
    if (s > cursor) gaps.push({ from: cursor, to: s, msgs: s - cursor });
    if (e > cursor) {
      covered += e - Math.max(s, cursor);
      cursor = e;
    }
  }
  if (cursor < hi) gaps.push({ from: cursor, to: hi, msgs: hi - cursor });
  return { covered, gaps, span: [lo, hi] };
}

export interface AnalyzeOptions {
  /** Summary token budget to simulate injection with. Default 75_000 (100k ctx × 0.75). */
  budgetTokens?: number;
  /** Trim boundary to simulate. Default: end of last L0 segment (everything summarized is trimmed). */
  trimmedBeforeMsg?: number;
}

export function listSessions(db: Database.Database): Array<{ session_id: string; count: number; maxIndex: number; segments: number }> {
  return db.prepare(
    `SELECT m.session_id, COUNT(*) AS count, MAX(m.msg_index) AS maxIndex,
            (SELECT COUNT(*) FROM semantic_segments s WHERE s.session_id = m.session_id) AS segments
     FROM messages m GROUP BY m.session_id ORDER BY count DESC`
  ).all() as any;
}

export function analyzeSegmentHealth(db: Database.Database, sessionId: string, opts: AnalyzeOptions = {}): HealthReport {
  const msgRow = db.prepare(
    "SELECT COUNT(*) AS count, MIN(msg_index) AS minIndex, MAX(msg_index) AS maxIndex FROM messages WHERE session_id = ?"
  ).get(sessionId) as { count: number; minIndex: number | null; maxIndex: number | null };
  const messages = { count: msgRow.count, minIndex: msgRow.minIndex ?? 0, maxIndex: msgRow.maxIndex ?? -1 };

  const stateRow = db.prepare("SELECT last_segmented_msg FROM segment_state WHERE session_id = ?").get(sessionId) as { last_segmented_msg: number } | undefined;
  const lastSegmentedMsg = stateRow?.last_segmented_msg ?? null;
  const segmentState = {
    lastSegmentedMsg,
    lagMsgs: lastSegmentedMsg == null ? messages.count : Math.max(0, messages.maxIndex - lastSegmentedMsg),
  };

  const rows = db.prepare(
    `SELECT id, session_id, msg_start, msg_end, start_time, end_time, parent_id, level, summary,
            token_count, summary_token_count, summarized, created_at
     FROM semantic_segments WHERE session_id = ? ORDER BY level ASC, msg_start ASC, msg_end ASC`
  ).all(sessionId) as SegRow[];

  const byId = new Map<number, SegRow>(rows.map(r => [r.id, r]));
  const byLevel = new Map<number, SegRow[]>();
  for (const r of rows) {
    const arr = byLevel.get(r.level) || [];
    arr.push(r);
    byLevel.set(r.level, arr);
  }
  const levelsPresent = [...byLevel.keys()].sort((a, b) => a - b);

  const overlaps: Overlap[] = [];
  const gaps: Array<Gap & { level: number }> = [];
  const stragglers: SegRef[] = [];
  const levels: LevelReport[] = [];

  for (const level of levelsPresent) {
    const segs = byLevel.get(level)!;
    const upper = byLevel.get(level + 1) || [];
    const lastParentEnd = upper.length ? Math.max(...upper.map(s => s.msg_end)) : -1;

    // Overlaps: O(n log n) sweep — each segment vs. following ones that start before it ends.
    let redundantMsgs = 0;
    let redundantTokens = 0;
    const shadowedIds = new Set<number>();
    let levelOverlaps = 0;
    let levelFenceposts = 0;
    for (let i = 0; i < segs.length; i++) {
      const a = segs[i];
      for (let j = i + 1; j < segs.length; j++) {
        const b = segs[j];
        if (b.msg_start >= a.msg_end) break; // sorted by msg_start; no later b can overlap a
        const ov = overlapMsgs(a, b);
        if (ov <= 0) continue;
        const spanA = a.msg_end - a.msg_start;
        const spanB = b.msg_end - b.msg_start;
        const smaller = Math.max(1, Math.min(spanA, spanB));
        const shadowed = (a.msg_start <= b.msg_start && b.msg_end <= a.msg_end) || (b.msg_start <= a.msg_start && a.msg_end <= b.msg_end);
        if (shadowed) {
          // the contained one is the shadow (tie → the newer id)
          const inner = spanA < spanB ? a : spanB < spanA ? b : b;
          shadowedIds.add(inner.id);
        }
        const fencepost = ov === 1 && !shadowed;
        if (fencepost) {
          levelFenceposts++;
          continue;
        }
        overlaps.push({ a: ref(a), b: ref(b), msgs: ov, pctOfSmaller: Math.round((100 * ov) / smaller), shadowed, fencepost });
        levelOverlaps++;
        redundantMsgs += ov;
        // attribute the smaller segment's tokens proportionally to the overlap
        const smallerSeg = spanA <= spanB ? a : b;
        redundantTokens += Math.round(smallerSeg.summary_token_count * (ov / smaller));
      }
    }

    // Gaps: L0 spans from the first message to the last L0 end; higher levels span their own min/max.
    const from = level === 0 ? messages.minIndex : undefined;
    const cov = coverage(segs, from);
    for (const g of cov.gaps) gaps.push({ ...g, level });

    // Stragglers: orphans lying entirely before the last parent at level+1.
    const orphans = segs.filter(s => s.parent_id == null);
    const levelStragglers = orphans.filter(s => s.msg_end <= lastParentEnd);
    for (const s of levelStragglers) stragglers.push(ref(s));

    const spanWidth = Math.max(1, cov.span[1] - cov.span[0]);
    levels.push({
      level,
      segments: segs.length,
      summarized: segs.filter(s => s.summarized).length,
      orphans: orphans.length,
      stragglers: levelStragglers.length,
      overlaps: levelOverlaps,
      fenceposts: levelFenceposts,
      shadowed: shadowedIds.size,
      redundantMsgs,
      redundantTokens,
      gaps: cov.gaps.length,
      gapMsgs: cov.gaps.reduce((s, g) => s + g.msgs, 0),
      span: cov.span,
      coveredMsgs: cov.covered,
      coveragePct: Math.round((100 * cov.covered) / spanWidth),
    });
  }

  // Parent/child consistency
  const parentIssues: ParentIssue[] = [];
  const childrenOf = new Map<number, SegRow[]>();
  for (const r of rows) {
    if (r.parent_id != null) {
      const arr = childrenOf.get(r.parent_id) || [];
      arr.push(r);
      childrenOf.set(r.parent_id, arr);
    }
  }
  for (const p of rows) {
    if (p.level === 0) continue;
    const kids = (childrenOf.get(p.id) || []).sort((a, b) => a.msg_start - b.msg_start);
    if (kids.length === 0) {
      parentIssues.push({ parent: ref(p), kind: "childless", detail: `L${p.level} parent has no children` });
      continue;
    }
    const outside = kids.filter(k => k.msg_start < p.msg_start || k.msg_end > p.msg_end);
    if (outside.length) {
      parentIssues.push({ parent: ref(p), kind: "child-outside-parent", detail: `children ${outside.map(k => `#${k.id} [${k.msg_start}–${k.msg_end})`).join(", ")} exceed parent range` });
    }
    const kMin = kids[0].msg_start;
    const kMax = Math.max(...kids.map(k => k.msg_end));
    if (kMin !== p.msg_start || kMax !== p.msg_end) {
      parentIssues.push({ parent: ref(p), kind: "range-mismatch", detail: `parent [${p.msg_start}–${p.msg_end}) vs children union [${kMin}–${kMax})` });
    }
    const holes: string[] = [];
    for (let i = 1; i < kids.length; i++) {
      if (kids[i].msg_start > kids[i - 1].msg_end) holes.push(`${kids[i - 1].msg_end}–${kids[i].msg_start}`);
    }
    if (holes.length) {
      parentIssues.push({ parent: ref(p), kind: "non-contiguous-children", detail: `holes between children at ${holes.join(", ")} (${holes.length} hole${holes.length > 1 ? "s" : ""})` });
    }
  }
  // Orphan children pointing at a missing parent
  for (const r of rows) {
    if (r.parent_id != null && !byId.has(r.parent_id)) {
      parentIssues.push({ parent: ref(r), kind: "childless", detail: `#${r.id} references missing parent #${r.parent_id}` });
    }
  }

  // Unsegmented tail: messages after the last L0 end that nothing summarizes yet (expected, not a gap)
  const l0 = byLevel.get(0) || [];
  const lastL0End = l0.length ? Math.max(...l0.map(s => s.msg_end)) : messages.minIndex;
  const unsegmentedTail = messages.maxIndex + 1 > lastL0End
    ? { from: lastL0End, to: messages.maxIndex + 1, msgs: messages.maxIndex + 1 - lastL0End }
    : null;

  // Injection simulation — exactly what composeHistory would select
  const budgetTokens = opts.budgetTokens ?? 75_000;
  const trimmedBeforeMsg = opts.trimmedBeforeMsg ?? lastL0End;
  const summarized = rows.filter(r => r.summarized).sort((a, b) => b.level - a.level || a.msg_start - b.msg_start) as HistorySegment[];
  const picked = selectHistorySegments(summarized, trimmedBeforeMsg, budgetTokens);
  let injection: InjectionReport | null = null;
  if (picked) {
    const sel = [...picked.selected].sort((a, b) => a.msg_start - b.msg_start || a.msg_end - b.msg_end);
    const levelCounts: Record<number, number> = {};
    let redundantTokens = 0;
    // redundant = tokens of a selected segment × fraction of its range already covered by earlier selected ranges
    const covered: Array<{ msg_start: number; msg_end: number }> = [];
    for (const s of sel) {
      levelCounts[s.level] = (levelCounts[s.level] || 0) + 1;
      const span = Math.max(1, s.msg_end - s.msg_start);
      const already = coverage(covered.filter(c => overlapMsgs(c, s) > 0), s.msg_start, s.msg_end).covered;
      // >1: ignore fencepost boundaries, consistent with the per-level overlap accounting
      if (already > 1) redundantTokens += Math.round(s.summary_token_count * (already / span));
      covered.push({ msg_start: s.msg_start, msg_end: s.msg_end });
    }
    const cov = coverage(sel, messages.minIndex, picked.snappedBoundary);
    injection = {
      budgetTokens,
      trimmedBeforeMsg,
      snappedBoundary: picked.snappedBoundary,
      segments: sel.length,
      levelCounts,
      tokens: picked.tokens,
      redundantTokens,
      wastePct: picked.tokens > 0 ? Math.round((100 * redundantTokens) / picked.tokens) : 0,
      coveredMsgs: cov.covered,
      gapMsgs: cov.gaps.reduce((s, g) => s + g.msgs, 0),
    };
  }

  // Score: start at 100, subtract transparent penalties (each capped).
  const totalSegs = rows.length || 1;
  const totalOverlapping = new Set(overlaps.flatMap(o => [o.a.id, o.b.id])).size;
  const l0Report = levels.find(l => l.level === 0);
  const totalShadowed = levels.reduce((n, l) => n + l.shadowed, 0);
  const breakdown: Record<string, number> = {
    overlapping_segments: -Math.min(30, Math.round((30 * totalOverlapping) / totalSegs)),
    shadowed_segments: -Math.min(20, totalShadowed * 2),
    injected_waste: -Math.min(30, injection?.wastePct ?? 0),
    l0_gaps: -Math.min(15, l0Report ? 100 - l0Report.coveragePct : 0),
    stragglers: -Math.min(10, stragglers.length * 2),
    parent_issues: -Math.min(10, parentIssues.length),
  };
  const score = Math.max(0, 100 + Object.values(breakdown).reduce((s, v) => s + v, 0));

  overlaps.sort((x, y) => x.a.level - y.a.level || x.a.msg_start - y.a.msg_start);

  return {
    sessionId,
    messages,
    segmentState,
    unsegmentedTail,
    levels,
    overlaps,
    fenceposts: levels.reduce((n, l) => n + l.fenceposts, 0),
    gaps,
    stragglers,
    parentIssues,
    injection,
    score,
    scoreBreakdown: breakdown,
  };
}

// --- text formatting ----------------------------------------------------------

function pad(s: string | number, w: number, right = false): string {
  const t = String(s);
  return right ? t.padStart(w) : t.padEnd(w);
}

function fmtDate(iso: string): string {
  // "2026-09-17 06:59:21" → "09-17 06:59"
  return iso.slice(5, 16);
}

function segLabel(s: SegRef): string {
  return `#${s.id} [${s.msg_start}–${s.msg_end})`;
}

export function formatHealthReport(r: HealthReport, opts: { limit?: number; color?: boolean } = {}): string {
  const limit = opts.limit ?? 10;
  const color = opts.color ?? true;
  const c = {
    reset: color ? "\x1b[0m" : "",
    bold: color ? "\x1b[1m" : "",
    dim: color ? "\x1b[90m" : "",
    green: color ? "\x1b[32m" : "",
    red: color ? "\x1b[31m" : "",
    yellow: color ? "\x1b[33m" : "",
    blue: color ? "\x1b[34m" : "",
    cyan: color ? "\x1b[36m" : "",
    magenta: color ? "\x1b[35m" : "",
  };

  const out: string[] = [];

  out.push(`${c.blue}${c.bold}Session ${r.sessionId.slice(0, 8)}${c.reset}  messages ${r.messages.minIndex}–${r.messages.maxIndex} (${r.messages.count})  ` +
    `indexed to ${c.cyan}${r.segmentState.lastSegmentedMsg ?? "—"}${c.reset}` + (r.segmentState.lagMsgs ? ` (${c.yellow}lag ${r.segmentState.lagMsgs}${c.reset})` : ""));
  if (r.unsegmentedTail) out.push(`Unsegmented tail: ${r.unsegmentedTail.from}–${r.unsegmentedTail.to} (${r.unsegmentedTail.msgs} msgs, pending — not a gap)`);
  out.push("");

  // Per-level table
  const hdr = [pad("Level", 6), pad("Segs", 5, true), pad("Summ", 5, true), pad("Orph", 5, true), pad("Strag", 6, true), pad("Ovlp", 5, true), pad("Shad", 5, true), pad("Fence", 6, true), pad("Gaps", 5, true), pad("RedTok", 7, true), "  Coverage"];
  out.push(`${c.dim}${hdr.join(" ")}${c.reset}`);
  for (const l of r.levels) {
    const orphCol = l.orphans > 0 ? c.yellow : c.reset;
    const stragCol = l.stragglers > 0 ? c.red : c.reset;
    const ovlpCol = l.overlaps > 0 ? c.red : c.reset;
    const shadCol = l.shadowed > 0 ? c.yellow : c.reset;
    const gapCol = l.gaps > 0 ? c.red : c.reset;
    const redCol = l.redundantTokens > 0 ? c.yellow : c.reset;
    const covCol = l.coveragePct >= 99 ? c.green : l.coveragePct >= 80 ? c.yellow : c.red;

    out.push([
      pad(`L${l.level}`, 6),
      pad(l.segments, 5, true),
      pad(l.summarized, 5, true),
      orphCol + pad(l.orphans, 5, true) + c.reset,
      stragCol + pad(l.stragglers, 6, true) + c.reset,
      ovlpCol + pad(l.overlaps, 5, true) + c.reset,
      shadCol + pad(l.shadowed, 5, true) + c.reset,
      pad(l.fenceposts, 6, true),
      gapCol + pad(l.gaps, 5, true) + c.reset,
      redCol + pad(l.redundantTokens, 7, true) + c.reset,
      `  ${covCol}${l.span[0]}–${l.span[1]} (${l.coveragePct}%${l.gapMsgs ? `, ${l.gapMsgs} msgs uncovered` : ""})${c.reset}`,
    ].join(" "));
  }
  out.push("");

  const more = (n: number, what: string) => n > limit ? [`  … ${n - limit} more ${what} (use --limit ${n} to show all)`] : [];

  if (r.fenceposts) {
    out.push(`Fencepost overlaps: ${r.fenceposts} — 1-msg re-summarization at every incremental chunk boundary (indexSession re-includes last_segmented_msg). Benign but systematic; not listed below.`);
    out.push("");
  }

  if (r.overlaps.length) {
    out.push(`${c.red}${c.bold}Overlaps (${r.overlaps.length}):${c.reset}`);
    for (const o of r.overlaps.slice(0, limit)) {
      const tag = o.shadowed ? `${c.yellow}⊇ shadowed${c.reset}` : `${c.red}∩ ${o.pctOfSmaller}%${c.reset}`;
      out.push(`  L${o.a.level} ${segLabel(o.a)} ${fmtDate(o.a.created_at)}  vs  ${segLabel(o.b)} ${fmtDate(o.b.created_at)}  → ${o.msgs} msgs ${tag}`);
    }
    out.push(...more(r.overlaps.length, "overlaps"));
    out.push("");
  }

  if (r.gaps.length) {
    out.push(`${c.red}${c.bold}Gaps (${r.gaps.length})${c.reset} — message ranges no segment at that level covers:`);
    for (const g of r.gaps.slice(0, limit)) {
      out.push(`  L${g.level} ${g.from}–${g.to}  (${g.msgs} msgs)`);
    }
    out.push(...more(r.gaps.length, "gaps"));
    out.push("");
  }

  if (r.stragglers.length) {
    out.push(`${c.yellow}${c.bold}Stragglers (${r.stragglers.length})${c.reset} — orphans older than the newest parent above them; next rollup will batch them with unrelated segments:`);
    for (const s of r.stragglers.slice(0, limit)) {
      out.push(`  L${s.level} ${segLabel(s)} created ${fmtDate(s.created_at)}`);
    }
    out.push(...more(r.stragglers.length, "stragglers"));
    out.push("");
  }

  if (r.parentIssues.length) {
    out.push(`${c.red}${c.bold}Parent/child issues (${r.parentIssues.length}):${c.reset}`);
    for (const p of r.parentIssues.slice(0, limit)) {
      out.push(`  L${p.parent.level} ${segLabel(p.parent)}  ${p.kind}: ${p.detail}`);
    }
    out.push(...more(r.parentIssues.length, "issues"));
    out.push("");
  }

  if (r.injection) {
    const i = r.injection;
    const lc = Object.entries(i.levelCounts).sort((a, b) => Number(b[0]) - Number(a[0])).map(([l, n]) => `${n}×L${l}`).join(" ");
    const wasteCol = i.wastePct > 10 ? c.red : i.wastePct > 0 ? c.yellow : c.green;
    out.push(`${c.bold}Injected context${c.reset} (budget ${i.budgetTokens.toLocaleString()} tok, trimmed before msg ${i.trimmedBeforeMsg} → snapped ${i.snappedBoundary}):`);
    out.push(`  ${i.segments} segments (${lc}), ${i.tokens.toLocaleString()} tok, ${wasteCol}${i.redundantTokens.toLocaleString()} redundant (${i.wastePct}% waste)${c.reset}` +
      (i.gapMsgs ? `, ${c.red}${i.gapMsgs} msgs of trimmed history not covered by any injected summary${c.reset}` : ""));
    out.push("");
  } else {
    out.push("Injected context: nothing summarized yet");
    out.push("");
  }

  const bd = Object.entries(r.scoreBreakdown).filter(([, v]) => v !== 0).map(([k, v]) => `${k} ${v}`).join(", ");
  const scoreCol = r.score >= 90 ? c.green : r.score >= 70 ? c.yellow : c.red;
  out.push(`Health: ${scoreCol}${c.bold}${r.score}/100${c.reset}${bd ? `  (${c.dim}${bd}${c.reset})` : ""}`);
  return out.join("\n");
}
