import TurndownService from "turndown";

/**
 * Format a Date as ISO8601 with the wall-clock time in a target IANA zone and
 * its UTC offset. Unlike `toISOString()` (always UTC `Z`), this produces strings
 * the model can read at a glance like "2026-04-20T20:08:45-07:00" while
 * remaining machine-parseable by `new Date()` and regex-friendly.
 *
 * If `timeZone` is omitted or unresolvable, falls back to UTC.
 *
 * Used for the envelope `time:` field the model reads. Storage elsewhere
 * (logs, recall, session metadata) stays UTC.
 */
export function formatLocalISO(d: Date = new Date(), timeZone?: string): string {
  const tz = timeZone || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    // Intl renders midnight as "24" in hour12:false — normalize.
    let hour = get("hour");
    if (hour === "24") hour = "00";
    const minute = get("minute");
    const second = get("second");
    const offRaw = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(d).find((p) => p.type === "timeZoneName")!.value;
    // longOffset yields "GMT-07:00" or bare "GMT" for UTC.
    const offset = offRaw === "GMT" ? "+00:00" : offRaw.replace("GMT", "");
    return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
  } catch {
    return d.toISOString();
  }
}

/**
 * Resolve the host's IANA timezone at runtime. Returns `"UTC"` if the
 * environment cannot resolve a named zone.
 */
export function resolveHostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}


/**
 * True if an assistant reply should be suppressed from outbound interfaces.
 *
 * Matches:
 *   - empty / whitespace-only text
 *   - the sentinel `(no text response)` placeholder
 *   - any reply whose trimmed text **ends with** `NO_REPLY`
 *
 * The trailing-match covers the common model pattern of writing explanatory
 * prose then ending with `NO_REPLY` to signal "don't speak up." Inline mentions
 * of NO_REPLY elsewhere in the message (backticks, prose, bullet points) still
 * pass through, so agents can legitimately discuss the feature.
 *
 * Suppression is outbound-only — session JSONL keeps the full assistant text
 * for context and trace.
 */
export function isNoReply(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (t === "(no text response)") return true;
  return t.endsWith("NO_REPLY");
}

/**
 * Extract plain text from message content (string or array).
 * Used for embeddings, search, summaries — strips media parts.
 */
export function extractText(content: string | any[] | any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
  }
  return String(content ?? "");
}

/**
 * Max characters sent to an embedding model in a single value.
 *
 * Embedding APIs reject inputs over their token limit (8192 for
 * text-embedding-3-small and nomic-embed-text) with HTTP 400 — and one
 * oversized value fails the *whole* embedMany batch. 8000 chars is safe for
 * *any* script: worst-case tokenization is ~1 char/token (CJK), so this can't
 * exceed 8192 tokens. Typical text runs 2-4 chars/token, well under.
 */
export const EMBED_MAX_CHARS = 8000;

/**
 * Truncate text for embedding without splitting a surrogate pair at the cut.
 * A cut mid-emoji leaves a lone high surrogate — ill-formed UTF-16 serializes
 * to invalid JSON, which providers reject.
 */
export function capForEmbedding(text: string, max: number = EMBED_MAX_CHARS): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

turndown.remove(["script", "style", "noscript", "iframe"]);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

/**
 * Substitute ${VAR} references with values from process.env.
 * Read-only — never writes resolved values back. Matches OpenClaw's pattern.
 * Missing vars are left as literal `${VAR}` and logged (caller decides log policy).
 *
 * Variable names follow shell convention: letters, digits, underscore; first
 * char must not be a digit. Case-sensitive (matches process.env key lookup).
 */
export function substituteEnv(
  value: string,
  onMissing?: (name: string) => void,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    const v = process.env[name];
    if (v === undefined) {
      onMissing?.(name);
      return match;
    }
    return v;
  });
}

/**
 * Recursively apply substituteEnv to all string values in an object.
 * Non-strings pass through unchanged. Arrays and nested objects are walked.
 */
export function substituteEnvDeep<T>(
  value: T,
  onMissing?: (name: string) => void,
): T {
  if (typeof value === "string") {
    return substituteEnv(value, onMissing) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteEnvDeep(v, onMissing)) as T;
  }
  // Only traverse plain objects. Non-plain objects (Date, Map, class instances)
  // would lose prototype/state if rebuilt via Object.entries, so pass them through.
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteEnvDeep(v, onMissing);
    }
    return out as T;
  }
  return value;
}
