// Import OpenCode sessions from the local ~/.local/share/opencode/opencode.db.
//
// Tested with:
//   - opencode v1.3.3 (messages + parts tables)
//   - kern v0.7.1 (initial ship) through v0.30.0 (cwd output)

import Database from "better-sqlite3";
import { join } from "path";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { homedir } from "os";
import { log } from "../log.js";

interface OpenCodeMessage {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OpenCodePart {
  id: string;
  message_id: string;
  time_created: number;
  data: string;
}

function getDb(): Database.Database {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) {
    console.error(`OpenCode database not found at ${dbPath}`);
    process.exit(1);
  }
  return new Database(dbPath, { readonly: true });
}

function getProjects(db: Database.Database): { id: string; worktree: string; msgCount: number }[] {
  const projects = db.prepare(
    "SELECT p.id, p.worktree FROM project p WHERE p.worktree != '/' ORDER BY p.worktree"
  ).all() as { id: string; worktree: string }[];

  return projects.map((p) => {
    const count = db.prepare(
      "SELECT COUNT(*) as count FROM message WHERE session_id IN (SELECT id FROM session WHERE project_id = ?)"
    ).get(p.id) as { count: number };
    return { ...p, msgCount: count.count };
  });
}

function getSessions(db: Database.Database, projectId: string): { id: string; title: string; time_updated: number; msgCount: number }[] {
  const sessions = db.prepare(
    "SELECT id, title, time_created, time_updated FROM session WHERE project_id = ? ORDER BY time_updated DESC"
  ).all(projectId) as { id: string; title: string; time_created: number; time_updated: number }[];

  return sessions.map((s) => {
    const count = db.prepare("SELECT COUNT(*) as count FROM message WHERE session_id = ?").get(s.id) as { count: number };
    return { ...s, msgCount: count.count };
  });
}

function convertSession(db: Database.Database, sessionId: string): { messages: any[]; converted: number; skipped: number } {
  const messages = db.prepare(
    "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created"
  ).all(sessionId) as OpenCodeMessage[];

  const getPartsStmt = db.prepare(
    "SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created"
  );

  const kernMessages: any[] = [];
  let converted = 0;
  let skipped = 0;

  for (const msg of messages) {
    const msgData = JSON.parse(msg.data);
    const parts = getPartsStmt.all(msg.id) as OpenCodePart[];
    const role = msgData.role;

    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    for (const part of parts) {
      const partData = JSON.parse(part.data);

      if (partData.type === "text" && partData.text) {
        textParts.push(partData.text);
        converted++;
      } else if (partData.type === "tool" && partData.state) {
        if (partData.state.input) {
          toolCalls.push({
            type: "tool-call",
            toolCallId: partData.callID || `call_${converted}`,
            toolName: partData.tool,
            input: partData.state.input,
          });
          converted++;
        }
        if (partData.state.status === "completed" && partData.state.output !== undefined) {
          toolResults.push({
            type: "tool-result",
            toolCallId: partData.callID || `call_${converted}`,
            toolName: partData.tool,
            output: { type: "text", value: String(partData.state.output) },
          });
          converted++;
        }
      } else {
        skipped++;
      }
    }

    if (role === "user") {
      const text = textParts.join("\n");
      if (text) {
        kernMessages.push({ role: "user", content: text });
      }
    } else if (role === "assistant") {
      if (textParts.length > 0 && toolCalls.length > 0) {
        const content: any[] = [];
        for (const t of textParts) {
          content.push({ type: "text", text: t });
        }
        content.push(...toolCalls);
        kernMessages.push({ role: "assistant", content });
      } else if (toolCalls.length > 0) {
        kernMessages.push({ role: "assistant", content: toolCalls });
      } else if (textParts.length > 0) {
        kernMessages.push({ role: "assistant", content: textParts.join("\n") });
      }

      if (toolResults.length > 0) {
        kernMessages.push({ role: "tool", content: toolResults });
      }
    }
  }

  // Post-process: fix broken patterns
  const cleaned: any[] = [];
  for (let i = 0; i < kernMessages.length; i++) {
    const m = kernMessages[i];
    const next = kernMessages[i + 1];

    if (m.role === "assistant" && Array.isArray(m.content)) {
      const hasToolCall = m.content.some((p: any) => p.type === "tool-call");
      if (hasToolCall && (!next || next.role !== "tool")) {
        skipped++;
        continue;
      }
    }

    if (m.role === "user" && next?.role === "user") {
      skipped++;
      continue;
    }

    cleaned.push(m);
  }

  return { messages: cleaned, converted, skipped };
}

function getFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

export async function importOpenCode(args: string[]): Promise<void> {
  const { select } = await import("@inquirer/prompts");

  const db = getDb();

  // --- Pick project ---
  let projectId: string;
  let projectWorktree: string;
  const projectArg = getFlag(args, "project") || args.find((a) => !a.startsWith("--"));

  if (projectArg) {
    const projects = getProjects(db);
    const match = projects.find((p) => p.worktree === projectArg || p.worktree.endsWith("/" + projectArg));
    if (!match) {
      console.error(`OpenCode project not found: ${projectArg}`);
      db.close();
      process.exit(1);
    }
    projectId = match.id;
    projectWorktree = match.worktree;
  } else {
    const projects = getProjects(db);
    if (projects.length === 0) {
      console.error("No OpenCode projects found.");
      db.close();
      process.exit(1);
    }
    const chosen = await select({
      message: "Select OpenCode project",
      choices: projects.map((p) => ({
        name: `${p.worktree} (${p.msgCount} msgs)`,
        value: p.id,
      })),
    });
    projectId = chosen;
    projectWorktree = projects.find((p) => p.id === chosen)!.worktree;
  }
  console.log(`  Project: ${projectWorktree}`);

  // --- Pick session ---
  let sessionId: string;
  let sessionTitle: string;
  const sessionArg = getFlag(args, "session");

  const sessions = getSessions(db, projectId);
  if (sessions.length === 0) {
    console.error("No sessions found.");
    db.close();
    process.exit(1);
  }

  if (sessionArg === "latest") {
    sessionId = sessions[0].id;
    sessionTitle = sessions[0].title;
  } else if (sessionArg) {
    const match = sessions.find((s) => s.title === sessionArg || s.id === sessionArg);
    if (!match) {
      console.error(`Session not found: ${sessionArg}`);
      db.close();
      process.exit(1);
    }
    sessionId = match.id;
    sessionTitle = match.title;
  } else {
    const chosen = await select({
      message: "Select session",
      choices: sessions.slice(0, 10).map((s) => {
        const date = new Date(s.time_updated).toISOString().slice(0, 10);
        return {
          name: `${s.title} (${date}, ${s.msgCount} msgs)`,
          value: s.id,
        };
      }),
    });
    sessionId = chosen;
    sessionTitle = sessions.find((s) => s.id === chosen)!.title;
  }
  console.log(`  Session: ${sessionTitle}`);

  // --- Convert ---
  const { messages: kernMessages, converted, skipped } = convertSession(db, sessionId);
  db.close();

  console.log(`  Converted: ${converted} parts`);
  console.log(`  Skipped: ${skipped} parts`);
  console.log(`  Messages: ${kernMessages.length}`);

  // --- Write to cwd ---
  const sessionUuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const jsonlPath = join(process.cwd(), `${sessionUuid}.jsonl`);

  const meta = JSON.stringify({
    id: sessionUuid,
    createdAt: now,
    updatedAt: now,
    importedFrom: "opencode",
    originalSessionId: sessionId,
    sourceProject: projectWorktree,
  });

  const lines = [meta, ...kernMessages.map((m: any) => JSON.stringify(m))];
  await writeFile(jsonlPath, lines.join("\n") + "\n");

  console.log("");
  console.log(`✓ Imported ${kernMessages.length} messages → ${jsonlPath}`);
  console.log("");
  console.log(`  Move into an agent's sessions dir to use it:`);
  console.log(`    mv ${jsonlPath} <agent>/.kern/sessions/`);
  console.log("");

  process.exit(0);
}
