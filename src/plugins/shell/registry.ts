import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { log } from "../../log.js";
import type { TurnOrigin } from "../types.js";

/**
 * Background job registry — runs shell commands detached from the turn that
 * started them and announces their completion back to that turn's origin.
 *
 * Each job gets a directory under `.kern/jobs/<id>/`:
 *   output.log   — combined stdout+stderr, appended live
 *   record.json  — metadata, written on finish
 *
 * Routing is not done here. `finalize` hands the completion text and the
 * captured origin to an `AnnounceFn` (wired by the plugin to
 * `PluginContext.announce`), and the message queue does the rest.
 */

export type JobStatus = "running" | "exited" | "killed";

export interface JobRecord {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  status: JobStatus;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: string;
  finishedAt?: string;
  logPath: string;
  /** Origin of the turn that started the job. Null when started outside a turn. */
  origin: TurnOrigin | null;
  /** Set when the job was killed by shutdown rather than by request. */
  shutdown?: boolean;
}

export interface JobHandle {
  id: string;
  record: JobRecord;
  /** Resolves when the process closes (never rejects). */
  done: Promise<JobRecord>;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export interface StartOptions {
  origin: TurnOrigin | null;
  cwd?: string;
  /** Kill the job after this many ms. 0 / undefined = no limit. */
  timeout?: number;
  /**
   * Jobs that finish within this window are NOT announced — the caller is
   * still waiting on `done` and reports the result synchronously instead.
   */
  graceMs?: number;
}

export type AnnounceFn = (record: JobRecord, body: string) => void;

/** Tail kept in memory per job and included in the completion message. */
export const MAX_TAIL_CHARS = 25_000;

export class JobRegistry {
  private jobs = new Map<string, { handle: JobHandle; child: ChildProcess; tail: string; stream: WriteStream }>();
  private announceFn: AnnounceFn | null = null;
  private shuttingDown = false;

  constructor(private agentDir: string) {}

  setAnnouncer(fn: AnnounceFn) {
    this.announceFn = fn;
  }

  start(command: string, opts: StartOptions): JobHandle {
    const id = "job_" + randomUUID().slice(0, 8);
    const dir = join(this.agentDir, ".kern", "jobs", id);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "output.log");
    const stream = createWriteStream(logPath, { flags: "a" });
    const cwd = opts.cwd || process.cwd();
    const startedAt = Date.now();
    const graceMs = opts.graceMs ?? 0;

    const record: JobRecord = {
      id,
      command,
      cwd,
      status: "running",
      startedAt: new Date(startedAt).toISOString(),
      logPath,
      origin: opts.origin,
    };

    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so kill() reaches the whole pipeline, not just `sh`.
      detached: process.platform !== "win32",
    });
    record.pid = child.pid;

    const entry = { handle: null as unknown as JobHandle, child, tail: "", stream };
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      stream.write(text);
      entry.tail = (entry.tail + text).slice(-MAX_TAIL_CHARS);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let killedByUs = false;
    const kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
      if (record.status !== "running") return false;
      killedByUs = true;
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
        return true;
      } catch (e: any) {
        log.warn("jobs", `kill ${id} failed: ${e.message}`);
        return false;
      }
    };

    let timer: NodeJS.Timeout | null = null;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        log("jobs", `${id} hit timeout after ${opts.timeout}ms — killing`);
        kill();
      }, opts.timeout);
    }

    const done = new Promise<JobRecord>((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
        if (timer) clearTimeout(timer);
        if (record.status !== "running") return;
        record.finishedAt = new Date().toISOString();
        record.exitCode = code;
        record.signal = signal;
        record.status = killedByUs ? "killed" : "exited";
        if (this.shuttingDown) record.shutdown = true;
        if (error) entry.tail = (entry.tail + `\nError: spawn failed: ${error}`).slice(-MAX_TAIL_CHARS);
        stream.end();
        const elapsed = Date.now() - startedAt;
        this.finalize(record, entry.tail, elapsed >= graceMs);
        resolve(record);
      };
      child.on("error", (err) => finish(null, null, err.message));
      child.on("close", (code, signal) => finish(code, signal));
    });

    const handle: JobHandle = { id, record, done, kill };
    entry.handle = handle;
    this.jobs.set(id, entry);

    const preview = command.replace(/\s+/g, " ").slice(0, 60);
    log("jobs", `started ${id} (pid ${child.pid ?? "?"}): ${preview}${command.length > 60 ? "..." : ""}`);
    return handle;
  }

  get(id: string): JobHandle | undefined {
    return this.jobs.get(id)?.handle;
  }

  list(): JobRecord[] {
    return Array.from(this.jobs.values()).map((j) => j.handle.record);
  }

  /** Last `chars` characters of the job's output captured so far. */
  tail(id: string, chars = 4000): string | null {
    const entry = this.jobs.get(id);
    if (!entry) return null;
    return entry.tail.slice(-chars);
  }

  kill(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    return entry.handle.kill();
  }

  countRunning(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.handle.record.status === "running") n++;
    return n;
  }

  /**
   * Kill every running job. Used on shutdown — completions are not announced
   * because there is no process left to deliver them.
   */
  killAll(): number {
    this.shuttingDown = true;
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.handle.kill()) n++;
    }
    return n;
  }

  async loadFromDisk(id: string): Promise<JobRecord | null> {
    const path = join(this.agentDir, ".kern", "jobs", id, "record.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf-8"));
    } catch {
      return null;
    }
  }

  private finalize(record: JobRecord, tail: string, announce: boolean) {
    const dir = join(this.agentDir, ".kern", "jobs", record.id);
    writeFile(join(dir, "record.json"), JSON.stringify(record, null, 2)).catch((e) =>
      log.warn("jobs", `record persist failed for ${record.id}: ${e.message}`),
    );
    log("jobs", `${record.id} ${record.status} (code ${record.exitCode ?? "?"}${record.signal ? `, ${record.signal}` : ""})`);
    if (!announce || this.shuttingDown || !this.announceFn) return;
    try {
      this.announceFn(record, formatCompletion(record, tail));
    } catch (e: any) {
      log.warn("jobs", `announce failed for ${record.id}: ${e.message}`);
    }
  }
}

export function formatDuration(record: JobRecord): string {
  const end = record.finishedAt ? +new Date(record.finishedAt) : Date.now();
  return `${Math.round((end - +new Date(record.startedAt)) / 1000)}s`;
}

/** Header line summarizing how a job ended, e.g. `[job:job_ab12cd34 exited 0, 42s]`. */
export function formatHeader(record: JobRecord): string {
  const outcome = record.status === "killed"
    ? `killed${record.signal ? ` (${record.signal})` : ""}`
    : `exited ${record.exitCode ?? "?"}`;
  return `[job:${record.id} ${outcome}, ${formatDuration(record)}]`;
}

/** Body of the completion turn announced back to the job's origin. */
export function formatCompletion(record: JobRecord, tail: string): string {
  const relLog = record.logPath.startsWith(record.cwd) ? record.logPath.slice(record.cwd.length + 1) : record.logPath;
  return [
    `${formatHeader(record)} ${record.command}`,
    tail.trim() || "(no output)",
    `(full log: ${relLog})`,
  ].join("\n");
}
