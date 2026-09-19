import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync } from "fs";
import { resolve } from "path";
import { analyzeEmbedHealth, formatEmbedHealthReport, listEmbedSessions } from "../embed-health.js";

const USAGE = "Usage: kern scripts embed-health <recall.db> [--session <id>] [--limit <n>] [--json] [--list]";

export async function embedHealth(args: string[]): Promise<void> {
  const positional: string[] = [];
  let sessionArg: string | undefined;
  let limit = 10;
  let json = false;
  let list = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--session") sessionArg = args[++i];
    else if (a === "--limit") limit = Number(args[++i]);
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

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
  } catch (err: any) {
    console.error(`Error: failed to load sqlite-vec extension: ${err.message}`);
    console.error("sqlite-vec is required for embed-health to verify vector tables.");
    db.close();
    process.exit(1);
  }

  try {
    const sessions = listEmbedSessions(db);
    if (sessions.length === 0) {
      console.error("No sessions in this recall.db");
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

    const report = analyzeEmbedHealth(db, sessionId);

    if (json) {
      console.log(JSON.stringify({ ...report, dbPath }, null, 2));
      return;
    }

    console.log(`${dbPath}`);
    console.log("");
    console.log(formatEmbedHealthReport(report, { limit }));
  } finally {
    db.close();
  }
}
