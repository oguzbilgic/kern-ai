import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import type { ModelMessage } from "ai";
import { log } from "./log.js";

export interface Session {
  id: string;
  messages: ModelMessage[];
  createdAt: string;
  updatedAt: string;
}

export class SessionManager {
  private dir: string;
  private session: Session | null = null;

  constructor(agentDir: string) {
    this.dir = join(agentDir, ".kern", "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async load(id?: string): Promise<Session> {
    // If no ID, load the most recent session or create new
    if (!id) {
      const latest = await this.findLatest();
      if (latest) {
        this.session = latest;
        return latest;
      }
      return this.create();
    }

    const path = this.pathFor(id);
    if (!existsSync(path)) {
      return this.create(id);
    }

    const content = await readFile(path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // First line is metadata, rest are messages
    const meta = JSON.parse(lines[0]);
    const messages: ModelMessage[] = [];
    let torn = false;
    for (let i = 1; i < lines.length; i++) {
      try {
        messages.push(JSON.parse(lines[i]));
      } catch (err) {
        // A crash mid-append can leave a torn final line. Drop it — the
        // interrupted-turn handling below covers the lost message. Anything
        // unparseable earlier in the file is real corruption: rethrow.
        if (i === lines.length - 1) {
          log.warn("session", `dropping torn trailing line in ${id}.jsonl`);
          torn = true;
          break;
        }
        throw err;
      }
    }

    if (torn) {
      // Rewrite without the fragment. It has no trailing newline, so a later
      // append would otherwise glue onto it and corrupt the next record too.
      const repaired = [lines[0], ...messages.map((m) => JSON.stringify(m))];
      await writeFile(path, repaired.join("\n") + "\n", "utf-8");
    }

    // Detect incomplete turn — if session ends with assistant tool-call
    // without a matching tool result, the previous process died mid-turn.
    // Append a synthetic message so the model doesn't re-execute.
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === "assistant" && Array.isArray(last.content)) {
        const hasToolCall = (last.content as any[]).some((p) => p.type === "tool-call");
        const nextIsTool = false; // it's the last message, no tool result follows
        if (hasToolCall) {
          const synthetic = {
            role: "user",
            content: "[system] Previous turn was interrupted. Tool results were lost. Continue normally.",
          } as ModelMessage;
          messages.push(synthetic);
          // Persist it now. Appends no longer rewrite the whole file, so an
          // in-memory-only message would never reach disk otherwise.
          await appendFile(path, JSON.stringify(synthetic) + "\n", "utf-8");
        }
      }
    }

    this.session = {
      id: meta.id,
      messages,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt ?? meta.createdAt,
    };

    return this.session;
  }

  async create(id?: string): Promise<Session> {
    const now = new Date().toISOString();
    this.session = {
      id: id || crypto.randomUUID(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.save();
    return this.session;
  }

  async append(messages: ModelMessage[]): Promise<void> {
    if (!this.session) throw new Error("No active session");
    this.session.messages.push(...messages);
    this.session.updatedAt = new Date().toISOString();

    // Append only the new records. Rewriting the whole file here made every
    // step O(session size), so turns slowed down as the session grew.
    // Consequence: the meta header's updatedAt stays as written at create();
    // use file mtime for "last updated" (findLatest already does).
    const path = this.pathFor(this.session.id);
    if (!existsSync(path)) {
      // File vanished mid-session (deleted or moved) — a bare append would
      // create it without the meta header. Restore everything instead.
      await this.save();
      return;
    }
    const chunk = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    await appendFile(path, chunk, "utf-8");
  }

  getMessages(): ModelMessage[] {
    return this.session?.messages || [];
  }

  getSessionId(): string | null {
    return this.session?.id || null;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  // Full rewrite of the session file. Only used to create the file (meta
  // header + any messages) — steady-state persistence goes through append().
  private async save(): Promise<void> {
    if (!this.session) return;
    const path = this.pathFor(this.session.id);
    const meta = JSON.stringify({
      id: this.session.id,
      createdAt: this.session.createdAt,
      updatedAt: this.session.updatedAt,
    });
    const lines = [
      meta,
      ...this.session.messages.map((m) => JSON.stringify(m)),
    ];
    await writeFile(path, lines.join("\n") + "\n", "utf-8");
  }

  private async findLatest(): Promise<Session | null> {
    const { readdir, stat } = await import("fs/promises");
    try {
      const files = await readdir(this.dir);
      const jsonl = files.filter((f) => f.endsWith(".jsonl"));
      if (jsonl.length === 0) return null;

      // Find most recently modified
      let latest = { file: "", mtime: 0 };
      for (const f of jsonl) {
        const s = await stat(join(this.dir, f));
        if (s.mtimeMs > latest.mtime) {
          latest = { file: f, mtime: s.mtimeMs };
        }
      }

      const id = latest.file.replace(".jsonl", "");
      return this.load(id);
    } catch {
      return null;
    }
  }
}
