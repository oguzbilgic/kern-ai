/**
 * Mention gating for group chats and channels.
 *
 * kern agents sit in shared rooms (Slack channels, Telegram groups, Matrix
 * rooms, IRC channels) where most traffic isn't for them. Historically every
 * one of those messages started a full model turn and the agent was merely
 * *asked* — via the `NO_REPLY` convention in `KERN.md` — to stay quiet. That
 * put the decision in the hands of the model: it cost a turn (tokens, latency,
 * a visible "..." placeholder on Telegram) before the agent could decline, and
 * models being models, it sometimes chatted anyway.
 *
 * The gate makes the rule structural: in a group, the runtime only starts a
 * turn when the agent is actually addressed. Everything else is *observed* —
 * buffered per channel and folded into the next addressed turn as context, so
 * the agent still walks into the conversation knowing what was said. It never
 * loses the room, it just doesn't speak in it uninvited.
 *
 * Each interface decides what "addressed" means on its platform (a platform
 * @mention, a reply to one of the agent's own messages, a nick prefix on IRC)
 * — that part can't be shared. What lives here is the policy switch and the
 * observation buffer.
 *
 * DMs are never gated: a direct message is addressed by construction.
 */

/** One unaddressed message the agent saw but did not answer. */
export interface ObservedMessage {
  /** Display name of the sender — whatever the interface uses in logs/labels. */
  sender: string;
  /** Message body, already truncated to `MAX_OBSERVED_CHARS`. */
  text: string;
}

/** Per-channel cap on buffered messages. Oldest are dropped first. */
export const MAX_OBSERVED_MESSAGES = 50;

/** Per-message cap on buffered text. Long pastes are cut, not stored whole. */
export const MAX_OBSERVED_CHARS = 500;

/**
 * Cap on how many channels hold a buffer at once. A bot can be added to
 * unbounded groups, and a channel's buffer is only drained by the agent being
 * addressed there, so without a cap an idle-but-chatty room would retain its
 * window for the life of the process. Least-recently-observed is evicted.
 */
export const MAX_OBSERVED_CHANNELS = 200;

/**
 * Holds the mentions-only policy and the per-channel observation buffers.
 *
 * One instance per agent process, created in `app.ts` from
 * `config.mentionsOnly` and handed to every group-capable interface.
 */
export class MentionGate {
  private enabled: boolean;
  private maxMessages: number;
  /** channel key -> observed messages, oldest first. */
  private buffers = new Map<string, ObservedMessage[]>();
  /** channel key -> messages dropped from the head since the last drain. */
  private dropped = new Map<string, number>();

  constructor(enabled: boolean, maxMessages: number = MAX_OBSERVED_MESSAGES) {
    this.enabled = enabled;
    this.maxMessages = Math.max(0, maxMessages);
  }

  /**
   * Whether gating is on. Interfaces check this before suppressing a turn —
   * when it's off they deliver every group message as they always did.
   */
  get active(): boolean {
    return this.enabled;
  }

  /**
   * Record a group message the agent was not addressed in. No-op when gating
   * is disabled — nothing will ever drain the buffer in that mode, so filling
   * it would just leak memory.
   */
  observe(channelKey: string, sender: string, text: string): void {
    if (!this.enabled) return;
    if (this.maxMessages === 0) return;
    const body = (text || "").trim();
    if (!body) return;

    const buf = this.buffers.get(channelKey) || [];
    // Re-insert so Map iteration order is least-recently-observed first.
    this.buffers.delete(channelKey);
    while (this.buffers.size >= MAX_OBSERVED_CHANNELS) {
      const oldest = this.buffers.keys().next().value;
      if (oldest === undefined) break;
      this.buffers.delete(oldest);
      this.dropped.delete(oldest);
    }
    buf.push({
      sender,
      text: body.length > MAX_OBSERVED_CHARS
        ? `${body.slice(0, MAX_OBSERVED_CHARS)}…`
        : body,
    });
    // Keep the most recent window. Overflow is counted, not silently lost —
    // the folded block tells the agent how much it isn't seeing.
    if (buf.length > this.maxMessages) {
      const overflow = buf.length - this.maxMessages;
      buf.splice(0, overflow);
      this.dropped.set(channelKey, (this.dropped.get(channelKey) || 0) + overflow);
    }
    this.buffers.set(channelKey, buf);
  }

  /** Number of messages currently buffered for a channel. */
  pending(channelKey: string): number {
    return this.buffers.get(channelKey)?.length || 0;
  }

  /** Take and clear the buffered messages for a channel. */
  drain(channelKey: string): { messages: ObservedMessage[]; dropped: number } {
    const messages = this.buffers.get(channelKey) || [];
    const dropped = this.dropped.get(channelKey) || 0;
    this.buffers.delete(channelKey);
    this.dropped.delete(channelKey);
    return { messages, dropped };
  }

  /**
   * Prefix an addressed message with everything observed in that channel since
   * the agent last spoke there, and clear the buffer. Returns `text` unchanged
   * when gating is off or nothing was observed.
   *
   * Slash commands are left alone and keep their buffer: the command router
   * matches on a leading `/`, so folding context in front of `/status` would
   * turn it into an ordinary message — intermittently, depending on whether
   * anything happened to be buffered. The context folds into the next real
   * turn instead.
   */
  withContext(channelKey: string, text: string): string {
    if (!this.enabled) return text;
    if (text.trim().startsWith("/")) return text;
    const { messages, dropped } = this.drain(channelKey);
    if (messages.length === 0) return text;
    return `${formatObserved(messages, dropped)}\n${text}`;
  }
}

/**
 * Render buffered messages as a context block for the model.
 *
 * Plain-text and clearly fenced, in the same bracketed style as the message
 * envelope the model already reads, so it can't be mistaken for a request.
 */
export function formatObserved(messages: ObservedMessage[], dropped = 0): string {
  const lines = messages.map((m) => `${m.sender}: ${m.text}`);
  const skipped = dropped > 0
    ? `\n[…${dropped} earlier message${dropped === 1 ? "" : "s"} not shown]`
    : "";
  return [
    `[${messages.length} message${messages.length === 1 ? "" : "s"} in this channel you were not addressed in — context only, do not reply to them]${skipped}`,
    ...lines,
    "[end of observed messages]",
  ].join("\n");
}

/** Escape a string for safe use inside a `RegExp`. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `text` mentions `name` as a standalone word, with or without a
 * leading `@`. Used where a bare name is the platform's mention mechanism —
 * IRC nicks, Matrix display-name pills.
 *
 * Word boundaries are hand-rolled rather than `\b` because nicks and display
 * names legally contain `[ ] { } \ ^ ` | -`, which `\w` doesn't cover: `\bvega\b`
 * would fire on `vega-bot`.
 */
export function mentionsName(text: string, name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  const edge = "[^\\w\\[\\]{}\\\\^`|-]";
  return new RegExp(`(^|${edge})@?${escapeRegex(n)}(${edge}|$)`, "i").test(text);
}

/** Text used when the agent is addressed with no message of its own. */
export const BARE_MENTION_TEXT = "(mentioned with no message)";

/**
 * Bounded set of the agent's own outbound message/event ids, so a reply to one
 * of them can be recognized as addressing the agent. Oldest ids are evicted
 * first — a reply to something the agent said thousands of messages ago is not
 * worth the memory.
 */
export class SentIds {
  private ids: string[] = [];
  private set = new Set<string>();
  private max: number;

  constructor(max = 500) {
    this.max = Math.max(1, max);
  }

  add(id: string | undefined | null): void {
    if (!id || this.set.has(id)) return;
    this.ids.push(id);
    this.set.add(id);
    while (this.ids.length > this.max) {
      const evicted = this.ids.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
  }

  has(id: string | undefined | null): boolean {
    return !!id && this.set.has(id);
  }
}
