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
 * Strip ANSI escape codes and terminal control sequences from text.
 * Prevents provider JSON recursion errors (e.g. Gemini 400 "Message too deep")
 * and saves tokens from colored CLI / tool outputs.
 */
export function stripAnsi(text: string): string {
  // Matches standard CSI sequences (\x1b[...m/K/etc) and OSC sequences (\x1b]...\x07)
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|(?:\u001b\][^\u0007\u001b]*[\u0007\u001b\\])/g, "");
}

/**
 * Check if text contains ANSI escape sequences.
 */
export function hasAnsi(text: string): boolean {
  return /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|(?:\u001b\][^\u0007\u001b]*[\u0007\u001b\\])/.test(text);
}

/**
 * Convert standard ANSI styling codes into HTML (<font color="..."> and <b>).
 * Designed for Matrix formatted_body rendering inside <pre><code> blocks.
 */
export function ansiToHtml(text: string): string {
  const ANSI_COLOR_MAP: Record<number, string> = {
    30: "#11111b", // black / mantle
    31: "#f38ba8", // red
    32: "#a6e3a1", // green
    33: "#f9e2af", // yellow
    34: "#89b4fa", // blue
    35: "#cba6f7", // magenta / mauve
    36: "#94e2d5", // cyan / teal
    37: "#cdd6f4", // white / text
    90: "#6c7086", // bright black / gray (dim)
    91: "#eba0ac", // bright red
    92: "#a6e3a1", // bright green
    93: "#f9e2af", // bright yellow
    94: "#89b4fa", // bright blue
    95: "#f5c2e7", // bright magenta
    96: "#89dceb", // bright cyan
    97: "#ffffff", // bright white
  };

  // Split by ANSI escape sequences: \x1b[<codes>m
  const regex = /\u001b\[([0-9;]*)m/g;
  let result = "";
  let lastIndex = 0;
  let activeColor: string | null = null;
  let activeBold = false;
  let activeDim = false;

  const closeTags = () => {
    let closing = "";
    if (activeBold) {
      closing += "</b>";
      activeBold = false;
    }
    if (activeColor || activeDim) {
      closing += "</font>";
      activeColor = null;
      activeDim = false;
    }
    return closing;
  };

  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    // Append escaped text before the escape code
    const chunk = text.slice(lastIndex, match.index);
    if (chunk) {
      result += escapeHtml(chunk);
    }
    lastIndex = regex.lastIndex;

    const rawCodes = match[1] ? match[1].split(";").map(Number) : [0];
    for (const code of rawCodes) {
      if (code === 0) {
        // Reset all
        result += closeTags();
      } else if (code === 1) {
        // Bold
        if (!activeBold) {
          result += "<b>";
          activeBold = true;
        }
      } else if (code === 2) {
        // Dim
        if (!activeDim) {
          if (activeColor) result += "</font>";
          result += '<font color="#6c7086">';
          activeDim = true;
        }
      } else if (code === 22) {
        // Normal intensity (unbold, undim)
        if (activeBold) {
          result += "</b>";
          activeBold = false;
        }
        if (activeDim) {
          result += "</font>";
          activeDim = false;
        }
      } else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
        // Foreground color
        if (activeColor || activeDim) {
          result += "</font>";
          activeDim = false;
        }
        activeColor = ANSI_COLOR_MAP[code] || null;
        if (activeColor) {
          result += `<font color="${activeColor}">`;
        }
      } else if (code === 39) {
        // Default text color
        if (activeColor) {
          result += "</font>";
          activeColor = null;
        }
      }
    }
  }

  // Remainder
  const remaining = text.slice(lastIndex);
  if (remaining) {
    result += escapeHtml(remaining);
  }
  result += closeTags();

  return result;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
 * First-pass character cap for embedding inputs.
 *
 * Deliberately *not* a token guarantee — a character count can't be one.
 * Measured tokens per UTF-16 code unit against text-embedding-3-small
 * (8192-token limit): ASCII 0.13, Thai 1.0, CJK 2.0, emoji 2.0, rare kanji
 * (e.g. U+20BB7) 4.0. So a cap that always held would have to be ~2k chars,
 * which would clip ordinary English windows for no reason.
 *
 * This cap trims the obvious outliers cheaply; callers must still handle a
 * provider rejection, because one oversized value fails the whole embedMany
 * batch. See SegmentIndex.embedTexts for the shrink-and-retry that makes
 * progress guaranteed rather than likely.
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
