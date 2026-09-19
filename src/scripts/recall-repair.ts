import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { config as loadDotenv } from "dotenv";
import { listEmbedSessions } from "../embed-health.js";
import { planRecallRepair, applyRecallRepair } from "../plugins/recall/repair.js";
import { configDefaults, type KernConfig } from "../config.js";

const USAGE = "Usage: kern scripts recall-repair <recall.db> [--session <id>] [--apply] [--no-backup] [--batch-size <n>] [--json] [--list]";

/**
 * Load agent config & .env from directory next to recall.db.
 */
function loadAgentConfig(dbPath: string): { config: KernConfig; agentDir: string } {
  // Typical path: /home/kern/<agent>/.kern/recall.db -> agentDir is /home/kern/<agent>
  const dotKernDir = dirname(dbPath);
  const agentDir = dirname(dotKernDir);

  const envPath = join(dotKernDir, ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath, override: true });
  }

  const cfgPath = join(dotKernDir, "config.json");
  let config = { ...configDefaults };
  if (existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
      config = { ...config, ...raw };
    } catch {
      // use defaults
    }
  }

  return { config, agentDir };
}

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

  const { config } = loadAgentConfig(dbPath);

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    sqliteVec.load(db);
  } catch {
    console.error("Warning: failed to load sqlite-vec extension");
  }

  try {
    const sessions = listEmbedSessions(db);
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
      console.log("Nothing to repair. (0 API calls, 0s elapsed)");
      return;
    }

    console.log("Status: Needs repair");
    console.log(`  Chunks:   ${plan.vectorChunks.toLocaleString()} / ${plan.totalChunks.toLocaleString()} vectors (${coverage}% coverage)`);
    console.log(`  Orphans:  ${plan.orphanChunks.length.toLocaleString()} chunks missing from vec_chunks`);
    console.log(`  Scan:     ${(plan.lastIndexedMsg ?? 0).toLocaleString()} / ${plan.totalMessages.toLocaleString()} msgs (${plan.tailLag} lag)`);
    console.log("");

    if (!apply) {
      console.log("Repair plan:");
      console.log(`  • Vectorize ${plan.orphanChunks.length.toLocaleString()} orphaned chunks (${plan.estBatches} batches of ~100)`);
      console.log(`  • Estimated text: ~${(plan.totalChars / 1000).toFixed(0)}k characters`);
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

    console.log(`[provider] ${config.provider}`);
    console.log(`Repairing ${plan.orphanChunks.length.toLocaleString()} orphaned chunks...`);

    const result = await applyRecallRepair(db, config, plan, (p) => {
      console.log(`  batch ${p.batch}/${p.totalBatches} (${p.chunksInBatch} chunks)... done`);
    });

    console.log("");
    console.log("Results:");
    console.log(`  Vectors inserted:  ${result.vectorsInserted.toLocaleString()}`);
    console.log(`  Vector coverage:   ${result.totalVectors.toLocaleString()} / ${result.totalChunks.toLocaleString()} (${result.coveragePct.toFixed(1)}%)`);
    console.log(`  Orphans remaining: ${plan.totalChunks - result.totalVectors}`);
    console.log(`  Elapsed time:      ${(result.elapsedMs / 1000).toFixed(1)}s`);
    console.log("");
    console.log("Index successfully repaired.");
  } finally {
    db.close();
  }
}
