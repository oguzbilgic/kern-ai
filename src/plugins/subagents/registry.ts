import { randomUUID } from "crypto";
import { log } from "../../log.js";
import { runSubAgent, writeRecord, loadRecord, type RunOptions } from "./worker.js";
import { resolveModel } from "../../model.js";
import type { KernConfig } from "../../config.js";
import type { TurnOrigin } from "../types.js";

/**
 * Sub-agent registry — runs read-only child agents in-process and announces
 * their completion back to the origin of the turn that spawned them.
 *
 * Routing is not done here. `finalize` hands the completion body and the
 * captured origin (on the record) to an `AnnounceFn` — wired by the plugin to
 * `PluginContext.announce` — and the message queue does the rest, exactly
 * like background jobs in src/plugins/shell.
 */

export type SubAgentStatus = "running" | "done" | "failed" | "cancelled";

export interface SubAgentRecord {
  id: string;
  prompt: string;
  /** Model the child ran on. Optional — records from older versions lack it. */
  model?: string;
  status: SubAgentStatus;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Origin of the turn that spawned the child. Null when spawned outside a turn. */
  origin: TurnOrigin | null;
}

export interface SubAgentHandle {
  id: string;
  record: SubAgentRecord;
  abort: () => void;
  promise: Promise<string>;
}

export interface SpawnOptions {
  /** Origin of the turn spawning the child; completion is announced back to it. */
  origin: TurnOrigin | null;
  /** Max reasoning steps (default 20, capped at 50). */
  maxSteps?: number;
  /** Model override. Resolution: this > subAgentModel config > parent model. */
  model?: string;
}

/**
 * Delivers a completion body to the child's origin (`record.origin`).
 * Errors thrown here are logged by the registry and never propagate.
 */
export type AnnounceFn = (record: SubAgentRecord, body: string) => void | Promise<unknown>;

/** Runs one child to completion. Injectable so tests can avoid the model. */
export type SubAgentRunner = (opts: RunOptions) => Promise<string>;

export class SubAgentRegistry {
  private handles = new Map<string, SubAgentHandle>();
  private announceFn: AnnounceFn | null = null;
  private agentDir: string;
  private config: KernConfig;
  private runner: SubAgentRunner;

  constructor(agentDir: string, config: KernConfig, runner: SubAgentRunner = runSubAgent) {
    this.agentDir = agentDir;
    this.config = config;
    this.runner = runner;
  }

  setAnnouncer(fn: AnnounceFn) {
    this.announceFn = fn;
  }

  spawn(prompt: string, opts: SpawnOptions): SubAgentHandle {
    const id = "sa_" + randomUUID().slice(0, 8);
    // Model resolution: per-spawn override > subAgentModel config > parent model
    const effectiveModel = resolveModel(this.config, opts.model || this.config.subAgentModel || this.config.model);
    const record: SubAgentRecord = {
      id,
      prompt,
      model: effectiveModel.model,
      status: "running",
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      origin: opts.origin,
    };

    const controller = new AbortController();

    const promise = this.runner({
      id,
      prompt,
      config: { ...this.config, ...effectiveModel, api: effectiveModel.api, auth: effectiveModel.auth, apiKeyEnv: effectiveModel.apiKeyEnv },
      agentDir: this.agentDir,
      maxSteps: Math.min(opts.maxSteps ?? 20, 50),
      signal: controller.signal,
      onToolCall: () => {
        record.toolCalls++;
      },
      onUsage: (input, output) => {
        record.inputTokens = input;
        record.outputTokens = output;
      },
    }).then(
      (result) => {
        record.status = "done";
        record.result = result;
        record.finishedAt = new Date().toISOString();
        this.finalize(record);
        return result;
      },
      (err: Error) => {
        record.status = controller.signal.aborted ? "cancelled" : "failed";
        record.error = err.message;
        record.finishedAt = new Date().toISOString();
        this.finalize(record);
        throw err;
      },
    );

    const handle: SubAgentHandle = {
      id,
      record,
      abort: () => controller.abort(),
      promise,
    };

    this.handles.set(id, handle);
    // Swallow unhandled rejections — callers that care await `promise`.
    promise.catch(() => {});

    const preview = prompt.slice(0, 60).replace(/\n/g, " ");
    log("subagent", `spawned ${id}: "${preview}${prompt.length > 60 ? "..." : ""}"`);

    return handle;
  }

  get(id: string): SubAgentHandle | undefined {
    return this.handles.get(id);
  }

  list(): SubAgentRecord[] {
    return Array.from(this.handles.values()).map((h) => h.record);
  }

  cancel(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    if (handle.record.status !== "running") return false;
    handle.abort();
    return true;
  }

  countRunning(): number {
    let n = 0;
    for (const h of this.handles.values()) {
      if (h.record.status === "running") n++;
    }
    return n;
  }

  /** Cancel all running children — used on shutdown. */
  cancelAll(): number {
    let n = 0;
    for (const h of this.handles.values()) {
      if (h.record.status === "running") {
        h.abort();
        n++;
      }
    }
    return n;
  }

  /**
   * Load a record from disk. Used after process restart to fetch results of
   * children that completed before this registry was populated.
   */
  async loadFromDisk(id: string): Promise<SubAgentRecord | null> {
    return loadRecord(this.agentDir, id);
  }

  private finalize(record: SubAgentRecord) {
    writeRecord(this.agentDir, record).catch((e) =>
      log.warn("subagent", `record persist failed for ${record.id}: ${e.message}`),
    );
    if (this.announceFn) {
      try {
        this.announceFn(record, formatCompletion(record));
      } catch (e: any) {
        log.warn("subagent", `announce failed for ${record.id}: ${e.message}`);
      }
    }
  }
}

/** Runtime of a child, e.g. `12s`. Uses now for children still running. */
export function formatDuration(record: SubAgentRecord): string {
  const end = record.finishedAt ? +new Date(record.finishedAt) : Date.now();
  return `${Math.round((end - +new Date(record.startedAt)) / 1000)}s`;
}

/** `[subagent:<id> <status>, <duration>]` — first line of every completion body. */
export function formatHeader(record: SubAgentRecord): string {
  return `[subagent:${record.id} ${record.status}, ${formatDuration(record)}]`;
}

/**
 * Body of the completion turn announced back to the child's origin. The
 * header carries the source: the turn arrives under the origin's envelope,
 * so without it the parent could not tell the child's report from a message
 * the requester typed. Same convention as job completions (`[job:... ]`).
 */
export function formatCompletion(record: SubAgentRecord): string {
  const header = formatHeader(record);
  if (record.status === "done") return `${header}\n${record.result || "(no result)"}`;
  if (record.status === "failed") return `${header}\n${record.error || "unknown error"}`;
  return header;
}
