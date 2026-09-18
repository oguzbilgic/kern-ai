import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { analyzeSegmentHealth, formatHealthReport, listSessions } from "../segment-health.js";

const USAGE = "Usage: kern scripts segment-health <recall.db> [--session <id>] [--budget <tokens>] [--trim <msg>] [--limit <n>] [--json] [--list]";

/**
 * Best-effort: read maxContextTokens × summaryBudget from the agent's
 * .kern/config.json sitting next to recall.db, so the injection simulation
 * uses the same budget the agent does. Falls back to runtime defaults.
 */
function budgetFromConfig(dbPath: string): { budget: number; source: string } {
  const cfgPath = join(dirname(dbPath), "config.json");
  const defaults = { maxContextTokens: 100_000, summaryBudget: 0.75 };
  try {
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const max = typeof cfg.maxContextTokens === "number" ? cfg.maxContextTokens : defaults.maxContextTokens;
      const ratio = typeof cfg.summaryBudget === "number" ? cfg.summaryBudget : defaults.summaryBudget;
      return { budget: Math.floor(max * ratio), source: `${cfgPath} (${max} × ${ratio})` };
    }
  } catch {
    // fall through to defaults
  }
  return { budget: Math.floor(defaults.maxContextTokens * defaults.summaryBudget), source: "defaults (100000 × 0.75)" };
}

export async function segmentHealth(args: string[]): Promise<void> {
  const positional: string[] = [];
  let sessionArg: string | undefined;
  let budgetArg: number | undefined;
  let trimArg: number | undefined;
  let limit = 10;
  let json = false;
  let list = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--session") sessionArg = args[++i];
    else if (a === "--budget") budgetArg = Number(args[++i]);
    else if (a === "--trim") trimArg = Number(args[++i]);
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
    const sessions = listSessions(db);
    if (sessions.length === 0) {
      console.error("No sessions in this recall.db");
      process.exit(1);
    }

    if (list) {
      for (const s of sessions) {
        console.log(`${s.session_id}  ${String(s.count).padStart(7)} msgs  ${String(s.segments).padStart(6)} segments`);
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

    const { budget, source } = budgetArg != null && !Number.isNaN(budgetArg)
      ? { budget: budgetArg, source: "--budget" }
      : budgetFromConfig(dbPath);

    const report = analyzeSegmentHealth(db, sessionId, {
      budgetTokens: budget,
      trimmedBeforeMsg: trimArg != null && !Number.isNaN(trimArg) ? trimArg : undefined,
    });

    if (json) {
      console.log(JSON.stringify({ ...report, budgetSource: source, dbPath }, null, 2));
      return;
    }

    console.log(`${dbPath}`);
    console.log(`Budget: ${budget.toLocaleString()} tok from ${source}`);
    console.log("");
    console.log(formatHealthReport(report, { limit }));
  } finally {
    db.close();
  }
}
