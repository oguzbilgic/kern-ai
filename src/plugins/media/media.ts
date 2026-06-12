import { createHash } from "crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs";
import { join, extname } from "path";
import { generateText, type ModelMessage, type UserContent } from "ai";
import { log } from "../../log.js";
import { createModel } from "../../model.js";
import type { KernConfig } from "../../config.js";
import type { MemoryDB } from "../../memory.js";

/** URI scheme for media references stored on disk */
export const MEDIA_SCHEME = "kern-media://";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
};

function getExtension(mimeType: string, filename?: string): string {
  if (filename) {
    const ext = extname(filename);
    if (ext) return ext;
  }
  return MIME_TO_EXT[mimeType] || ".bin";
}

// --- Media entry type ---

export interface MediaEntry {
  file: string;
  originalName?: string;
  mimeType: string;
  size: number;
  description?: string;
  describedBy?: string;
  timestamp: string;
}

// --- Media sidecar ---

export class MediaSidecar {
  private map = new Map<string, MediaEntry>();
  private sidecarPath: string;
  private sessionId: string;
  private memoryDB: MemoryDB | null;

  constructor(sessionsDir: string, sessionId: string, memoryDB: MemoryDB | null = null) {
    this.sidecarPath = join(sessionsDir, `${sessionId}.media.jsonl`);
    this.sessionId = sessionId;
    this.memoryDB = memoryDB;
  }

  /** Load sidecar from disk into memory map. Last entry per file wins. */
  load(): void {
    if (!existsSync(this.sidecarPath)) return;
    try {
      const raw = readFileSync(this.sidecarPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as MediaEntry;
          if (entry.file) this.map.set(entry.file, entry);
        } catch {
          // Skip malformed lines
        }
      }
      log("media", `loaded sidecar: ${this.map.size} entries`);
      // Backfill SQLite from sidecar entries
      if (this.memoryDB && this.map.size > 0) {
        for (const entry of this.map.values()) {
          try {
            this.memoryDB.db.prepare(`
              INSERT INTO media (session_id, file, originalName, mimeType, size, description, describedBy, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_id, file) DO UPDATE SET
                description = COALESCE(excluded.description, media.description),
                describedBy = COALESCE(excluded.describedBy, media.describedBy),
                originalName = COALESCE(excluded.originalName, media.originalName)
            `).run(
              this.sessionId,
              entry.file,
              entry.originalName || null,
              entry.mimeType,
              entry.size,
              entry.description || null,
              entry.describedBy || null,
              entry.timestamp,
            );
          } catch (err) {
            log.debug("media", `backfill entry failed (${entry.file}): ${err}`);
          }
        }
        log("media", `backfilled ${this.map.size} entries to SQLite`);
      }
    } catch (err) {
      log.warn("media", `failed to load sidecar: ${err}`);
    }
  }

  /** Append a media entry to the sidecar file and SQLite. */
  append(entry: MediaEntry): void {
    this.map.set(entry.file, entry);
    try {
      appendFileSync(this.sidecarPath, JSON.stringify(entry) + "\n");
    } catch (err) {
      log.warn("media", `failed to write sidecar: ${err}`);
    }
    // Mirror to SQLite
    if (this.memoryDB) {
      try {
        this.memoryDB.db.prepare(`
          INSERT INTO media (session_id, file, originalName, mimeType, size, description, describedBy, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id, file) DO UPDATE SET
            description = excluded.description,
            describedBy = excluded.describedBy,
            originalName = excluded.originalName
        `).run(
          this.sessionId,
          entry.file,
          entry.originalName || null,
          entry.mimeType,
          entry.size,
          entry.description || null,
          entry.describedBy || null,
          entry.timestamp,
        );
      } catch (err) {
        log.warn("media", `failed to write media to SQLite: ${err}`);
      }
    }
  }

  /** Get a media entry by filename. */
  get(filename: string): MediaEntry | undefined {
    return this.map.get(filename);
  }

  /** Get cached description if it exists and was made by the current model. */
  getDescription(filename: string): string | null {
    const entry = this.map.get(filename);
    if (!entry?.description) return null;
    return entry.description;
  }

  /** Update an existing entry with a description. Creates entry if missing. */
  updateDescription(filename: string, description: string, describedBy: string): void {
    const existing = this.map.get(filename);
    const updated = { ...(existing || { file: filename, originalName: "", mimeType: "image/unknown", size: 0, timestamp: new Date().toISOString() }), description, describedBy };
    this.append(updated);
  }

  get size(): number {
    return this.map.size;
  }
}

// --- Save media to disk ---

/**
 * Save media buffer to .kern/media/ with content-addressed filename.
 * Returns the kern-media:// URI for storage in messages.
 */
export function saveMedia(
  agentDir: string,
  data: Buffer,
  mimeType: string,
  filename?: string,
): { uri: string; file: string; mimeType: string; filename?: string; size: number } {
  const mediaDir = join(agentDir, ".kern", "media");
  if (!existsSync(mediaDir)) {
    mkdirSync(mediaDir, { recursive: true });
  }

  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  const ext = getExtension(mimeType, filename);
  const storedName = `${hash}${ext}`;
  const fullPath = join(mediaDir, storedName);

  if (!existsSync(fullPath)) {
    writeFileSync(fullPath, data);
    log("media", `saved ${storedName} (${data.length} bytes, ${mimeType})`);
  } else {
    log("media", `dedup hit: ${storedName}`);
  }

  return {
    uri: `${MEDIA_SCHEME}${storedName}`,
    file: storedName,
    mimeType,
    filename,
    size: data.length,
  };
}

// --- Ingest-time digest ---

/** Known vision-capable models per provider, used as last-resort fallback. */
const VISION_FALLBACKS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4.1-mini",
  openrouter: "openai/gpt-4.1-mini",
};

/**
 * Build the model fallback chain for media digest.
 * Order: mediaModel (if set) → agent model → hardcoded provider fallback.
 * Deduplicates entries.
 */
function getDigestModelChain(config: KernConfig): string[] {
  const chain: string[] = [];
  if (config.mediaModel) chain.push(config.mediaModel);
  chain.push(config.model);
  const fallback = VISION_FALLBACKS[config.provider];
  if (fallback) chain.push(fallback);
  // Deduplicate while preserving order
  return [...new Set(chain)];
}

/**
 * Digest media at ingest time — runs once when media first arrives.
 * For images: calls vision model to get text description.
 * For other types: could extract text locally (PDF, etc.) in future.
 * Results are cached in the sidecar.
 *
 * Tries models in order: mediaModel → agent model → provider fallback.
 */
export async function digestMediaAtIngest(
  sidecar: MediaSidecar,
  agentDir: string,
  file: string,
  mimeType: string,
  config: KernConfig,
): Promise<string | null> {
  // Only digest images for now
  if (!mimeType.startsWith("image/")) return null;

  // Already digested?
  const cached = sidecar.getDescription(file);
  if (cached) return cached;

  const mediaDir = join(agentDir, ".kern", "media");
  const fullPath = join(mediaDir, file);
  if (!existsSync(fullPath)) return null;

  const buf = readFileSync(fullPath);
  const chain = getDigestModelChain(config);

  // Ollama thinking models blow the 300-token budget on reasoning before
  // emitting any description. Disable thinking defensively.
  const isOllama = config.provider === "ollama";

  for (const modelId of chain) {
    try {
      log("media", `digesting ${file} with ${modelId}...`);
      const digestModel = createModel({ ...config, model: modelId });

      const result = await generateText({
        model: digestModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", image: buf, mediaType: mimeType },
              { type: "text", text: "Describe this image." },
            ],
          },
        ],
        maxOutputTokens: 300,
        ...(isOllama ? { providerOptions: { openai: { think: false } } } : {}),
      });

      const description = result.text.trim();
      if (description) {
        sidecar.updateDescription(file, description, modelId);
        log("media", `digested ${file}: ${description.slice(0, 80)}...`);
        return description;
      }
    } catch (err) {
      log.warn("media", `digest failed with ${modelId}: ${err}`);
      if (modelId !== chain[chain.length - 1]) {
        log("media", `falling back to next model...`);
      }
    }
  }

  log.warn("media", `all digest models failed for ${file}`);
  return null;
}

// --- Build user content ---

/**
 * Build SDK-native content array from text + saved media refs.
 * Returns a string if no media, or UserContent array if media present.
 */
export function buildUserContent(
  text: string,
  media: { uri: string; mimeType: string; filename?: string }[],
): UserContent {
  if (media.length === 0) return text;

  const parts: any[] = [];

  for (const m of media) {
    if (m.mimeType.startsWith("image/")) {
      parts.push({ type: "image", image: m.uri, mediaType: m.mimeType });
    } else {
      parts.push({
        type: "file",
        data: m.uri,
        mediaType: m.mimeType,
        ...(m.filename ? { filename: m.filename } : {}),
      });
    }
  }

  if (text) {
    parts.push({ type: "text", text });
  }

  return parts;
}

/**
 * Resolve all kern-media:// references in a messages array before passing to streamText.
 * The SDK tries to download URLs before middleware runs, so we must resolve here.
 *
 * For each media part:
 * 1. If digest enabled + description cached → replace with text
 * 2. If digest enabled + no description → trigger digest, then replace with text
 * 3. If within mediaContext limit → resolve to raw Buffer (Uint8Array)
 * 4. Otherwise → text placeholder
 */
export async function resolveMediaInMessages(
  messages: ModelMessage[],
  sidecar: MediaSidecar,
  agentDir: string,
  config: KernConfig,
): Promise<ModelMessage[]> {
  const mediaDir = join(agentDir, ".kern", "media");
  const digestEnabled = config.mediaDigest;
  const contextLimit = config.mediaContext ?? 0;

  function makeLabel(filename: string): string {
    const entry = sidecar.get(filename);
    return entry?.originalName ? `${entry.originalName} (${filename})` : filename;
  }

  // Find user messages with media refs, count from end for mediaContext limit
  const userMediaIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const hasMedia = msg.content.some(
      (p: any) =>
        (p.type === "image" && typeof p.image === "string" && (p.image as string).startsWith(MEDIA_SCHEME)) ||
        (p.type === "file" && typeof p.data === "string" && (p.data as string).startsWith(MEDIA_SCHEME)),
    );
    if (hasMedia) userMediaIndices.push(i);
  }
  const resolveSet = new Set(userMediaIndices.slice(0, contextLimit));

  let digested = 0;
  let resolved = 0;
  let placeholders = 0;

  const result = await Promise.all(
    messages.map(async (msg, msgIdx) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

      const hasRef = msg.content.some(
        (p: any) =>
          (p.type === "image" && typeof p.image === "string" && (p.image as string).startsWith(MEDIA_SCHEME)) ||
          (p.type === "file" && typeof p.data === "string" && (p.data as string).startsWith(MEDIA_SCHEME)),
      );
      if (!hasRef) return msg;

      const newParts = await Promise.all(
        msg.content.map(async (part: any) => {
          let filename: string | null = null;
          let isImage = false;

          if (part.type === "image" && typeof part.image === "string" && part.image.startsWith(MEDIA_SCHEME)) {
            filename = part.image.slice(MEDIA_SCHEME.length);
            isImage = true;
          } else if (part.type === "file" && typeof part.data === "string" && part.data.startsWith(MEDIA_SCHEME)) {
            filename = part.data.slice(MEDIA_SCHEME.length);
            isImage = part.mediaType?.startsWith("image/") || false;
          }

          if (!filename) return part;

          // 1. Try digest replacement (images only)
          if (digestEnabled && isImage) {
            let description = sidecar.getDescription(filename);
            if (!description) {
              const mimeType = part.mediaType || "image/unknown";
              description = await digestMediaAtIngest(sidecar, agentDir, filename, mimeType, config);
            }
            if (description) {
              digested++;
              return { type: "text" as const, text: `[Image: ${makeLabel(filename)} — ${description}]` };
            }
          }

          // 2. Within mediaContext limit — resolve to raw Buffer
          if (resolveSet.has(msgIdx)) {
            const fullPath = join(mediaDir, filename);
            if (existsSync(fullPath)) {
              resolved++;
              const buf = new Uint8Array(readFileSync(fullPath));
              if (part.type === "image") {
                return { ...part, image: buf };
              } else {
                return { ...part, data: buf };
              }
            }
            log.warn("media", `file not found: ${filename}`);
          }

          // 3. Text placeholder
          placeholders++;
          const label = makeLabel(filename);
          const prefix = isImage ? "attached image" : "attached file";
          return { type: "text" as const, text: `[${prefix}: ${label}]` };
        }),
      );

      return { ...msg, content: newParts };
    }),
  );

  if (digested > 0) log("media", `digested ${digested} image(s)`);
  if (resolved > 0) log("media", `resolved ${resolved} file(s) to Buffer`);
  if (placeholders > 0) log.debug("media", `${placeholders} media placeholder(s)`);

  return result;
}
