import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync } from "fs";
import { resolve } from "path";
import { listRecallSessions } from "../recall-health.js";
import { planRecallRepair, applyRecallRepair } from "../plugins/recall/repair.js";

const USAGE = "Usage: kern scripts recall-repair <recall.db> [--session <id>] [--apply] [--no-backup] [--json] [--list]";

export async function recallRepair(args: string[]): Promise<void> {
  const positional: string[] = [];
  let sessionArg: string | undefined;
  let apply = false;
  let backup = true;
  let json = false;
  let list = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--session") sessionArg = args[++i];
    else if (a === "--apply") apply = true;
    else if (a === "--no-backup") backup = false;
    else if (a === "--json") json = true;
    else if (a === "--list") list = true;
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

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    sqliteVec.load(db);
  } catch (err: any) {
    console.error(`Error: failed to load sqlite-vec extension: ${err.message}`);
    console.error("sqlite-vec is required for recall-repair to safely inspect vector tables.");
    db.close();
    process.exit(1);
  }

  try {
    const sessions = listRecallSessions(db);
    if (sessions.length === 0) {
      console.error("No sessions found in recall.db");
      process.exit(1);
    }

    if (list) {
      console.log("Sessions in recall.db:");
      for (const s of sessions) {
        console.log(`  ${s.session_id}  ${String(s.messages).padStart(7)} msgs  ${String(s.chunks).padStart(6)} chunks  (indexed to ${s.last_indexed_msg ?? "—"})`);
      }
      return;
    }

    const sessionId = sessionArg
      ? (sessions.find(s => s.session_id === sessionArg || s.session_id.startsWith(sessionArg))?.session_id)
      : sessions[0].session_id;

    if (!sessionId) {
      console.error(`Session ${sessionArg} not found. Use --list to see sessions.`);
      process.exit(1);
    }

    const plan = planRecallRepair(db, sessionId);

    if (json) {
      if (!apply) {
        console.log(JSON.stringify({ plan, applied: false }, null, 2));
        return;
      }
    }

    const shortId = sessionId.slice(0, 8);
    const coverage = plan.totalChunks > 0 ? ((plan.vectorChunks / plan.totalChunks) * 100).toFixed(1) : "100.0";

    console.log(`${dbPath}`);
    console.log(`Session: ${shortId}  (${plan.totalMessages.toLocaleString()} msgs, ${plan.totalChunks.toLocaleString()} chunks)`);
    console.log("");

    if (plan.isClean) {
      console.log("Status: Healthy");
      console.log(`  Chunks:   ${plan.vectorChunks.toLocaleString()} / ${plan.totalChunks.toLocaleString()} vectors (${coverage}% coverage)`);
      console.log(`  Orphans:  0 missing vectors`);
      console.log(`  Scan:     ${(plan.lastIndexedMsg ?? 0).toLocaleString()} / ${plan.totalMessages.toLocaleString()} msgs (100.0% scanned, 0 lag)`);
      console.log("");
      console.log("Nothing to repair. Zero changes needed.");
      return;
    }

    if (plan.orphanChunks.length === 0) {
      console.log("Status: Healthy (indexing in progress)");
      console.log(`  Chunks:   ${plan.vectorChunks.toLocaleString()} / ${plan.totalChunks.toLocaleString()} vectors (${coverage}% coverage)`);
      console.log(`  Orphans:  0 missing vectors`);
      console.log(`  Scan:     ${(plan.lastIndexedMsg ?? 0).toLocaleString()} / ${plan.totalMessages.toLocaleString()} msgs (${plan.tailLag} msgs pending)`);
      console.log("");
      console.log("All existing chunks have vectors. Indexing is progressing normally in the background.");
      console.log("Nothing to repair. Zero changes needed.");
      return;
    }

    console.log("Status: Needs repair");
    console.log(`  Chunks:   ${plan.vectorChunks.toLocaleString()} / ${plan.totalChunks.toLocaleString()} vectors (${coverage}% coverage)`);
    console.log(`  Orphans:  ${plan.orphanChunks.length.toLocaleString()} chunks missing from vec_chunks`);
    console.log(`  Scan:     ${(plan.lastIndexedMsg ?? 0).toLocaleString()} / ${plan.totalMessages.toLocaleString()} msgs (${plan.tailLag} lag)`);
    console.log("");

    if (!apply) {
      console.log("Repair plan (pure SQLite, zero LLM calls):");
      console.log(`  • Prune ${plan.orphanChunks.length.toLocaleString()} orphaned chunk rows from chunks table`);
      console.log(`  • Reset scan cursor: ${plan.lastIndexedMsg ?? 0} → ${plan.resetCursorTo} (earliest missing message)`);
      console.log(`  • On next agent restart, native indexSession resumes from msg ${plan.resetCursorTo}`);
      console.log("");
      console.log("Dry-run only. To execute repair, run with --apply:");
      console.log(`  kern scripts recall-repair ${dbPath} --apply`);
      return;
    }

    // Apply mode
    if (backup) {
      const backupPath = `${dbPath}.backup-${Date.now()}`;
      await db.backup(backupPath);
      console.log(`[backup] Created snapshot: ${backupPath}`);
    }

    const result = applyRecallRepair(db, plan);

    console.log("Results:");
    console.log(`  Pruned orphan chunks:  ${result.deletedChunks.toLocaleString()}`);
    console.log(`  Reset index cursor:    ${result.previousCursor ?? 0} → ${result.resetCursorTo}`);
    console.log("");
    console.log("Repair applied. Agent will cleanly re-index missing chunks on next start or turn.");
  } finally {
    db.close();
  }
}
