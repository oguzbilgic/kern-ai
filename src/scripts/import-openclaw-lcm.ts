// Import OpenClaw sessions from a Lossless Context Memory (LCM) SQLite DB.
//
// Tested with:
//   - lossless-claw v0.9.1 (schema with message_parts + tool_call_id columns)
//   - kern v0.30.0 (JSONL session format)
//
// Older LCM DBs predating message_parts fall through to flat messages.content.
// DBs predating the backfillToolCallColumns migration will error on the
// tool_call_id column lookup.

import Database from "better-sqlite3";
import { join } from "path";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";

// ---------------------------------------------------------------------------
// OpenClaw runtime-injection normalizer.
//
// OpenClaw persists fully-assembled prompts into LCM, so user messages are
// prefixed with runtime-injected blocks: channel/sender metadata, heartbeats,
// System: model-switch / exec notifications, queued-message markers, etc.
// Kern uses a much leaner `[via <channel>, <chatId>, user: <name>, time: <iso>]`
// style prefix, added at route time and NOT persisted.
//
// This module rewrites OpenClaw preambles into kern-native equivalents so the
// imported session looks like it was captured by kern in the first place.
// ---------------------------------------------------------------------------

interface Preamble {
  senderId?: string;
  senderName?: string;
  isoTime?: string;
}

function toIso(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();

  // "Mon 2026-04-20 23:37 UTC"  (weekday + min precision)
  let m = s.match(/^\w{3}\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*UTC$/);
  if (m) return `${m[1]}T${m[2]}:00Z`;

  // "2026-04-20 23:37 UTC"  (no weekday, min precision)
  m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*UTC$/);
  if (m) return `${m[1]}T${m[2]}:00Z`;

  // "2026-04-20 23:37:15 UTC"  (with seconds)
  m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*UTC$/);
  if (m) return `${m[1]}T${m[2]}Z`;

  return undefined;
}

function inferChannel(senderId: string | undefined): {
  channel: string;
  chatId?: string;
} {
  if (!senderId) return { channel: "web" };
  if (/^\d{6,15}$/.test(senderId)) return { channel: "telegram", chatId: `tg:${senderId}` };
  if (/^U[A-Z0-9]{8,}$/.test(senderId)) return { channel: "slack", chatId: `slack:${senderId}` };
  if (/^@[^:]+:[^:]+$/.test(senderId)) return { channel: "matrix", chatId: senderId };
  return { channel: "web" };
}

function buildKernPrefix(p: Preamble): string {
  const { channel, chatId } = inferChannel(p.senderId);
  const parts = [`via ${channel}`];
  if (chatId) parts.push(chatId);
  if (p.senderName) parts.push(`user: ${p.senderName}`);
  if (p.isoTime) parts.push(`time: ${p.isoTime}`);
  return `[${parts.join(", ")}]`;
}

// Match the Conversation info / Sender preamble pair. Must appear at the head
// of the remaining text. Captures the two JSON blobs.
const PREAMBLE_RE =
  /^Conversation info \(untrusted metadata\):\s*\n```json\s*\n([\s\S]+?)\n```\s*\n+Sender \(untrusted metadata\):\s*\n```json\s*\n([\s\S]+?)\n```\s*\n*/;

function parsePreamble(text: string): { preamble: Preamble; rest: string } | null {
  const m = text.match(PREAMBLE_RE);
  if (!m) return null;
  let conv: any = {};
  let sender: any = {};
  try {
    conv = JSON.parse(m[1]);
  } catch {
    // ignore — parser handles missing fields
  }
  try {
    sender = JSON.parse(m[2]);
  } catch {
    // ignore
  }
  const p: Preamble = {
    senderId: conv.sender_id ?? sender.id,
    senderName: conv.sender ?? sender.name,
    isoTime: toIso(conv.timestamp),
  };
  return { preamble: p, rest: text.slice(m[0].length) };
}

// System: [ts UTC] <rest>\n\n  or  System (untrusted): [ts UTC] <rest>\n\n
// `<rest>` may wrap across many lines before the blank-line terminator.
const SYSTEM_RE =
  /^System(?: \(untrusted\))?:\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*UTC\]\s*([\s\S]*?)(?:\n\n|$)/;

interface SystemEvent {
  kind: "model-switch" | "exec-completed" | "exec-failed" | "system";
  isoTime?: string;
  jobId?: string;
  body: string; // residual body for exec events (after the `::` separator)
}

function parseSystem(text: string): { event: SystemEvent; rest: string } | null {
  const m = text.match(SYSTEM_RE);
  if (!m) return null;
  const isoTime = toIso(`${m[1]} UTC`);
  const rest = text.slice(m[0].length);
  const body = m[2].trim();

  let execMatch = body.match(/^Exec completed\s*\(([^,)]+)[^)]*\)\s*::\s*([\s\S]*)$/);
  if (execMatch) {
    return { event: { kind: "exec-completed", isoTime, jobId: execMatch[1].trim(), body: execMatch[2].trim() }, rest };
  }
  execMatch = body.match(/^Exec failed\s*\(([^,)]+)[^)]*\)\s*::\s*([\s\S]*)$/);
  if (execMatch) {
    return { event: { kind: "exec-failed", isoTime, jobId: execMatch[1].trim(), body: execMatch[2].trim() }, rest };
  }
  // Also handle the short form "Exec failed (faint-ba, signal SIGKILL) :: Updating OpenClaw..."
  // which is already caught above, and bare "Exec failed (id, code N)" with no `::`.
  execMatch = body.match(/^Exec (completed|failed)\s*\(([^,)]+)[^)]*\)\.?\s*$/);
  if (execMatch) {
    return {
      event: {
        kind: execMatch[1] === "completed" ? "exec-completed" : "exec-failed",
        isoTime,
        jobId: execMatch[2].trim(),
        body: "",
      },
      rest,
    };
  }
  if (/^Model switched to /.test(body)) {
    return { event: { kind: "model-switch", isoTime, body }, rest };
  }
  return { event: { kind: "system", isoTime, body }, rest };
}

function systemPrefix(e: SystemEvent): string {
  const tparts: string[] = [];
  if (e.jobId) tparts.push(e.jobId);
  if (e.isoTime) tparts.push(`time: ${e.isoTime}`);
  const tail = tparts.length ? `, ${tparts.join(", ")}` : "";
  switch (e.kind) {
    case "exec-completed":
      return `[exec completed${tail}]`;
    case "exec-failed":
      return `[exec failed${tail}]`;
    case "system":
    case "model-switch":
      return `[system${e.isoTime ? `, time: ${e.isoTime}` : ""}]`;
  }
}

const NOTE_ABORTED_RE =
  /^Note: The previous agent run was aborted by the user\. Resume carefully or ask for clarification\.\s*\n+/;

const MEDIA_ATTACHED_RE = /^(\[media attached:[^\]]+\])\s*\n+/;

const QUEUED_HEAD_RE =
  /^\[Queued messages while agent was busy\]\s*\n+/;

// Splits the queued-block body on "---\nQueued #N\n" (optionally with trailing
// "(from X)" annotation).
const QUEUED_ITEM_SPLIT_RE = /(?:^|\n)---\s*\nQueued\s*#\d+(?:\s*\([^)]*\))?\s*\n/g;

// OpenClaw's inline "how to send media back" guidance that sits between a
// `[media attached: ...]` prefix and the real preamble. Spans one paragraph.
const MEDIA_GUIDANCE_RE =
  /^To send an image back, prefer the message tool[\s\S]+?Keep caption in the text body\.\s*\n+/;

// <media:image> / <media:audio> wrapper tags that appear after preambles in
// media-bearing turns. Drop the tag itself; whatever follows (transcripts,
// binary payloads) is left intact.
const MEDIA_TAG_RE = /<media:[a-z]+>\s*\n?/g;

// "Read HEARTBEAT.md ..." prompt. Multi-line body, always ends with
// "<human date> — <HH:MM AM/PM> (UTC) / <YYYY-MM-DD HH:MM UTC>"
const HEARTBEAT_RE = /^Read HEARTBEAT\.md\b[\s\S]*?\/\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*UTC)\s*$/;

export interface NormalizeResult {
  /** Flattened, kern-style user content. Null = drop the message entirely. */
  content: string | null;
  /** How the message was classified, for stats. */
  kind: "heartbeat" | "preamble" | "system-exec" | "system-other" | "plain" | "empty";
}

/**
 * Normalize a single user-role text blob pulled from LCM into kern's native
 * shape. Strips OpenClaw runtime injections; rewrites channel/sender preamble
 * into the compact bracketed prefix kern uses elsewhere.
 */
export function normalizeUserContent(raw: string): NormalizeResult {
  if (!raw || !raw.trim()) return { content: null, kind: "empty" };

  // Heartbeats are self-contained, never mixed with other prefixes.
  const hb = raw.match(HEARTBEAT_RE);
  if (hb) {
    const iso = toIso(hb[1]);
    return {
      content: iso ? `[heartbeat, time: ${iso}]` : `[heartbeat]`,
      kind: "heartbeat",
    };
  }

  let text = raw;
  let systemEvent: SystemEvent | undefined;
  let aborted = false;
  let mediaPrefix: string | undefined;
  let queued = false;

  // Peel outer layers at the head. Each step only matches its exact shape and
  // no-ops otherwise. Order matters: system/aborted/media/queued can all co-occur
  // before the first preamble.
  for (let i = 0; i < 8; i++) {
    const before = text;

    if (!systemEvent) {
      const sys = parseSystem(text);
      if (sys) {
        if (sys.event.kind === "model-switch") {
          text = sys.rest;
          continue;
        }
        systemEvent = sys.event;
        text = sys.rest;
        continue;
      }
    }

    if (!aborted && NOTE_ABORTED_RE.test(text)) {
      text = text.replace(NOTE_ABORTED_RE, "");
      aborted = true;
      continue;
    }

    if (!mediaPrefix) {
      const mm = text.match(MEDIA_ATTACHED_RE);
      if (mm) {
        mediaPrefix = mm[1];
        text = text.slice(mm[0].length);
        continue;
      }
    }

    // Drop OpenClaw's inline "To send an image back..." guidance block.
    if (MEDIA_GUIDANCE_RE.test(text)) {
      text = text.replace(MEDIA_GUIDANCE_RE, "");
      continue;
    }

    if (!queued && QUEUED_HEAD_RE.test(text)) {
      text = text.replace(QUEUED_HEAD_RE, "");
      queued = true;
      continue;
    }

    if (text === before) break;
  }

  // After stripping system/exec prefixes, the remainder can itself be a full
  // heartbeat prompt (exec ran, then heartbeat was injected on top).
  const hb2 = text.match(HEARTBEAT_RE);
  if (hb2) {
    const iso = toIso(hb2[1]);
    const hbTag = iso ? `[heartbeat, time: ${iso}]` : `[heartbeat]`;
    const systemHead = systemEvent ? systemPrefix(systemEvent) + " " : "";
    return { content: (systemHead + hbTag).trim(), kind: "heartbeat" };
  }

  // Queued blocks contain multiple distinct user inputs, each with its own
  // preamble. Split on the `---\nQueued #N\n` markers and process each item
  // independently, then join.
  const items: string[] = queued ? text.split(QUEUED_ITEM_SPLIT_RE) : [text];

  const preambles: Preamble[] = [];
  const processedItems: string[] = [];

  for (const rawItem of items) {
    let item = rawItem;
    // Each queued item may also have its own "To send an image back" block
    // and `[media attached:]` prefix; peel them.
    if (MEDIA_GUIDANCE_RE.test(item)) item = item.replace(MEDIA_GUIDANCE_RE, "");
    const mm = item.match(MEDIA_ATTACHED_RE);
    let itemMediaPrefix: string | undefined;
    if (mm) {
      itemMediaPrefix = mm[1];
      item = item.slice(mm[0].length);
    }
    const parsed = parsePreamble(item);
    if (parsed) {
      preambles.push(parsed.preamble);
      item = parsed.rest;
    }
    // Drop <media:tag> wrappers but keep surrounding content.
    item = item.replace(MEDIA_TAG_RE, "").trim();
    if (itemMediaPrefix && item) {
      item = `${itemMediaPrefix}\n\n${item}`;
    } else if (itemMediaPrefix) {
      item = itemMediaPrefix;
    }
    if (item) processedItems.push(item);
  }

  const body = processedItems.join("\n\n").trim();

  const prefixPieces: string[] = [];
  if (systemEvent) prefixPieces.push(systemPrefix(systemEvent));
  if (preambles[0]) prefixPieces.push(buildKernPrefix(preambles[0]));
  const prefix = prefixPieces.join(" ");

  const tags: string[] = [];
  if (aborted) tags.push("[run aborted]");
  if (queued) tags.push("[queued]");

  const head = [prefix, ...tags].filter(Boolean).join(" ");
  const bodyWithMedia = mediaPrefix && body ? `${mediaPrefix}\n\n${body}` : mediaPrefix ?? body;

  let combined: string;
  if (head && bodyWithMedia) combined = `${head} ${bodyWithMedia}`;
  else combined = head || bodyWithMedia;

  combined = combined.trim();
  if (!combined) return { content: null, kind: "empty" };

  let kind: NormalizeResult["kind"];
  if (systemEvent && (systemEvent.kind === "exec-completed" || systemEvent.kind === "exec-failed")) {
    kind = "system-exec";
  } else if (systemEvent) {
    kind = "system-other";
  } else if (preambles.length > 0) {
    kind = "preamble";
  } else {
    kind = "plain";
  }
  return { content: combined, kind };
}

interface LcmConversation {
  conversation_id: number;
  session_key: string | null;
  session_id: string | null;
  title: string | null;
  msgCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

interface LcmRow {
  seq: number;
  role: string;
  message_content: string | null;
  ordinal: number | null;
  part_type: string | null;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  tool_status: string | null;
  is_ignored: number | null;
  is_synthetic: number | null;
}

function openLcmDb(path: string): Database.Database {
  if (!existsSync(path)) {
    console.error(`LCM database not found: ${path}`);
    process.exit(1);
  }
  const db = new Database(path, { readonly: true });
  try {
    db.prepare("SELECT 1 FROM message_parts LIMIT 1").get();
  } catch {
    console.error(`Not a valid OpenClaw LCM database: ${path}`);
    console.error("(missing message_parts table — wrong file?)");
    db.close();
    process.exit(1);
  }
  return db;
}

function listConversations(db: Database.Database): LcmConversation[] {
  const rows = db.prepare(`
    SELECT
      c.conversation_id,
      c.session_key,
      c.session_id,
      c.title,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.conversation_id) AS msgCount,
      (SELECT MIN(created_at) FROM messages WHERE conversation_id = c.conversation_id) AS firstSeen,
      (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.conversation_id) AS lastSeen
    FROM conversations c
    ORDER BY msgCount DESC
  `).all() as LcmConversation[];
  return rows;
}

function convLabel(c: LcmConversation): string {
  return c.session_key ?? c.session_id ?? c.title ?? `conv-${c.conversation_id}`;
}

function printConversationTable(convs: LcmConversation[]): void {
  if (convs.length === 0) {
    console.log("  (no conversations)");
    return;
  }
  const idW = Math.max(2, ...convs.map((c) => String(c.conversation_id).length));
  const keyW = Math.max(3, ...convs.map((c) => convLabel(c).length));
  const countW = Math.max(5, ...convs.map((c) => String(c.msgCount).length));
  console.log(
    "  " +
      "ID".padStart(idW) +
      "  " +
      "KEY".padEnd(keyW) +
      "  " +
      "MSGS".padStart(countW) +
      "  RANGE"
  );
  for (const c of convs) {
    const range =
      c.firstSeen && c.lastSeen
        ? `${c.firstSeen.slice(0, 10)} .. ${c.lastSeen.slice(0, 10)}`
        : "-";
    console.log(
      "  " +
        String(c.conversation_id).padStart(idW) +
        "  " +
        convLabel(c).padEnd(keyW) +
        "  " +
        String(c.msgCount).padStart(countW) +
        "  " +
        range
    );
  }
}

function pickDefaultConversation(convs: LcmConversation[]): LcmConversation | null {
  // Prefer *:main:main keys (primary agent sessions), ignore sub-agent spawns.
  const mains = convs.filter((c) => {
    const k = c.session_key ?? "";
    return /:main:main$/.test(k) || /^agent:main/.test(k);
  });
  if (mains.length === 1) return mains[0];
  if (mains.length > 1) {
    // Pick the one with the most messages.
    return mains.reduce((a, b) => (a.msgCount >= b.msgCount ? a : b));
  }
  // Fall back to overall largest if exactly one conversation has most messages and others are small.
  if (convs.length === 1) return convs[0];
  const sorted = [...convs].sort((a, b) => b.msgCount - a.msgCount);
  if (sorted.length >= 2 && sorted[0].msgCount >= sorted[1].msgCount * 10) return sorted[0];
  return null;
}

interface ConvertResult {
  messages: any[];
  stats: {
    textParts: number;
    toolCalls: number;
    toolResults: number;
    fallbackContent: number;
    droppedReasoning: number;
    droppedCompaction: number;
    droppedSystem: number;
    droppedSynthetic: number;
    droppedIgnored: number;
    droppedOrphans: number;
    droppedEmptyUser: number;
    normalized: { heartbeat: number; preamble: number; systemExec: number; systemOther: number };
    droppedOther: { [partType: string]: number };
  };
}

function convertConversation(db: Database.Database, conversationId: number): ConvertResult {
  const rows = db.prepare(`
    SELECT
      m.seq            AS seq,
      m.role           AS role,
      m.content        AS message_content,
      mp.ordinal       AS ordinal,
      mp.part_type     AS part_type,
      mp.text_content  AS text_content,
      mp.tool_call_id  AS tool_call_id,
      mp.tool_name     AS tool_name,
      mp.tool_input    AS tool_input,
      mp.tool_output   AS tool_output,
      mp.tool_status   AS tool_status,
      mp.is_ignored    AS is_ignored,
      mp.is_synthetic  AS is_synthetic
    FROM messages m
    LEFT JOIN message_parts mp ON mp.message_id = m.message_id
    WHERE m.conversation_id = ?
    ORDER BY m.seq ASC, mp.ordinal ASC
  `).all(conversationId) as LcmRow[];

  const stats: ConvertResult["stats"] = {
    textParts: 0,
    toolCalls: 0,
    toolResults: 0,
    fallbackContent: 0,
    droppedReasoning: 0,
    droppedCompaction: 0,
    droppedSystem: 0,
    droppedSynthetic: 0,
    droppedIgnored: 0,
    droppedOrphans: 0,
    droppedEmptyUser: 0,
    normalized: { heartbeat: 0, preamble: 0, systemExec: 0, systemOther: 0 },
    droppedOther: {},
  };

  // Group rows by seq (one message per seq). `message_content` comes from the
  // messages table and is the flat-text fallback when a message has no parts
  // (pre-parts-table era — first ~month of Lyra's history).
  type Grouped = { seq: number; role: string; content: string | null; parts: LcmRow[] };
  const groups = new Map<number, Grouped>();
  for (const r of rows) {
    let g = groups.get(r.seq);
    if (!g) {
      g = { seq: r.seq, role: r.role, content: r.message_content, parts: [] };
      groups.set(r.seq, g);
    }
    if (r.part_type) g.parts.push(r);
  }

  const kernMessages: any[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.seq - b.seq)) {
    if (g.role === "system") {
      stats.droppedSystem++;
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];

    // Fallback: no parts → use flat message.content as a single text block.
    // (Older messages before message_parts existed.)
    if (g.parts.length === 0) {
      if (g.content && g.content.trim()) {
        textParts.push(g.content);
        stats.fallbackContent++;
      }
    }

    for (const p of g.parts) {
      if (p.is_ignored) {
        stats.droppedIgnored++;
        continue;
      }
      if (p.is_synthetic) {
        stats.droppedSynthetic++;
        continue;
      }

      const t = p.part_type;
      if (t === "text") {
        // Tool-role + text part with tool_call_id = tool result (OpenClaw stores
        // results this way, not as part_type='tool').
        if (g.role === "tool" && p.tool_call_id) {
          toolResults.push({
            type: "tool-result",
            toolCallId: p.tool_call_id,
            toolName: p.tool_name || "unknown",
            output: { type: "text", value: p.text_content ?? "" },
          });
          stats.toolResults++;
        } else if (p.text_content && p.text_content.trim()) {
          textParts.push(p.text_content);
          stats.textParts++;
        }
      } else if (t === "reasoning") {
        stats.droppedReasoning++;
      } else if (t === "compaction") {
        stats.droppedCompaction++;
      } else if (t === "tool") {
        if (g.role === "assistant") {
          // Outgoing tool call.
          if (p.tool_call_id && p.tool_name) {
            let input: any = {};
            if (p.tool_input) {
              try {
                input = JSON.parse(p.tool_input);
              } catch {
                input = { raw: p.tool_input };
              }
            }
            toolCalls.push({
              type: "tool-call",
              toolCallId: p.tool_call_id,
              toolName: p.tool_name,
              input,
            });
            stats.toolCalls++;
          }
        } else if (g.role === "tool") {
          // Tool result.
          if (p.tool_call_id) {
            toolResults.push({
              type: "tool-result",
              toolCallId: p.tool_call_id,
              toolName: p.tool_name || "unknown",
              output: { type: "text", value: p.tool_output ?? p.text_content ?? "" },
            });
            stats.toolResults++;
          } else if (p.text_content) {
            // Legacy / synthetic tool output without an ID — skip (would be orphan).
            stats.droppedOrphans++;
          }
        }
      } else if (t) {
        stats.droppedOther[t] = (stats.droppedOther[t] ?? 0) + 1;
      }
    }

    if (g.role === "user") {
      const raw = textParts.join("\n").trim();
      if (!raw) continue;
      const norm = normalizeUserContent(raw);
      if (norm.kind === "heartbeat") stats.normalized.heartbeat++;
      else if (norm.kind === "preamble") stats.normalized.preamble++;
      else if (norm.kind === "system-exec") stats.normalized.systemExec++;
      else if (norm.kind === "system-other") stats.normalized.systemOther++;
      if (!norm.content) {
        stats.droppedEmptyUser++;
        continue;
      }
      kernMessages.push({ role: "user", content: norm.content });
    } else if (g.role === "assistant") {
      if (textParts.length > 0 && toolCalls.length > 0) {
        const content: any[] = [];
        for (const t of textParts) content.push({ type: "text", text: t });
        content.push(...toolCalls);
        kernMessages.push({ role: "assistant", content });
      } else if (toolCalls.length > 0) {
        kernMessages.push({ role: "assistant", content: toolCalls });
      } else if (textParts.length > 0) {
        kernMessages.push({ role: "assistant", content: textParts.join("\n") });
      }
      // Empty assistant messages (no text, no tools) are dropped silently.
    } else if (g.role === "tool") {
      if (toolResults.length > 0) {
        kernMessages.push({ role: "tool", content: toolResults });
      } else if (textParts.length > 0) {
        // Tool row with fallback content (no parts). We have no tool_call_id to
        // pair it with an assistant tool-call, so emit it as an assistant text
        // block labeled as a tool output. Preserves content without orphaning.
        kernMessages.push({
          role: "assistant",
          content: `[tool output]\n${textParts.join("\n")}`,
        });
      }
    }
  }

  // Post-process: drop orphan tool-calls (assistant with tool-call not followed by tool)
  // and dedup adjacent user messages. Mirrors src/import.ts cleaned() logic.
  const cleaned: any[] = [];
  for (let i = 0; i < kernMessages.length; i++) {
    const m = kernMessages[i];
    const next = kernMessages[i + 1];

    if (m.role === "assistant" && Array.isArray(m.content)) {
      const hasToolCall = m.content.some((p: any) => p.type === "tool-call");
      if (hasToolCall && (!next || next.role !== "tool")) {
        stats.droppedOrphans++;
        continue;
      }
    }

    if (m.role === "tool") {
      // Accept if any of the last K messages in `cleaned` was an assistant
      // with tool-calls. Multiple tool rows can follow one assistant turn
      // (multi-tool-call in a single message), so a strict "prev" check is
      // too tight.
      let ok = false;
      for (let j = cleaned.length - 1; j >= Math.max(0, cleaned.length - 6); j--) {
        const q = cleaned[j];
        if (q.role === "assistant" && Array.isArray(q.content) && q.content.some((p: any) => p.type === "tool-call")) {
          ok = true;
          break;
        }
        if (q.role === "user") break; // user message resets the turn
      }
      if (!ok) {
        stats.droppedOrphans++;
        continue;
      }
    }

    if (m.role === "user" && next?.role === "user") {
      // Collapse duplicate adjacent user messages (rare but seen in LCM after compactions).
      stats.droppedOrphans++;
      continue;
    }

    cleaned.push(m);
  }

  return { messages: cleaned, stats };
}

function getFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

export async function importOpenClawLcm(args: string[]): Promise<void> {
  const dbPath = args.find((a) => !a.startsWith("--"));
  if (!dbPath) {
    console.error("Usage: kern import openclaw-lcm <lcm.db> [--conversation <id>] [--list]");
    process.exit(1);
  }

  const db = openLcmDb(dbPath);
  const convs = listConversations(db);

  // --- --list short-circuit ---
  if (hasFlag(args, "list")) {
    console.log(`  LCM database: ${dbPath}`);
    console.log(`  Conversations: ${convs.length}`);
    console.log("");
    printConversationTable(convs);
    console.log("");
    db.close();
    process.exit(0);
  }

  if (convs.length === 0) {
    console.error("No conversations found in LCM database.");
    db.close();
    process.exit(1);
  }

  // --- Pick conversation ---
  let conversation: LcmConversation | null = null;
  const convArg = getFlag(args, "conversation");

  if (convArg) {
    const wantId = Number(convArg);
    const match = Number.isFinite(wantId)
      ? convs.find((c) => c.conversation_id === wantId)
      : convs.find((c) => c.session_key === convArg || c.session_id === convArg);
    if (!match) {
      console.error(`Conversation not found: ${convArg}`);
      console.error("Use --list to see available conversations.");
      db.close();
      process.exit(1);
    }
    conversation = match;
  } else {
    conversation = pickDefaultConversation(convs);
    if (!conversation) {
      console.error("Multiple conversations found and no clear main. Pass --conversation <id> (or --list to see them).");
      db.close();
      process.exit(1);
    }
  }
  console.log(`  Conversation: ${convLabel(conversation)} (id=${conversation.conversation_id}, ${conversation.msgCount} msgs)`);

  // --- Convert ---
  const { messages: kernMessages, stats } = convertConversation(db, conversation.conversation_id);
  db.close();

  console.log("");
  console.log(`  Text parts:       ${stats.textParts}`);
  console.log(`  Tool calls:       ${stats.toolCalls}`);
  console.log(`  Tool results:     ${stats.toolResults}`);
  if (stats.fallbackContent) {
    console.log(`  Flat fallback:    ${stats.fallbackContent}  (pre-parts-table messages)`);
  }
  console.log(`  Normalized users:`);
  console.log(`    preamble:       ${stats.normalized.preamble}`);
  console.log(`    heartbeat:      ${stats.normalized.heartbeat}`);
  console.log(`    system exec:    ${stats.normalized.systemExec}`);
  console.log(`    system other:   ${stats.normalized.systemOther}`);
  console.log(`  Dropped:`);
  console.log(`    reasoning:      ${stats.droppedReasoning}`);
  console.log(`    compaction:     ${stats.droppedCompaction}`);
  console.log(`    system rows:    ${stats.droppedSystem}`);
  console.log(`    synthetic:      ${stats.droppedSynthetic}`);
  console.log(`    ignored:        ${stats.droppedIgnored}`);
  console.log(`    orphans:        ${stats.droppedOrphans}`);
  console.log(`    empty users:    ${stats.droppedEmptyUser}  (preamble-only, etc.)`);
  for (const [t, n] of Object.entries(stats.droppedOther)) {
    console.log(`    ${t.padEnd(14)}  ${n}`);
  }
  console.log(`  Messages:         ${kernMessages.length}`);

  // --- Write to cwd ---
  const sessionUuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const jsonlPath = join(process.cwd(), `${sessionUuid}.jsonl`);

  const meta = JSON.stringify({
    id: sessionUuid,
    createdAt: now,
    updatedAt: now,
    importedFrom: "openclaw-lcm",
    originalConversationId: conversation.conversation_id,
    originalConversationKey: conversation.session_key ?? conversation.session_id ?? null,
    sourceDb: dbPath,
  });

  const lines = [meta, ...kernMessages.map((m: any) => JSON.stringify(m))];
  await writeFile(jsonlPath, lines.join("\n") + "\n");

  console.log("");
  console.log(`✓ Imported ${kernMessages.length} messages → ${jsonlPath}`);
  console.log("");
  console.log(`  Move into an agent's sessions dir to use it:`);
  console.log(`    mv ${jsonlPath} <agent>/.kern/sessions/`);
  console.log("");
}
