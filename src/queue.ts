import type { StreamEvent } from "./runtime.js";
import type { Attachment } from "./interfaces/types.js";

export interface QueuedMessage {
  text: string;
  userId: string;
  interface: string;
  channel: string;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  onEvent?: (event: StreamEvent) => void;
  isHeartbeat?: boolean;
  attachments?: Attachment[];
}

import { log } from "./log.js";

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;
  private activeChannel: string | null = null;
  // Monotonically-increasing token for the current turn. Used to ignore
  // stale drain calls from a handler that timed out but is still running
  // in the background (Promise.race doesn't cancel the loser).
  private turnId = 0;
  // Same-channel messages that arrived mid-turn, waiting to be drained into
  // the active turn via prepareStep.
  private pendingSameChannel: QueuedMessage[] = [];
  // Same-channel messages already drained into the active turn. Kept around
  // so we can resolve their Promises with NO_REPLY when the turn finishes —
  // otherwise the interface handlers that awaited onMessage() would hang.
  private drainedSameChannel: QueuedMessage[] = [];
  private handler: ((msg: QueuedMessage, pendingMessages: () => QueuedMessage[], signal: AbortSignal) => Promise<string>) | null = null;
  // Idle timeout: a turn is killed only after this long with NO activity
  // (no stream events). Every token/tool event resets the timer via touch(),
  // so long productive turns never time out — only genuinely hung ones.
  private idleTimeoutMs = 5 * 60 * 1000;
  // Resets the current turn's idle timer. Null when no turn is active.
  private touchFn: (() => void) | null = null;

  setHandler(fn: (msg: QueuedMessage, pendingMessages: () => QueuedMessage[], signal: AbortSignal) => Promise<string>) {
    this.handler = fn;
  }

  // Called on every stream event to signal the active turn is making progress.
  // No-op when no turn is active.
  touch() {
    this.touchFn?.();
  }

  getActiveChannel(): string | null {
    return this.activeChannel;
  }

  getStatus(): { processing: boolean; pending: number; activeChannel: string | null } {
    return {
      processing: this.processing,
      pending: this.queue.length,
      activeChannel: this.activeChannel,
    };
  }

  enqueue(msg: Omit<QueuedMessage, "resolve" | "reject">, onEvent?: (event: StreamEvent) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const queued: QueuedMessage = { ...msg, resolve, reject, onEvent };

      // If we're processing and this is same channel (not heartbeat), store as pending injection
      if (this.processing && !msg.isHeartbeat && this.activeChannel && msg.channel === this.activeChannel) {
        this.pendingSameChannel.push(queued);
        log("queue", `same-channel injection queued (${msg.channel})`);
        return;
      }

      this.queue.push(queued);
      log("queue", `enqueued (${msg.interface}:${msg.channel || "?"}) depth=${this.queue.length} processing=${this.processing}`);
      this.processNext();
    });
  }

  // Called by prepareStep to get pending same-channel messages.
  // Drained messages are moved to `drainedSameChannel` so their Promises
  // can still be resolved when the active turn finishes.
  drainPendingSameChannel(): QueuedMessage[] {
    const pending = [...this.pendingSameChannel];
    this.pendingSameChannel = [];
    this.drainedSameChannel.push(...pending);
    return pending;
  }

  // Resolve drained injections with NO_REPLY — they were folded into the
  // active turn's response, so their interface handlers must stay quiet.
  // Requeue still-pending same-channel messages — they arrived mid-turn but
  // were never drained (e.g. single-step turn with no prepareStep calls), so
  // they need to run as their own turn instead of being silently dropped.
  private finalizePendingSameChannel() {
    for (const drained of this.drainedSameChannel) {
      drained.resolve("NO_REPLY");
    }
    this.drainedSameChannel = [];

    const requeue = this.pendingSameChannel;
    this.pendingSameChannel = [];
    for (const msg of requeue) {
      this.queue.push(msg);
      log("queue", `requeued same-channel message (${msg.interface}:${msg.channel || "?"})`);
    }
  }

  private async processNext() {
    if (this.processing) return;
    if (this.queue.length === 0) return;

    this.processing = true;
    const msg = this.queue.shift()!;
    this.activeChannel = msg.isHeartbeat ? null : msg.channel;
    const turnId = ++this.turnId;

    log("queue", `processing (${msg.interface}:${msg.channel || "?"}) remaining=${this.queue.length}`);

    // Abort controller for this turn. On idle timeout we abort so the
    // handler's LLM stream actually stops instead of running on as a zombie.
    const controller = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;

    try {
      // Race handler against an idle timeout. The timer resets on every
      // stream event (via touch()), so only turns with no activity die.
      const idleTimeout = new Promise<string>((_, reject) => {
        const fire = () => {
          controller.abort();
          reject(new Error(`Message processing timed out (no activity for ${this.idleTimeoutMs / 1000}s)`));
        };
        idleTimer = setTimeout(fire, this.idleTimeoutMs);
        this.touchFn = () => {
          if (turnId !== this.turnId) return;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(fire, this.idleTimeoutMs);
        };
      });

      const response = await Promise.race([
        this.handler!(msg, () => {
          if (turnId !== this.turnId) return [];
          return this.drainPendingSameChannel();
        }, controller.signal),
        idleTimeout,
      ]);

      msg.resolve(response);
      this.finalizePendingSameChannel();
    } catch (error: any) {
      log.error("queue", `error: ${error.message}`);
      msg.reject(error);
      // Errors belong to the active message. Drained injections were already
      // folded into the (failed) turn, so NO_REPLY them. Still-pending
      // messages were never touched — requeue them for their own turn.
      this.finalizePendingSameChannel();
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      this.touchFn = null;
      this.processing = false;
      this.activeChannel = null;
      log("queue", `done, remaining=${this.queue.length}`);
      this.processNext();
    }
  }
}
