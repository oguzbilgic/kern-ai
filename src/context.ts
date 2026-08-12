import type { ModelMessage, SystemModelMessage, ToolResultPart } from "ai";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { log } from "./log.js";
import { getToolsForScope, type KernConfig } from "./config.js";
import type { SegmentIndex } from "./segments.js";

function wrapDocument(pathLabel: string, content: string): string {
  const safePath = pathLabel.replace(/"/g, '&quot;');
  return `<document path="${safePath}">\n${content.trim()}\n</document>`;
}

function wrapTools(content: string): string {
  return `<tools>\n${content.trim()}\n</tools>`;
}

// Build the system prompt from agent markdown files + runtime info.
export async function loadSystemPrompt(agentDir: string, config: KernConfig, pluginToolDescriptions: Record<string, string> = {}): Promise<string> {
  const parts: string[] = [];

  // Load AGENTS.md (kernel)
  const agentsPath = join(agentDir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    parts.push(wrapDocument("AGENTS.md", await readFile(agentsPath, "utf-8")));
  }

  // Load IDENTITY.md
  const identityPath = join(agentDir, "IDENTITY.md");
  if (existsSync(identityPath)) {
    parts.push(wrapDocument("IDENTITY.md", await readFile(identityPath, "utf-8")));
  }

  // Load KERN.md (runtime context) — from agent dir first, fall back to kern package
  const kernMdAgent = join(agentDir, "KERN.md");
  const kernMdPackage = join(import.meta.dirname, "..", "templates", "KERN.md");
  if (existsSync(kernMdAgent)) {
    parts.push(wrapDocument("KERN.md", await readFile(kernMdAgent, "utf-8")));
  } else if (existsSync(kernMdPackage)) {
    parts.push(wrapDocument("KERN.md", await readFile(kernMdPackage, "utf-8")));
  }

  // Load KNOWLEDGE.md (memory index)
  const knowledgePath = join(agentDir, "KNOWLEDGE.md");
  if (existsSync(knowledgePath)) {
    parts.push(wrapDocument("KNOWLEDGE.md", await readFile(knowledgePath, "utf-8")));
  }

  // Load USERS.md (paired users)
  const usersPath = join(agentDir, "USERS.md");
  if (existsSync(usersPath)) {
    parts.push(wrapDocument("USERS.md", await readFile(usersPath, "utf-8")));
  }

  // Inject live runtime info
  const tools = getToolsForScope(config.toolScope);
  const toolDescriptions: Record<string, string> = {
    bash: "run shell commands",
    pwsh: "run PowerShell commands (Windows)",
    read: "read files and directories",
    write: "create or overwrite files",
    edit: "find and replace in files",
    glob: "find files by pattern",
    grep: "search file contents",
    webfetch: "fetch URLs",
    pdf: "extract text or analyze PDF files",
    image: "analyze image files using the AI model",
    kern: "manage your own runtime (status, config, env)",
    message: "send messages proactively",
    ...pluginToolDescriptions,
  };
  // Plugin tools are always available — add them to the list
  const allToolNames = [...tools, ...Object.keys(pluginToolDescriptions).filter(t => !tools.includes(t))];
  const toolList = allToolNames.map(t => `- **${t}**: ${toolDescriptions[t] || t}`).join("\n");

  parts.push(wrapTools(toolList));

  if (parts.length === 0) {
    return "You are a helpful AI assistant.";
  }

  return parts.join("\n\n");
}

// Token estimate: stringify everything, ~3.3 chars per token + per-message overhead.
// chars/4 underestimates by ~25% vs actual tokenizer output.
// Per-message overhead accounts for API framing not captured in JSON.stringify.
const CHARS_PER_TOKEN = 3.3;
const PER_MESSAGE_OVERHEAD = 4; // role/separator tokens per message

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += JSON.stringify(msg).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + (messages.length * PER_MESSAGE_OVERHEAD);
}

// Per-message token size cache
const msgSizeCache = new WeakMap<ModelMessage, number>();

function getMsgSize(msg: ModelMessage): number {
  let size = msgSizeCache.get(msg);
  if (size === undefined) {
    size = Math.ceil(JSON.stringify(msg).length / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
    msgSizeCache.set(msg, size);
  }
  return size;
}

// Truncate oversized tool results to keep context window usable.
// Full results remain in session JSONL — only the context copy is truncated.
function truncateLargeToolResults(messages: ModelMessage[], maxChars: number, tokenBudget: number = 0): { messages: ModelMessage[]; truncatedCount: number } {
  if (maxChars <= 0) return { messages, truncatedCount: 0 };

  // Only process messages within 2x the token budget from the end — older ones get trimmed anyway.
  // Exception: any single message larger than maxChars (as tokens) is always truncated,
  // even if it falls outside the 2x window — otherwise it poisons trimToTokenBudget().
  const maxCharsTokens = Math.ceil(maxChars / 4);
  let startIndex = 0;
  if (tokenBudget > 0) {
    const tokenLimit = tokenBudget * 2; // 2x budget
    let tokens = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      tokens += getMsgSize(messages[i]);
      if (tokens > tokenLimit) { startIndex = i + 1; break; }
    }
  }

  let changed = false;
  let truncatedCount = 0;
  const result: ModelMessage[] = [];

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    // Skip non-tool messages, and skip tool messages before startIndex unless they're oversized
    if (msg.role !== "tool" || !Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }
    if (idx < startIndex && getMsgSize(msg) <= maxCharsTokens) {
      result.push(msg);
      continue;
    }

    let partChanged = false;
    const newParts: ToolResultPart[] = [];

    for (const part of msg.content as ToolResultPart[]) {
      if (part.type === "tool-result" && part.output && "value" in part.output) {
        const { value } = part.output;
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        if (valueStr.length > maxChars) {
          const truncated = valueStr.slice(0, maxChars);
          const note = `\n\n[truncated from ${valueStr.length} to ${maxChars} chars — use memory search to find full content]`;
          newParts.push({
            ...part,
            output: { type: "text", value: truncated + note },
          });
          partChanged = true;
          truncatedCount++;
          continue;
        }
      }
      newParts.push(part);
    }

    if (partChanged) {
      result.push({ ...msg, content: newParts } as ModelMessage);
      changed = true;
    } else {
      result.push(msg);
    }
  }

  return { messages: changed ? result : messages, truncatedCount };
}

interface TrimOptions {
  messages: ModelMessage[];
  maxTokens: number;
  /** Snap trim boundary for cache stability. Requires segmentIndex + sessionId. */
  segmentIndex?: SegmentIndex | null;
  sessionId?: string;
}

const TRIM_SNAP = 20;

// Trim hysteresis watermarks (#295). The boundary is held until the window
// after it exceeds budget × HIGH, then jumps forward so the window shrinks to
// budget × LOW. Between jumps the message prefix is byte-identical across
// turns, so prompt caching gets near-100% hits instead of rewriting the full
// prefix every turn as the boundary creeps forward.
// HIGH is 1.0 so the configured budget is a true ceiling — the hysteresis band
// sits *below* the budget rather than overshooting it.
const TRIM_HIGH_WATERMARK = 1.0;
const TRIM_LOW_WATERMARK = 0.6;

// sessionId → held cut index (absolute index into the session messages array).
// In-memory only: after a restart the first turn pays one full cache write and
// re-establishes the boundary.
const heldTrimBoundaries = new Map<string, number>();

/** Test-only: reset hysteresis state between test cases. */
export function clearTrimBoundaries(): void {
  heldTrimBoundaries.clear();
}

/**
 * Trim oldest messages to fit within a token budget.
 *
 * The cut point is always a user message (turn boundary) to avoid orphaning
 * tool_result blocks. When segment data is available, the cut point is snapped
 * to a stable position (L0 segment edge or round-20 boundary).
 *
 * The cut point is sticky (hysteresis): once chosen it is reused verbatim on
 * subsequent calls until the resulting window exceeds the high watermark, at
 * which point it jumps forward to bring the window down to the low watermark.
 * This keeps the message window prefix byte-identical across many consecutive
 * turns — critical for prompt caching (#295).
 */
function trimToTokenBudget({ messages, maxTokens, segmentIndex, sessionId }: TrimOptions): { messages: ModelMessage[]; trimmedCount: number } {
  if (maxTokens <= 0) return { messages, trimmedCount: 0 };

  // Compute total using cached per-message sizes
  let total = 0;
  for (const msg of messages) {
    total += getMsgSize(msg);
  }
  if (total <= maxTokens) return { messages, trimmedCount: 0 };

  // Hysteresis hold: reuse the previous boundary while the window after it
  // still fits under the high watermark. Prefix stays stable → cache hits.
  const held = sessionId ? heldTrimBoundaries.get(sessionId) : undefined;
  if (held !== undefined && held > 0 && held < messages.length - 1 && messages[held]?.role === "user") {
    let windowTotal = 0;
    for (let i = held; i < messages.length; i++) {
      windowTotal += getMsgSize(messages[i]);
    }
    if (windowTotal <= maxTokens * TRIM_HIGH_WATERMARK) {
      return { messages: messages.slice(held), trimmedCount: held };
    }
  }

  // Jump: find a fresh cut point targeting the low watermark so the boundary
  // stays put for many turns before the next jump.
  const targetTokens = Math.max(1, Math.round(maxTokens * TRIM_LOW_WATERMARK));
  let cutTotal = total;
  let cutIndex = 0;
  while (cutIndex < messages.length - 1 && cutTotal > targetTokens) {
    cutTotal -= getMsgSize(messages[cutIndex]);
    cutIndex++;
  }

  // Walk forward to a user message (turn-safe boundary)
  while (cutIndex < messages.length - 1 && messages[cutIndex].role !== "user") {
    cutIndex++;
  }

  // Snap to a stable position for cache stability.
  // Find a snap target (L0 segment end or round number), then walk backward
  // to the nearest user message so we never cut inside a tool-use/tool-result pair.
  if (cutIndex > 0) {
    let snapTarget = cutIndex;

    // Try L0 segment end — aligns with summarized region boundary
    if (segmentIndex && sessionId) {
      const l0Ends = segmentIndex.getL0Boundaries(sessionId);
      const l0Snap = l0Ends.find(s => s >= cutIndex);
      if (l0Snap !== undefined && l0Snap < messages.length - 4) {
        snapTarget = l0Snap;
      }
    }

    // Fall back to round number if no L0 edge found
    if (snapTarget === cutIndex) {
      const roundSnap = Math.ceil(cutIndex / TRIM_SNAP) * TRIM_SNAP;
      if (roundSnap > cutIndex && roundSnap < messages.length - 4) {
        snapTarget = roundSnap;
      }
    }

    // Walk backward from snap target to nearest user message for turn safety
    if (snapTarget > cutIndex) {
      let safeSnap = snapTarget;
      while (safeSnap > cutIndex && messages[safeSnap]?.role !== "user") {
        safeSnap--;
      }
      if (safeSnap > cutIndex && messages[safeSnap]?.role === "user") {
        log.debug("context", `trim snap: ${cutIndex} → ${safeSnap} (target ${snapTarget}, +${safeSnap - cutIndex} msgs)`);
        cutIndex = safeSnap;
      }
    }
  }


  // Coverage guard: never trim messages the summarizer hasn't reached yet.
  // Summaries are built asynchronously after turns finish, so the freshest
  // messages may exist in neither the raw window nor any summary — trimming
  // past them makes the agent forget work it just completed (#311). Clamp the
  // boundary to the end of the last L0 segment; anything beyond stays raw
  // even if the window overshoots the budget for a turn.
  if (segmentIndex && sessionId) {
    const l0Ends = segmentIndex.getL0Boundaries(sessionId);
    const covered = l0Ends.length > 0 ? l0Ends[l0Ends.length - 1] : 0;
    if (cutIndex > covered) {
      // Walk backward to the nearest user message so the clamped boundary
      // stays turn-safe (never cuts inside a tool-call/tool-result pair).
      let clamped = covered;
      while (clamped > 0 && messages[clamped]?.role !== "user") {
        clamped--;
      }
      log("context", `trim clamped to summary coverage: ${cutIndex} → ${clamped} (last L0 end ${covered}); window may exceed budget until summaries catch up`);
      cutIndex = clamped;
    }
  }

  if (sessionId && cutIndex > 0) {
    const prev = heldTrimBoundaries.get(sessionId);
    if (prev !== cutIndex) {
      log("context", `trim boundary jump: ${prev ?? "none"} → ${cutIndex} (${messages.length - cutIndex} msgs in window, budget ${maxTokens})`);
    }
    heldTrimBoundaries.set(sessionId, cutIndex);
  }

  return { messages: messages.slice(cutIndex), trimmedCount: cutIndex };
}

export interface ContextSegment {
  id: number;
  level: number;
  msg_start: number;
  msg_end: number;
}

export interface SessionStats {
  totalMessages: number;
  estimatedTokens: number;
  windowTokens: number;
  windowMessages: number;
  truncatedCount: number;
  summaryTokens: number;
  summaryLevelCounts: Record<number, number>;
  /** Segments selected for context injection */
  summarySegments: ContextSegment[];
  systemPromptTokens?: number;
}

export interface PrepareContextOptions {
  messages: ModelMessage[];
  config: KernConfig;
  sessionId?: string;
  segmentIndex?: SegmentIndex | null;
}

export interface PreparedContext {
  systemAdditions: string[];
  messages: ModelMessage[];
  stats: SessionStats;
}

// Unified pipeline: truncate → trim → inject summary → stats.
export function prepareContext({ messages, config, sessionId, segmentIndex }: PrepareContextOptions): PreparedContext {
  const totalTokens = estimateTokens(messages);
  const { messages: truncated, truncatedCount } = truncateLargeToolResults(messages, config.maxToolResultChars, config.maxContextTokens);
  const rawBudget = segmentIndex && config.summaryBudget > 0
    ? Math.round(config.maxContextTokens * (1 - config.summaryBudget))
    : config.maxContextTokens;
  let { messages: window, trimmedCount } = trimToTokenBudget({
    messages: truncated,
    maxTokens: rawBudget,
    segmentIndex,
    sessionId,
  });

  // Inject compressed summary at trim boundary
  let summaryTokens = 0;
  let summaryLevelCounts: Record<number, number> = {};
  let summarySegments: ContextSegment[] = [];
  let summarySystemAddition = "";
  const finalMessages = window;
  if (trimmedCount > 0 && segmentIndex && sessionId && config.summaryBudget > 0) {
    const budgetTokens = Math.round(config.maxContextTokens * config.summaryBudget);
    const history = segmentIndex.composeHistory(sessionId, trimmedCount, budgetTokens);
    if (history) {
      summaryTokens = history.tokens;
      summaryLevelCounts = history.levelCounts;
      summarySegments = history.segments.map(s => ({ id: s.id, level: s.level, msg_start: s.msg_start, msg_end: s.msg_end }));
      summarySystemAddition = `<conversation_summary>\nCompressed conversation summary of trimmed earlier messages (oldest → newest). Use memory search to load full messages by range.\n\n${history.text}\n</conversation_summary>`;
    }
  }

  // Only count truncations that survived trimming
  // FRAGILE: matches suffix appended by truncateLargeToolResults — keep in sync
  const truncationSuffix = "use memory search to find full content]";
  const trimmedTruncated = truncatedCount > 0
    ? finalMessages.reduce((n, msg) => {
        if (msg.role !== "tool" || !Array.isArray(msg.content)) return n;
        return n + (msg.content as ToolResultPart[]).filter(p =>
          p.type === "tool-result" && p.output?.type === "text" && p.output.value.endsWith(truncationSuffix)
        ).length;
      }, 0)
    : 0;
  return {
    systemAdditions: summarySystemAddition ? [summarySystemAddition] : [],
    messages: finalMessages,
    stats: {
      totalMessages: messages.length,
      estimatedTokens: totalTokens,
      windowTokens: estimateTokens(finalMessages),
      windowMessages: finalMessages.length,
      truncatedCount: trimmedTruncated,
      summaryTokens,
      summaryLevelCounts,
      summarySegments,
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt caching — Anthropic cache breakpoints and system message wrapping
// ---------------------------------------------------------------------------

const CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  openrouter: { cacheControl: { type: "ephemeral" } },
} as const;

const BP_SNAP_INTERVAL = 20;

/**
 * Check if a model config supports Anthropic-style explicit prompt caching.
 */
export function supportsPromptCaching(config: KernConfig): boolean {
  const { provider, model } = config;
  if (provider === "anthropic") return true;
  if (provider === "openrouter" && model.startsWith("anthropic/")) return true;
  return false;
}

/**
 * Wrap a system prompt string with cache control for Anthropic models.
 * Returns a SystemModelMessage with providerOptions, or the plain string
 * for providers that don't need explicit caching.
 */
export function buildSystemMessage(systemPrompt: string, config: KernConfig): string | SystemModelMessage {
  if (!supportsPromptCaching(config)) return systemPrompt;
  return {
    role: "system" as const,
    content: systemPrompt,
    providerOptions: { ...CACHE_CONTROL },
  };
}

/**
 * Add cache breakpoints to conversation messages for Anthropic models.
 *
 * Uses 2 of Anthropic's 4 allowed breakpoints (BP1 is on the system message):
 *   BP2 "stable"  — snapped to every BP_SNAP_INTERVAL messages, stays fixed ~20 turns
 *   BP3 "turn"    — last user message, stable across all tool-call steps in a turn
 *
 * Between turns: BP2 keeps most of the conversation prefix cached.
 * Mid-turn: BP3 means tool-call steps 1+ get ~99% cache hits.
 */
export function addCacheBreakpoints(messages: ModelMessage[], config: KernConfig): ModelMessage[] {
  if (!supportsPromptCaching(config) || messages.length < 4) return messages;

  // BP3: last user message
  let turnBpIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") { turnBpIdx = i; break; }
  }
  if (turnBpIdx < 0) return messages;

  // BP2: snap to stable interval before the turn breakpoint
  const stableBpIdx = Math.floor(turnBpIdx / BP_SNAP_INTERVAL) * BP_SNAP_INTERVAL;
  const useStableBp = stableBpIdx >= 0 && stableBpIdx < turnBpIdx - 4;

  if (useStableBp) {
    log("context", `cache breakpoints: stable=${stableBpIdx} turn=${turnBpIdx} (${messages.length} msgs)`);
  } else {
    log("context", `cache breakpoint: turn=${turnBpIdx} (${messages.length} msgs)`);
  }

  return messages.map((msg, i) => {
    if (i === turnBpIdx || (useStableBp && i === stableBpIdx)) {
      return {
        ...msg,
        providerOptions: { ...(msg as any).providerOptions, ...CACHE_CONTROL },
      };
    }
    return msg;
  });
}

