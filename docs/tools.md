# Tools

kern provides built-in tools. Availability depends on `toolScope` in config.

## bash

Run shell commands on Unix/Linux. Full access to the system.

```
bash({ command: "ls -la", timeout: 120000 })
```

- `command` — shell command to execute
- `timeout` — optional, milliseconds (default 120000)

Scope: `full` only. Unix/Linux only — on Windows, `pwsh` is provided instead.

## pwsh

Run PowerShell commands on Windows. Full access to the system.

```
pwsh({ command: "Get-Process", timeout: 120000 })
```

- `command` — PowerShell command to execute
- `timeout` — optional, milliseconds (default 120000)

Scope: `full` only. Windows only — on Unix/Linux, `bash` is provided instead. Detects `pwsh` (PS 7+) with fallback to `powershell` (5.1).

## read

Read a file or list a directory.

```
read({ path: "IDENTITY.md", offset: 1, limit: 2000 })
```

- `path` — absolute or relative path
- `offset` — line number to start from (1-indexed, default 1)
- `limit` — max lines to return (default 2000)

Returns file contents with line numbers, or directory entries.

## write

Create or overwrite a file.

```
write({ path: "notes/2026-03-24.md", content: "# Today\n..." })
```

Creates parent directories as needed.

## edit

Exact string replacement in a file.

```
edit({ path: "config.json", oldString: "opus-4", newString: "opus-4.6", replaceAll: false })
```

- `oldString` must match exactly
- `replaceAll` — replace all occurrences (default false)

## glob

Find files by pattern.

```
glob({ pattern: "**/*.md", path: "/root/atlas" })
```

## grep

Search file contents with regex.

```
grep({ pattern: "TODO", path: ".", include: "*.md" })
```

## webfetch

Fetch a URL. HTML pages are converted to markdown using a provider fallback chain: [Jina Reader](https://jina.ai/reader/) (primary, handles JS-rendered pages and PDFs) → local Turndown conversion (fallback). JSON and plain text are returned as-is.

```
webfetch({ url: "https://example.com" })
webfetch({ url: "https://example.com", raw: true })
```

- `url` — the URL to fetch
- `raw` — return raw HTML instead of markdown, bypassing both providers (default: false)

Set `JINA_API_KEY` in `.kern/.env` for higher Jina rate limits (500 RPM vs 20 RPM free).

Truncates responses over 50000 chars.

## websearch

Search the web. Returns results as markdown with titles, URLs, and snippets. Uses a provider fallback chain: SearXNG (if `SEARXNG_URL` set) → DuckDuckGo.

```
websearch({ query: "node.js html to markdown library" })
```

- `query` — the search query

## pdf

Read or analyze a PDF file. Returns extracted text for specified pages.

```
pdf({ file: "report.pdf" })                           // page 1 text
pdf({ file: "report.pdf", pages: "1-5" })             // pages 1-5
pdf({ file: "report.pdf", prompt: "Summarize this" }) // all pages + AI analysis
```

- `file` — path to PDF file
- `pages` — page range: `"1"`, `"1-5"`, `"2,4,7-9"`. Default: page 1 (without prompt), all pages (with prompt)
- `prompt` — optional question to ask about the PDF content

## image

Analyze an image file using the AI model.

```
image({ file: "screenshot.png" })
image({ file: "screenshot.png", prompt: "What error is shown?" })
```

- `file` — path to image file, or filename from `.kern/media/`
- `prompt` — what to analyze (default: "Describe this image.")

## audio

Transcribe or analyze an audio file (voice messages, recordings) using an audio-capable AI model.

```
audio({ file: "voice.oga" })
audio({ file: "meeting.mp3", prompt: "Summarize the key decisions" })
```

- `file` — path to audio file, or filename from `.kern/media/`
- `prompt` — question about the audio (default: transcribe verbatim)

Most chat models can't hear audio, so the tool uses a fallback chain: `audioModel` config → agent model → provider default (`google/gemini-3.7-flash` on OpenRouter, `gpt-audio-mini` on OpenAI) → `google/gemini-3.7-flash` routed via OpenRouter for any provider when `OPENROUTER_API_KEY` is set. Gemini models accept ogg/opus natively, so Telegram voice notes need no transcoding. The OpenAI default only handles wav/mp3 — ogg voice notes on non-OpenRouter providers use the cross-provider OpenRouter fallback. Set `audioModel` explicitly to skip the doomed attempt on a text-only chat model. Files over 20 MB are rejected.

## spawn

Spawn a sub-agent to work on a focused task in parallel. Returns immediately with a sub-agent ID — the child runs in the background with its own LLM loop.

```
spawn({ prompt: "Research Node.js 22 crypto changes and summarize breaking changes", maxSteps: 30 })
```

- `prompt` — the task for the sub-agent (self-contained — child starts with no context about your current work)
- `maxSteps` — max reasoning steps (default 20, max 50)

When the child finishes, its result arrives as a new turn with metadata like `[via subagent, subagent:<id>, user: subagent, time: <iso8601>]`. The envelope identifies the source; the body is the child's final answer (no extra header on success). Failed sub-agents prefix the body with a `[subagent:<id> failed, 12s]` style line so the outcome is visible; cancelled sub-agents emit only the header line with no body. You can spawn multiple sub-agents in parallel and synthesize their results as they arrive.

Sub-agents run with a read-only toolset: `read`, `glob`, `grep`, `webfetch`, `websearch`, `pdf`, `image`, `audio`. They cannot run shell commands, edit files, call plugin tools, or spawn further sub-agents.

Use sub-agents for research fan-out, parallel documentation lookups, evaluating multiple candidates, or any read-only task you can delegate while you keep working. Don't use them for trivial one-off reads — just call `read` directly.

Sub-agent state is persisted under `.kern/subagents/<id>/` — `session.jsonl` holds the transcript, `record.json` holds the final metadata.

## subagents

Inspect and manage sub-agents.

```
subagents({ action: "list" })                      // all sub-agents with status
subagents({ action: "status", id: "sa_abc123" })   // detailed status
subagents({ action: "result", id: "sa_abc123" })   // final result text
subagents({ action: "cancel", id: "sa_abc123" })   // abort a running sub-agent
```

- `action` — `list`, `status`, `result`, or `cancel`
- `id` — sub-agent ID (required for `status`, `result`, `cancel`)

Statuses: `running`, `done`, `failed`, `cancelled`.

## kern

Manage the runtime.

```
kern({ action: "status" })     // runtime info, context size, API usage, queue, interface status
kern({ action: "config" })     // show .kern/config.json
kern({ action: "env" })        // show env var names (masked values)
kern({ action: "pair", code: "KERN-XXXX" })  // approve a pairing code
kern({ action: "users" })      // list paired and pending users
kern({ action: "logs" })       // recent warn+ logs (default: 50 lines)
kern({ action: "logs", level: "error" })           // errors only
kern({ action: "logs", level: "info", lines: 20 }) // last 20 info+ lines
```

## message

Send a message to a user on any channel.

```
message({ userId: "12345", interface: "telegram", text: "Hello!" })
```

- `userId` — from USERS.md or pairing data
- `interface` — `telegram`, `slack`, or `matrix`
- Looks up chatId from pairing data
- Broadcasts outgoing event to TUI

## recall

Search long-term memory for old conversations outside the current context window. Two modes:

### Search mode

```
recall({ query: "pfSense firewall rules", limit: 5, after: "2026-03-25", before: "2026-03-28" })
```

- `query` — semantic search query
- `limit` — max results (default 5)
- `after` — only results after this date (ISO 8601 or YYYY-MM-DD)
- `before` — only results before this date

Returns matching conversation chunks with distance score, timestamp, session ID, and message range. Chunks from the current session that are already visible in the context window are automatically filtered out to avoid duplicate information.

### Load mode

```
recall({ sessionId: "96fbe7c5-...", messageStart: 100, messageEnd: 110 })
```

- `sessionId` — session to load from
- `messageStart` / `messageEnd` — message index range

Returns raw messages for a specific range — use after search to get full context around a hit.

### How it works

On startup, kern indexes the current session's messages into a local sqlite-vec database (`.kern/recall.db`). Indexing runs in the background — the agent is available immediately while the index builds. Raw messages are stored in sqlite alongside embedded chunks, so retrieval doesn't need to read session files.

Messages are chunked by turn (user→assistant pairs), embedded via `text-embedding-3-small`, and stored as vectors. After each turn, new messages are incrementally indexed — only new lines are parsed.

Search uses cosine similarity (KNN) to find the most relevant past conversation chunks.

Check indexing status via `kern({ action: "status" })` — the `recall` field shows message/chunk counts and whether the index is still building.

### Requirements

Requires an API key for the configured provider (used for embeddings). Uses `text-embedding-3-small` (1536 dimensions).

### Auto-recall

When `"autoRecall": true` is set in config, kern automatically injects relevant old context before each turn:

- Embeds the user's message and searches the recall index (top 3 results, distance < 0.95)
- Skips chunks already visible in the current context window
- Injects a `<recall>` block at the top of the context (ephemeral — not persisted to session)
- Capped at ~2000 tokens to avoid bloating context

The web UI shows a collapsible `📎 N memories recalled` block with the search query and chunk details.

Auto-recall only fires when messages have been trimmed from context (long sessions). Short sessions with everything in context don't trigger it.

### Opt-out

Set `"recall": false` in `.kern/config.json` to disable recall entirely.

Set `"autoRecall": false` (or omit it) to disable auto-injection while keeping the recall search tool available.
