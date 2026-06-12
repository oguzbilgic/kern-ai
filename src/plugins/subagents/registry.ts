import { randomUUID } from "crypto";
import { log } from "../../log.js";
import { runSubAgent, writeRecord, loadRecord } from "./worker.js";
import type { KernConfig } from "../../config.js";

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
}

export interface SubAgentHandle {
  id: string;
  record: SubAgentRecord;
  abort: () => void;
  promise: Promise<string>;
}

/** Announcer — fires when any sub-agent finishes. Registered by app.ts. */
export type AnnounceFn = (id: string, record: SubAgentRecord) => void;

export class SubAgentRegistry {
  private handles = new Map<string, SubAgentHandle>();
  private announceFn: AnnounceFn | null = null;
  private agentDir: string;
  private config: KernConfig;

  constructor(agentDir: string, config: KernConfig) {
    this.agentDir = agentDir;
    this.config = config;
  }

  setAnnouncer(fn: AnnounceFn) {
    this.announceFn = fn;
  }

  spawn(prompt: string, maxSteps = 20, model?: string): SubAgentHandle {
    const id = "sa_" + randomUUID().slice(0, 8);
    // Model resolution: per-spawn override > subAgentModel config > parent model
    const effectiveModel = model || this.config.subAgentModel || this.config.model;
    const record: SubAgentRecord = {
      id,
      prompt,
      model: effectiveModel,
      status: "running",
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };

    const controller = new AbortController();

    const promise = runSubAgent({
      id,
      prompt,
      config: { ...this.config, model: effectiveModel },
      agentDir: this.agentDir,
      maxSteps: Math.min(maxSteps, 50),
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
        this.announceFn(record.id, record);
      } catch (e: any) {
        log.warn("subagent", `announce failed for ${record.id}: ${e.message}`);
      }
    }
  }
}
