import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, rmSync } from "fs";
import { resolve } from "path";
import { analyzeSegmentHealth, listSessions } from "../plugins/recall/segment-health.js";
import { budgetFromConfig } from "./segment-health.js";
import { applyPrune, formatPrunePlan, loadSegmentRows, planPrune, sessionStart } from "../plugins/recall/segment-prune.js";

const USAGE = "Usage: kern scripts segment-prune <recall.db> [--session <id>] [--budget <tokens>] [--apply] [--no-backup] [--limit <n>] [--json]";

/** Consistent snapshot of `db` via SQLite's online backup API (WAL-safe, journal-mode agnostic). */
async function snapshot(db: Database.Database, dest: string): Promise<Database.Database> {
  await db.backup(dest);
  const copy = new Database(dest, { fileMustExist: true });
  sqliteVec.load(copy);
  return copy;
}

export async function segmentPrune(args: string[]): Promise<void> {
  const positional: string[] = [];
  let sessionArg: string | undefined;
  let apply = false;
  let backup = true;
  let limit = 10;
  let json = false;
  let budget: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--session") sessionArg = args[++i];
    else if (a === "--apply") apply = true;
    else if (a === "--no-backup") backup = false;
    else if (a === "--limit") limit = Number(args[++i]);
    else if (a === "--budget") budget = Number(args[++i]);
    else if (a === "--json") json = true;
    else if (a.startsWith("--")) {
      console.error(`Unknown flag ${a}\n${USAGE}`);
      process.exit(1);
    } else positional.push(a);
  }

  const dbArg = positional[0];
  if (!dbArg) {
    console.error(USAGE);
    process.exit(1);
  }
  const dbPath = resolve(dbArg);
  if (!existsSync(dbPath)) {
    console.error(`recall.db not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  sqliteVec.load(db);
  const { budget: budgetTokens, source: budgetSource } = budget != null && !Number.isNaN(budget)
    ? { budget, source: "--budget" }
    : budgetFromConfig(dbPath);
  const healthOpts = { budgetTokens };
  let scratch: Database.Database | null = null;
  const scratchPath = `${dbPath}.prune-dryrun-${process.pid}`;
  try {
    const sessions = listSessions(db);
    if (sessions.length === 0) {
      console.error("No sessions in this recall.db");
      process.exit(1);
    }
    const sessionId = sessionArg
      ? sessions.find(s => s.session_id === sessionArg || s.session_id.startsWith(sessionArg))?.session_id
      : sessions[0].session_id;
    if (!sessionId) {
      console.error(`Session ${sessionArg} not found.`);
      process.exit(1);
    }

    const before = analyzeSegmentHealth(db, sessionId, healthOpts);
    const rows = loadSegmentRows(db, sessionId);
    const plan = planPrune(rows, sessionId, { sessionStart: sessionStart(db, sessionId) });

    let applied: { deleted: number; orphaned: number } | null = null;
    let backupPath: string | null = null;
    let after: ReturnType<typeof analyzeSegmentHealth>;
    if (apply) {
      if (backup) {
        backupPath = `${dbPath}.pre-prune-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await db.backup(backupPath);
      }
      applied = applyPrune(db, plan);
      after = analyzeSegmentHealth(db, sessionId, healthOpts);
    } else {
      // Dry run: apply the plan to a throwaway snapshot so "after" is real, not estimated.
      scratch = await snapshot(db, scratchPath);
      applyPrune(scratch, plan);
      after = analyzeSegmentHealth(scratch, sessionId, healthOpts);
    }

    if (json) {
      console.log(JSON.stringify({ dbPath, sessionId, dryRun: !apply, backupPath, budget: { tokens: budgetTokens, source: budgetSource }, plan, applied, health: { before, after } }, null, 2));
      return;
    }

    console.log(`${dbPath}`);
    console.log(`Session ${sessionId.slice(0, 8)}  ${apply ? "APPLY" : "DRY RUN"}${backupPath ? `  backup → ${backupPath}` : ""}`);
    console.log(`Budget ${budgetTokens} tokens (${budgetSource})`);
    console.log("");
    console.log(formatPrunePlan(plan, { limit }));
    console.log("");
    const fmt = (h: ReturnType<typeof analyzeSegmentHealth>) =>
      `${h.score}/100  overlaps ${h.overlaps.length}  shadowed ${h.levels.reduce((s, l) => s + l.shadowed, 0)}  parent issues ${h.parentIssues.length}  stragglers ${h.stragglers.length}  gaps ${h.gaps.length}`;
    console.log(`Health before: ${fmt(before)}`);
    console.log(`Health after:  ${fmt(after)}${apply ? "" : "  (simulated)"}`);
    if (!apply) console.log("Dry run — nothing written. Re-run with --apply to execute.");
  } finally {
    db.close();
    if (scratch) {
      scratch.close();
      rmSync(scratchPath, { force: true });
    }
  }
}
