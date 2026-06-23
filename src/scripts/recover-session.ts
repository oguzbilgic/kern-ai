import Database from "better-sqlite3";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join, resolve } from "path";

interface MsgRow {
  msg_index: number;
  role: string;
  content: string;
  timestamp: string | null;
}

interface SessionSummary {
  session_id: string;
  count: number;
  minIndex: number;
  maxIndex: number;
  firstTs: string | null;
  lastTs: string | null;
}

function summarizeSessions(db: Database.Database): SessionSummary[] {
  const rows = db
    .prepare(
      `SELECT session_id,
              COUNT(*) AS count,
              MIN(msg_index) AS minIndex,
              MAX(msg_index) AS maxIndex,
              MIN(timestamp) AS firstTs,
              MAX(timestamp) AS lastTs
       FROM messages
       GROUP BY session_id
       ORDER BY count DESC`
    )
    .all() as SessionSummary[];
  return rows;
}

/**
 * Reverse the recall.db content serialization (recall.ts stores
 * `typeof content === "string" ? content : JSON.stringify(content)`).
 * Structured content (tool calls, multi-part) round-trips via JSON.parse;
 * plain text stays a string.
 */
function reviveContent(raw: string): unknown {
  const t = raw.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupt structured content — keep the raw string rather than fail.
      return raw;
    }
  }
  return raw;
}

export async function recoverSession(args: string[]): Promise<void> {
  // args[0] = subcommand name already consumed by dispatcher? No — caller passes
  // everything after "scripts recover-session". So args[0] is the db path.
  const positional: string[] = [];
  let list = false;
  let sessionArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--list") list = true;
    else if (a === "--session") sessionArg = args[++i];
    else positional.push(a);
  }

  const dbArg = positional[0];
  if (!dbArg) {
    console.error("Usage: kern scripts recover-session <recall.db> [--list] [--session <id>]");
    process.exit(1);
  }

  const dbPath = resolve(dbArg);
  if (!existsSync(dbPath)) {
    console.error(`recall.db not found at ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  // Verify the messages table exists.
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
    .get();
  if (!hasTable) {
    console.error(`No 'messages' table in ${dbPath} — not a recall database?`);
    process.exit(1);
  }

  const sessions = summarizeSessions(db);
  if (sessions.length === 0) {
    console.error("No messages found in recall.db — nothing to recover.");
    process.exit(1);
  }

  if (list) {
    console.log(`Sessions in ${dbPath}:`);
    console.log("");
    for (const s of sessions) {
      const range = `${s.firstTs ?? "?"} → ${s.lastTs ?? "?"}`;
      console.log(`  ${s.session_id}`);
      console.log(`    ${s.count} messages (index ${s.minIndex}–${s.maxIndex})   ${range}`);
    }
    console.log("");
    return;
  }

  // Pick the session: explicit --session, else the one with the most messages.
  let target: SessionSummary | undefined;
  if (sessionArg) {
    target = sessions.find((s) => s.session_id === sessionArg);
    if (!target) {
      console.error(`Session ${sessionArg} not found in recall.db. Use --list to see available sessions.`);
      process.exit(1);
    }
  } else {
    target = sessions[0]; // most messages (sorted DESC)
  }

  const sessionId = target.session_id;

  const rows = db
    .prepare(
      "SELECT msg_index, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY msg_index ASC"
    )
    .all(sessionId) as MsgRow[];

  // Gap detection.
  const gaps: Array<[number, number]> = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].msg_index;
    const cur = rows[i].msg_index;
    if (cur !== prev + 1) gaps.push([prev, cur]);
  }

  const firstTs = rows.find((r) => r.timestamp)?.timestamp ?? null;
  const lastTs = [...rows].reverse().find((r) => r.timestamp)?.timestamp ?? null;
  const now = new Date().toISOString();

  const meta = JSON.stringify({
    id: sessionId,
    createdAt: firstTs ?? now,
    updatedAt: lastTs ?? now,
    recoveredFrom: "recall.db",
    sourceDb: dbPath,
    messageCount: rows.length,
  });

  const lines = [meta];
  for (const r of rows) {
    lines.push(JSON.stringify({ role: r.role, content: reviveContent(r.content) }));
  }

  const outPath = join(process.cwd(), `${sessionId}.jsonl`);
  await writeFile(outPath, lines.join("\n") + "\n");

  console.log("");
  console.log(`✓ Recovered ${rows.length} messages → ${outPath}`);
  console.log(`  Session: ${sessionId}`);
  console.log(`  Range:   index ${target.minIndex}–${target.maxIndex}  (${firstTs ?? "?"} → ${lastTs ?? "?"})`);
  if (gaps.length > 0) {
    console.log("");
    console.log(`  ⚠ ${gaps.length} gap(s) in msg_index — some messages were never indexed:`);
    for (const [a, b] of gaps.slice(0, 10)) console.log(`      ${a} → ${b}`);
    if (gaps.length > 10) console.log(`      … and ${gaps.length - 10} more`);
  }
  console.log("");
  console.log("  Note: recall.db only holds messages indexed at turn-finish, so the");
  console.log("  final turn(s) before a crash may be missing. Everything indexed is exact.");
  console.log("");
  console.log("  Move into the agent's sessions dir to use it:");
  console.log(`    mv ${outPath} <agent>/.kern/sessions/`);
  console.log("");
}
