# Media

kern supports images, audio, and files in conversations across all interfaces.

## How it works

1. **Receive** — user sends an image/file via Telegram, Slack, or Web UI
2. **Store** — file saved to `.kern/media/` with a SHA-256 content-addressed filename (deduped)
3. **Digest** — images are described by a vision model and audio is transcribed by an audio-capable model at ingest time, cached permanently
4. **Message** — SDK-native content array stored in session with `kern-media://` URI references
5. **Resolve** — before model call, all `kern-media://` refs are resolved: digested images become text descriptions, recent files become raw Buffers (per `mediaContext`), older files become text placeholders
6. **Serve** — `GET /media/:filename` serves stored files with immutable caching

## Storage

Media files live in `.kern/media/` (gitignored). Filenames are `{sha256-prefix}{ext}` — e.g. `a1b2c3d4e5f6g7h8.jpg`. This deduplicates identical files automatically.

A per-session sidecar file (`.media.jsonl`) tracks metadata: original filename, MIME type, size, timestamp, and cached descriptions. This is also mirrored to the SQLite `media` table for cross-session queries.

## Pre-digest

When `mediaDigest` is enabled (default), kern digests images and audio once at ingest time:

- When a user sends an image, it's saved to disk and immediately described by a vision model (~300 tokens)
- The description is cached permanently in the media sidecar — never regenerated
- Before model call, image references are replaced with cached text: `[Image: photo.jpg (a1b2c3d4.jpg) — A terminal showing npm install output...]`
- Voice messages and audio files are transcribed the same way: an audio-capable model (fallback chain: `audioModel` → agent model → `google/gemini-3.1-flash-lite` on OpenRouter) produces a transcript, cached in the same `description` field. Telegram voice notes (`.oga`, ogg/opus) are sent as-is — Gemini accepts them natively, no transcoding. Audio over 20 MB is skipped (logged).
- On cache miss (e.g. old images from before digest was enabled), digest is triggered on the fly

This means:
- **Text-only models work** — they see descriptions, not raw images
- **Token costs are minimal** — one vision call per image, ever. No raw binary sent to model.
- **Context is preserved** — text descriptions survive context trimming and appear in summaries

### Disabling pre-digest

Set `mediaDigest: false` to skip image digestion. Raw images are then controlled by `mediaContext`.

### mediaContext

Controls how many recent turns resolve raw media Buffers to the model. Applies to all media types:

- **Pre-digested images and audio**: replaced with text description/transcript regardless — `mediaContext` has no effect
- **Other files** (PDFs, etc.): no digest yet, so `mediaContext` controls whether raw binary is sent. E.g. `mediaContext: 1` sends the current turn's PDF to Claude for native processing.
- **Images with digest off**: `mediaContext` controls how many turns get raw image Buffers

Examples:
- `mediaContext: 0` (default) — no raw binary ever sent. All media becomes text descriptions or `[attached file: ...]` placeholders.
- `mediaContext: 1` — latest turn's media sent raw, older becomes placeholders. Good for models with native PDF/audio support.
- `mediaContext: 3` — last 3 turns' media sent raw.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `mediaDigest` | `true` | Enable image pre-digest pipeline: vision model describes images on arrival, caches descriptions, replaces raw images with text in context |
| `mediaModel` | `""` | Vision model for descriptions. Fallback chain: `mediaModel` → agent model → hardcoded provider default (e.g. `gpt-4.1-mini` for OpenAI, `claude-sonnet-4-6` for Anthropic) |
| `mediaContext` | `0` | How many recent turns resolve raw media Buffers to the model. 0 = never send raw binary (descriptions or placeholders only) |

## Message format

Messages with media use SDK-native content arrays:

```json
{
  "role": "user",
  "content": [
    { "type": "image", "image": "kern-media://a1b2c3d4.jpg", "mediaType": "image/jpeg" },
    { "type": "text", "text": "What's in this screenshot?" }
  ]
}
```

For text extraction (embeddings, search, summaries), only text parts are used. Media references are preserved in session storage but don't pollute search indexes.

## Supported types

Images: JPEG, PNG, GIF, WebP, SVG, HEIC
Video: MP4, MOV, WebM
Audio: MP3, OGG, WAV, WebM, M4A
Documents: PDF, JSON, plain text, CSV, Markdown

Only images are pre-digested currently. Other file types pass through as-is (if `mediaContext > 0`) or become text placeholders (if `mediaContext: 0`).

## Interfaces

- **Telegram** — photos, documents, stickers, voice, video, audio. Per-type error handling. 50MB limit.
- **Slack** — files shared in messages. 50MB limit.
- **Web UI** — drag-and-drop or file picker. Inline preview before send. Images rendered inline in chat history.

## Related tools

The `image` and `pdf` tools are core tools (not part of this plugin) — they operate on files on disk and work whether or not the media pipeline is active. Useful for re-examining images that have aged out of context, or extracting text from PDFs stored in `.kern/media/`.

See [tools.md](tools.md) for full documentation.

## API

- `GET /media/:filename` — serve a stored media file (requires auth)
- Media URLs in web UI use the proxy: `/api/agents/{agent}/media/{file}?token=AUTH`
