import Database from "better-sqlite3";
import { copyFileSync, existsSync } from "fs";
import { resolve } from "path";
import { analyzeSegmentHealth, listSessions } from "../segment-health.js";
import { applyPrune, formatPrunePlan, loadSegmentRows, planPrune } from "../segment-prune.js";

const USAGE = "Usage: kern scripts segment-prune <recall.db> [--session <id>] [--apply] [--no-backup] [--limit <n>] [--json]";

export async function segmentPrune(args: string[]): Promise<void> {
  const positional: string[] = [];
  let sessionArg: string | undefined;
  let apply = false;
  let backup = true;
  let limit = 10;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--session") sessionArg = args[++i];
    else if (a === "--apply") apply = true;
    else if (a === "--no-backup") backup = false;
    else if (a === "--limit") limit = Number(args[++i]);
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

    const before = analyzeSegmentHealth(db, sessionId);
    const rows = loadSegmentRows(db, sessionId);
    const plan = planPrune(rows, sessionId);

    let applied: { deleted: number; orphaned: number } | null = null;
    let backupPath: string | null = null;
    let after = null;
    if (apply) {
      if (backup) {
        backupPath = `${dbPath}.pre-prune-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        copyFileSync(dbPath, backupPath);
      }
      applied = applyPrune(db, plan);
      after = analyzeSegmentHealth(db, sessionId);
    }

    if (json) {
      console.log(JSON.stringify({ dbPath, sessionId, dryRun: !apply, backupPath, plan, applied, health: { before, after } }, null, 2));
      return;
    }

    console.log(`${dbPath}`);
    console.log(`Session ${sessionId.slice(0, 8)}  ${apply ? "APPLY" : "DRY RUN"}${backupPath ? `  backup → ${backupPath}` : ""}`);
    console.log("");
    console.log(formatPrunePlan(plan, { limit }));
    console.log("");
    const fmt = (h: ReturnType<typeof analyzeSegmentHealth>) =>
      `${h.score}/100  overlaps ${h.overlaps.length}  shadowed ${h.levels.reduce((s, l) => s + l.shadowed, 0)}  parent issues ${h.parentIssues.length}  stragglers ${h.stragglers.length}  gaps ${h.gaps.length}`;
    console.log(`Health before: ${fmt(before)}`);
    if (after) console.log(`Health after:  ${fmt(after)}`);
    else console.log("Dry run — nothing written. Re-run with --apply to execute.");
  } finally {
    db.close();
  }
}
