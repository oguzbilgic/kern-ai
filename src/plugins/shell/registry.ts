import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "fs";
import { readFile, readdir, writeFile } from "fs/promises";
import { join, relative, isAbsolute } from "path";
import { uptime } from "os";
import { log } from "../../log.js";
import type { TurnOrigin } from "../types.js";

/**
 * Background job registry — runs shell commands detached from the turn that
 * started them and announces their completion back to that turn's origin.
 *
 * Each job gets a directory under `.kern/jobs/<id>/`:
 *   output.log   — combined stdout+stderr, appended live
 *   record.json  — metadata; written at start (so orphans can be reaped
 *                  after a crash) and again on finish
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
  /** Set when the job was killed by shutdown or orphan reaping rather than by request. */
  shutdown?: boolean;
  /** Set when kill() was requested. Status still reflects how the process actually ended. */
  killRequested?: boolean;
  /** Reminder interval in seconds, when the job was started with one. */
  remindEverySec?: number;
}

export interface JobHandle {
  id: string;
  record: JobRecord;
  /**
   * Resolves true if the process closed within the grace window (the caller
   * reports the result itself; nothing is announced), false once the window
   * has passed (any later close is announced). Settles exactly once.
   */
  quick: Promise<boolean>;
  /** Resolves once the process has closed, the log is flushed and the record is written. Never rejects. */
  done: Promise<JobRecord>;
  kill: (signal?: NodeJS.Signals) => boolean;
}

export interface StartOptions {
  origin: TurnOrigin | null;
  cwd?: string;
  /** Kill the job after this many ms. 0 / undefined = no limit. */
  timeout?: number;
  /** Jobs that close within this window are NOT announced — see `JobHandle.quick`. */
  graceMs?: number;
  /**
   * Announce a short "still running" reminder to the origin every this many
   * seconds while the job runs. 0 / undefined = never. The first reminder
   * fires one interval after the grace window closes.
   */
  remindEverySec?: number;
}

/**
 * Delivers a completion or reminder body to the job's origin. May return a
 * promise that settles once the message has been consumed (the agent
 * replied); reminders use it to keep at most one in flight per job.
 */
export type AnnounceFn = (record: JobRecord, body: string) => void | Promise<unknown>;

/** Tail kept in memory per job and included in the completion message. */
export const MAX_TAIL_CHARS = 25_000;
/** How long kill()/killAll wait after SIGTERM before escalating to SIGKILL. */
export const SHUTDOWN_GRACE_MS = 2000;
/**
 * After the process exits, how long to wait for its stdio pipes to drain
 * before finalizing. A detached grandchild holding the pipe would otherwise
 * keep the job "running" forever (Node's `close` never fires).
 */
export const DRAIN_MS = 500;

const ID_RE = /^job_[0-9a-f]{8}$/;

export function isValidJobId(id: string): boolean {
  return ID_RE.test(id);
}

const isWindows = process.platform === "win32";

/** Signal a process group (Unix) or a single process. Returns false if nothing was signalled. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(isWindows ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
    const graceMs = opts.graceMs ?? 0;
    // Reminders need somewhere to go: without an origin they are never armed
    // and the record does not claim them, so the tool result stays honest.
    const remindMs = opts.origin && opts.remindEverySec && opts.remindEverySec > 0 ? opts.remindEverySec * 1000 : 0;

    const record: JobRecord = {
      id,
      command,
      cwd,
      status: "running",
      startedAt: new Date().toISOString(),
      logPath,
      origin: opts.origin,
      remindEverySec: remindMs ? opts.remindEverySec : undefined,
    };

    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so kill() reaches the whole pipeline, not just `sh`.
      detached: !isWindows,
    });
    record.pid = child.pid;
    // Persist immediately so a crash leaves a record that startup can reap.
    this.persist(record);

    const entry = { handle: null as unknown as JobHandle, child, tail: "", stream };
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      stream.write(text);
      entry.tail = (entry.tail + text).slice(-MAX_TAIL_CHARS);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let escalateTimer: NodeJS.Timeout | null = null;
    const kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
      if (record.status !== "running" || !child.pid) return false;
      const ok = signalGroup(child.pid, signal);
      if (!ok) {
        log.warn("jobs", `kill ${id} (${signal}) failed — process likely already exited`);
        return false;
      }
      record.killRequested = true;
      // A job that ignores SIGTERM gets SIGKILL after the grace period.
      if (signal === "SIGTERM" && !escalateTimer) {
        escalateTimer = setTimeout(() => {
          if (record.status === "running" && child.pid) {
            log.warn("jobs", `${id} ignored SIGTERM — sending SIGKILL`);
            signalGroup(child.pid, "SIGKILL");
          }
        }, SHUTDOWN_GRACE_MS);
      }
      return true;
    };

    let timeoutTimer: NodeJS.Timeout | null = null;
    if (opts.timeout && opts.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        log("jobs", `${id} hit timeout after ${opts.timeout}ms — killing`);
        kill();
      }, opts.timeout);
    }

    // Single grace clock. Whichever settles first — close or timer — decides
    // who reports: the caller (quick=true) or the announcer (quick=false).
    let resolveQuick!: (v: boolean) => void;
    const quick = new Promise<boolean>((r) => { resolveQuick = r; });
    let graceExpired = false;
    // Periodic "still running" reminder, announced like a completion. Armed
    // only once the grace window has closed — a job that finishes inside it
    // reports synchronously and must stay silent.
    // At most one reminder is in flight per job: while the agent is busy
    // elsewhere the queued reminder waits, and ticks in the meantime are
    // skipped rather than piling up behind it.
    let remindTimer: NodeJS.Timeout | null = null;
    let remindPending: Promise<unknown> | null = null;
    const armReminder = () => {
      if (!remindMs || record.status !== "running") return;
      remindTimer = setInterval(() => {
        if (record.status !== "running" || this.shuttingDown || !this.announceFn || remindPending) return;
        try {
          const result = this.announceFn(record, formatReminder(record));
          if (result && typeof (result as Promise<unknown>).then === "function") {
            remindPending = (result as Promise<unknown>).catch(() => {}).finally(() => { remindPending = null; });
          }
        } catch (e: any) {
          log.warn("jobs", `reminder announce failed for ${id}: ${e.message}`);
        }
      }, remindMs);
    };
    const graceTimer = graceMs > 0
      ? setTimeout(() => { graceExpired = true; resolveQuick(false); armReminder(); }, graceMs)
      : null;
    if (!graceTimer) { graceExpired = true; resolveQuick(false); armReminder(); }

    const done = new Promise<JobRecord>((resolve) => {
      let settled = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (escalateTimer) clearTimeout(escalateTimer);
        if (remindTimer) clearInterval(remindTimer);
        const withinGrace = !graceExpired;
        resolveQuick(withinGrace);

        record.finishedAt = new Date().toISOString();
        record.exitCode = code;
        record.signal = signal;
        // Outcome, not intent: killed only if the process died by signal.
        record.status = signal ? "killed" : "exited";
        if (this.shuttingDown) record.shutdown = true;
        if (error) entry.tail = (entry.tail + `\nError: spawn failed: ${error}`).slice(-MAX_TAIL_CHARS);

        log("jobs", `${id} ${record.status} (code ${code ?? "?"}${signal ? `, ${signal}` : ""})`);
        // Announce now — latency matters more than the log flush below.
        if (!withinGrace && !this.shuttingDown && this.announceFn) {
          try {
            this.announceFn(record, formatCompletion(record, entry.tail));
          } catch (e: any) {
            log.warn("jobs", `announce failed for ${id}: ${e.message}`);
          }
        }

        const flushed = new Promise<void>((r) => stream.end(() => r()));
        Promise.all([flushed, this.persist(record)]).then(() => resolve(record));
      };
      child.on("error", (err) => finish(null, null, err.message));
      // Key on `exit` (the process is gone), not `close` (all stdio ended):
      // a detached grandchild holding stdout would otherwise keep the job
      // open forever. Give the pipes a bounded moment to drain first.
      child.on("exit", (code, signal) => {
        const drain = setTimeout(() => finish(code, signal), DRAIN_MS);
        child.once("close", () => { clearTimeout(drain); finish(code, signal); });
      });
    });

    const handle: JobHandle = { id, record, quick, done, kill };
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
   * Kill every running job and wait for them to go: SIGTERM, then SIGKILL
   * for anything still alive after `graceMs`. Used on shutdown — completions
   * are not announced because there is no process left to deliver them.
   * Returns the number of jobs that were running.
   */
  async killAll(graceMs = SHUTDOWN_GRACE_MS): Promise<number> {
    this.shuttingDown = true;
    const running = Array.from(this.jobs.values()).filter((j) => j.handle.record.status === "running");
    for (const j of running) j.handle.kill("SIGTERM");
    if (running.length === 0) return 0;

    const allDone = Promise.all(running.map((j) => j.handle.done));
    const timedOut = await Promise.race([
      allDone.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), graceMs)),
    ]);
    if (timedOut) {
      for (const j of running) {
        if (j.handle.record.status === "running") j.handle.kill("SIGKILL");
      }
      // Bounded: never let a job we can't reach hold up shutdown.
      await Promise.race([allDone, new Promise((r) => setTimeout(r, graceMs))]);
    }
    return running.length;
  }

  /**
   * Kill jobs left over from a previous process that died without running
   * shutdown (crash, SIGKILL). Their records are still marked running; the
   * processes may or may not be. Returns the number of records reaped.
   */
  async reapOrphans(): Promise<number> {
    const root = join(this.agentDir, ".kern", "jobs");
    if (!existsSync(root)) return 0;
    let n = 0;
    for (const id of await readdir(root)) {
      if (!isValidJobId(id)) continue;
      const record = await this.loadFromDisk(id);
      if (!record || record.status !== "running") continue;
      // PIDs are reused across reboots. If the machine booted after the job
      // started, the process is certainly gone — don't signal a stranger.
      const bootedAt = Date.now() - uptime() * 1000;
      const sameBoot = +new Date(record.startedAt) > bootedAt;
      if (sameBoot && record.pid && isAlive(record.pid)) {
        signalGroup(record.pid, "SIGKILL");
        log("jobs", `reaped orphan ${id} (pid ${record.pid})`);
      }
      record.status = "killed";
      record.shutdown = true;
      record.finishedAt = new Date().toISOString();
      await this.persist(record);
      n++;
    }
    return n;
  }

  async loadFromDisk(id: string): Promise<JobRecord | null> {
    if (!isValidJobId(id)) return null;
    const path = join(this.agentDir, ".kern", "jobs", id, "record.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, "utf-8"));
    } catch {
      return null;
    }
  }

  private persist(record: JobRecord): Promise<void> {
    const dir = join(this.agentDir, ".kern", "jobs", record.id);
    return writeFile(join(dir, "record.json"), JSON.stringify(record, null, 2)).catch((e) =>
      log.warn("jobs", `record persist failed for ${record.id}: ${e.message}`),
    );
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

/** Body of the periodic reminder announced while a job is still running. */
export function formatReminder(record: JobRecord): string {
  return `[job:${record.id} still running, ${formatDuration(record)}] ${record.command}`;
}

/** Body of the completion turn announced back to the job's origin. */
export function formatCompletion(record: JobRecord, tail: string): string {
  const rel = relative(record.cwd, record.logPath);
  const shownLog = rel.startsWith("..") || isAbsolute(rel) ? record.logPath : rel;
  return [
    `${formatHeader(record)} ${record.command}`,
    tail.trim() || "(no output)",
    `(full log: ${shownLog})`,
  ].join("\n");
}
