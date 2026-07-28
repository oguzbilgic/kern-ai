import type { ModelMessage } from "ai";
import type { KernPlugin, PluginContext, RouteHandler } from "../types.js";
import type { Attachment } from "../../interfaces/types.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { saveMedia, buildUserContent, MediaSidecar, resolveMediaInMessages, digestMediaAtIngest, stripUnresolvedMedia } from "./media.js";
import { log } from "../../log.js";

const MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

let mediaSidecar: MediaSidecar | null = null;

/**
 * Get the sidecar, creating it lazily if the session wasn't loaded yet when
 * onStartup ran. Resolution must never be skipped for lack of a sidecar — it
 * only needs it for labels and the digest cache.
 */
function ensureSidecar(ctx: PluginContext): MediaSidecar {
  if (mediaSidecar) return mediaSidecar;
  const sessionsDir = join(ctx.agentDir, ".kern", "sessions");
  const sessionId = ctx.sessionId();
  if (sessionId) {
    mediaSidecar = new MediaSidecar(sessionsDir, sessionId, ctx.db);
    mediaSidecar.load();
    return mediaSidecar;
  }
  // No session yet — ephemeral, not cached, so the real one is picked up
  // as soon as a session exists.
  return new MediaSidecar(sessionsDir, "unknown-session", null);
}

export const mediaPlugin: KernPlugin = {
  name: "media",

  routes: (() => {
    let _ctx: PluginContext | null = null;

    const routes: RouteHandler[] = [
      {
        method: "GET",
        path: "/media/list",
        handler: (_req, res) => {
          if (!_ctx) { res.writeHead(500); res.end(); return; }
          const files = _ctx.db.getMediaList();
          const stats = _ctx.db.getMediaStats();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ files, stats }));
        },
      },
      {
        method: "GET",
        path: /^\/media\/([a-f0-9]+\.[a-z0-9]+)$/,
        handler: (_req, res, match) => {
          if (!_ctx || !match) { res.writeHead(500); res.end(); return; }
          const filename = match[1];
          const mediaPath = join(_ctx.agentDir, ".kern", "media", filename);
          if (existsSync(mediaPath)) {
            const data = readFileSync(mediaPath);
            const ext = filename.split(".").pop() || "";
            res.writeHead(200, {
              "Content-Type": MIME_MAP[ext] || "application/octet-stream",
              "Cache-Control": "public, max-age=31536000, immutable",
            });
            res.end(data);
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "media not found" }));
          }
        },
      },
    ];

    (routes as any)._setCtx = (ctx: PluginContext) => { _ctx = ctx; };
    return routes;
  })(),

  async onStartup(ctx) {
    (this.routes as any)?._setCtx(ctx);

    // Init media sidecar if session already exists
    const sessionId = ctx.sessionId();
    if (sessionId) {
      const sessionsDir = join(ctx.agentDir, ".kern", "sessions");
      mediaSidecar = new MediaSidecar(sessionsDir, sessionId, ctx.db);
      mediaSidecar.load();
    }

    log("media", "plugin loaded");
  },

  onMessage: {
    async processAttachments(attachments: Attachment[], userMessage: string, ctx: PluginContext): Promise<ModelMessage | null> {
      if (attachments.length === 0) return null;

      const mediaRefs: Awaited<ReturnType<typeof saveMedia>>[] = [];
      const sidecar = ensureSidecar(ctx);
      for (const att of attachments) {
        const ref = saveMedia(ctx.agentDir, att.data, att.mimeType, att.filename);
        log("runtime", `saved media: ${ref.uri} (${ref.size} bytes)`);
        sidecar.append({
          file: ref.file,
          originalName: att.filename,
          mimeType: ref.mimeType,
          size: ref.size,
          timestamp: new Date().toISOString(),
        });
        if (ctx.config.mediaDigest) {
          await digestMediaAtIngest(sidecar, ctx.agentDir, ref.file, ref.mimeType, ctx.config);
        }
        mediaRefs.push(ref);
      }
      return { role: "user", content: buildUserContent(userMessage, mediaRefs) };
    },

    async resolveMessages(messages: ModelMessage[], ctx: PluginContext): Promise<ModelMessage[]> {
      // Providers reject the kern-media: scheme as a fatal error, and the
      // dispatcher fails open on plugin errors — so resolution must neither
      // be skipped nor allowed to leak a raw URI, no matter what fails here.
      let resolved = messages;
      try {
        resolved = await resolveMediaInMessages(messages, ensureSidecar(ctx), ctx.agentDir, ctx.config);
      } catch (err) {
        log.warn("media", `resolveMediaInMessages failed, stripping raw refs: ${err}`);
      }
      return stripUnresolvedMedia(resolved);
    },
  },

  onStatus(ctx) {
    const stats = ctx.db.getMediaStats();
    return { media: stats };
  },
};
