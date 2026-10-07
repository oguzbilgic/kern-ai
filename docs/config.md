# Configuration

## Per-agent: .kern/config.json

The main config file. Committed to git. Unknown top-level fields are warned on startup and ignored. Invalid model routing, nested model fields, and malformed JSON fail startup rather than silently choosing a different model. Other wrong-type fields fall back to defaults.

```json
{
  "model": "google/gemini-3.8-flash",
  "provider": "openrouter",
  "toolScope": "full"
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `version` | package version at creation | Package version of the last successful file migration. Updated only when a migration runs; ordinary package upgrades leave it unchanged. Managed by Kern. |
| `name` | directory name | Agent name. Auto-set to directory basename on first startup if missing. Exposed in `/status` response. |
| `model` | `google/gemini-3.8-flash` | Model ID. Format depends on provider. |
| `provider` | `openrouter` | Main connection: `openrouter`, `anthropic`, `openai`, `ollama`, `openai-compatible`. |
| `baseURL` | provider preset | Full API root, including `/v1` where required. Required for `openai-compatible`. |
| `apiKeyEnv` | provider preset | Name of the credential variable in `.kern/.env`; never put the secret in JSON. |
| `auth` | provider preset | `"none"` disables authentication. Mutually exclusive with `apiKeyEnv`. Custom URLs default to no authentication unless `apiKeyEnv` is supplied. |
| `api` | provider preset | `"chat"` or `"responses"`. OpenAI's hosted preset uses Responses; custom OpenAI URLs, Ollama, OpenRouter, and compatible servers use Chat Completions. Responses is supported for `openai` and `openai-compatible` only. OpenAI audio input uses Chat Completions independently of the text-chat API. |
| `toolScope` | `full` | Tool access level: `full`, `write`, `read` |
| `maxSteps` | `30` | Max tool-use steps per message |
| `port` | auto | Fixed port for the agent HTTP server. Assigned automatically from 4100-4999 on creation or first start. |
| `maxContextTokens` | `100000` | Token budget for context window. Messages beyond this are trimmed oldest-first. Full history stays in session JSONL files. |
| `maxToolResultChars` | `20000` | Max characters per tool result in context. Oversized results are truncated in context only. Full results stay in session storage. Set to `0` to disable. |
| `telegramTools` | `false` | Show tool call progress lines (⚙ bash, etc.) in Telegram messages. |
| `discordMentionOnly` | `true` | In Discord server channels, only respond when @mentioned. Set `false` to process all channel messages (overridable via `DISCORD_MENTION_ONLY`). |
| `nostrRelays` | `[]` | Nostr relay URLs. Empty = built-in public defaults (damus, nos.lol, primal). `NOSTR_RELAYS` env (comma-separated) overrides. See [Interfaces § Nostr](interfaces.md#nostr). |
| `irc` | `""` | IRC connection URL: `irc://nick@host:6667/#chan` or `ircs://nick:pass@host:6697/#a,#b`. Channels are comma-separated inside the URL; whitespace-separate whole URLs to join several networks. Empty = IRC disabled. `IRC_URL` env overrides. See [Interfaces § IRC](interfaces.md#irc). |
| `stripAnsi` | `true` | Strip ANSI escape codes from tool outputs before saving to session history and event streams. Set `false` to preserve raw escape sequences. |
| `heartbeatInterval` | `60` | Minutes between heartbeat prompts. Agent reviews notes, updates knowledge. 0 to disable. |
| `timezone` | `""` | IANA timezone (e.g. `"America/Los_Angeles"`) used for the `time:` field in the envelope the model reads. Empty = autoresolve to host. Storage (logs, recall, session metadata) stays UTC regardless. |
| `embeddingModel` | `""` | Embedding reference for recall and segment boundaries. String = model on main connection; object = independently configured connection; `false` = disabled. Custom servers require an explicit model ID. |
| `recall` | `true` | Enable recall and semantic segments. `false` skips embedding requests. Requires a working embedding connection; messages and notes remain available regardless. |
| `summaryBudget` | `0.75` | Fraction of `maxContextTokens` for compressed conversation summaries from segments. Cached via prompt caching, so effectively free for supported models. Set to `0` to disable. See [Context](context.md#conversation-summary). |
| `summaryModel` | `""` | Model reference for summaries and narration. Empty = provider default; strings inherit the main connection; objects can choose another connection. See below. |
| `subAgentModel` | `""` | Model reference for spawned children. Empty = main model. A per-spawn string override uses the parent connection. |
| `autoRecall` | `false` | Automatically inject relevant old context before each turn. Requires recall enabled. |
| `mediaDigest` | `true` | Enable media pre-digest: describes images (vision model) and transcribes audio (audio model) on arrival, caches results, and replaces raw media with text in context. Set to `false` to disable the entire digest pipeline. |
| `mediaModel` | `""` | Model reference for image descriptions and the `image` tool. An explicit reference is authoritative; otherwise ingest tries the main model and same-provider vision default. |
| `audioModel` | `""` | Model reference for audio analysis and ingest transcription. Explicit reference is authoritative; otherwise tries main model and same-provider audio default. No implicit cloud fallback. |
| `mediaContext` | `0` | How many recent turns resolve raw media Buffers to the model. `0` = never send raw binary (text descriptions or placeholders only). Applies to all media types — useful for non-image files like PDFs on models with native support. |
| `mcpServers` | `{}` | Model Context Protocol servers. Tools namespaced as `<server>__<tool>`. See [MCP](mcp.md). |

### Tool scopes

- **full** — bash, jobs, read, write, edit, glob, grep, webfetch, websearch, kern, message, recall, pdf, image, audio
- **write** — read, write, edit, glob, grep, webfetch, websearch, kern, message, recall, pdf, image, audio
- **read** — read, glob, grep, webfetch, websearch, kern, recall, pdf, image, audio

### Connections and model references

The top-level `provider`, `model`, `baseURL`, `apiKeyEnv`, `auth`, and `api` describe the main chat connection. Secondary fields (`embeddingModel`, `summaryModel`, `subAgentModel`, `mediaModel`, `audioModel`) accept the same reference format:

- **String**: a model ID on the main connection. IDs are opaque: `/` never changes routing.
- **Object**: `{ "model": "id", "provider": "...", "baseURL": "...", "apiKeyEnv": "..." }`. Only `model` is required. Without `provider` or a new URL, omitted connection settings inherit from the main connection. Repeating the parent's URL, including with trailing slashes or surrounding whitespace, retains its authentication and API selection.
- **Explicit provider**: starts from that provider's defaults, even if it has the same provider name as the parent; it does not inherit the parent's custom URL or credentials.
- **New URL**: uses that provider's defaults plus the new URL, and clears inherited credentials. Supply `apiKeyEnv` if authentication is required. Use the complete API root; Kern never guesses whether to append `/v1`.
- **Explicit provider with a custom URL**: defaults to no authentication even if the URL matches the parent. Supply `apiKeyEnv` explicitly to authenticate that connection.
- **`embeddingModel: false`** or **`recall: false`**: disable embeddings, recall, and semantic segmentation. Other model fields do not accept `false`.

Provider presets:

| Provider | API root | Credential | Chat API |
|----------|----------|------------|----------|
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | Chat Completions; native adapter for Anthropic caching and audio |
| `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | Native Anthropic |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` | Responses |
| `ollama` | `http://localhost:11434/v1` | none | Chat Completions |
| `openai-compatible` | explicitly configured | none by default | Chat Completions |

Writing the main connection's exact hosted preset URL explicitly retains that provider's default authentication and API selection. Custom URLs default to no authentication. For authenticated local servers or gateways, use `apiKeyEnv` pointing at a distinct secret variable. Do not combine it with `auth: "none"`.

When updating an existing agent with `kern init` flags, omitted settings on the same connection are preserved, including the provider, model, API root, credential variable, and API selection. Comparisons account for omitted provider/URL defaults and normalize trailing slashes and whitespace. Changing the provider or endpoint clears the old connection settings; the wizard also uses the new connection's API default when changing endpoints. `--api-key-env LOCAL_MODEL_API_KEY` selects an existing environment credential without requiring `--api-key` or copying its value into `.env`. Setup validates the effective configuration, including `KERN_*` overrides, before saving changes or stopping a running agent.

**Hosted chat, local embeddings:**

```json
{
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-5",
  "embeddingModel": {
    "provider": "openai-compatible",
    "baseURL": "http://localhost:1234/v1",
    "model": "your-loaded-embedding-model",
    "auth": "none"
  },
  "summaryModel": "google/gemini-3.5-flash-lite"
}
```

**All local, one server:**

```json
{
  "provider": "openai-compatible",
  "baseURL": "http://localhost:1234/v1",
  "auth": "none",
  "model": "your-loaded-chat-model",
  "embeddingModel": "your-loaded-embedding-model",
  "summaryModel": "your-loaded-non-thinking-model"
}
```

The server must actually host the selected models and support `/embeddings` for memory. A chat model alone does not imply embedding support.

**Local chat, explicit cloud summaries/audio:**

```json
{
  "provider": "ollama",
  "model": "gemma4:31b",
  "summaryModel": { "provider": "openrouter", "model": "google/gemini-3.5-flash-lite" },
  "audioModel": { "provider": "openrouter", "model": "google/gemini-3.8-flash" }
}
```

Put `OPENROUTER_API_KEY` in `.kern/.env`. Its presence alone never enables cloud routing. Explicit media/audio overrides are used alone rather than falling back to the main model or another connection.

### Defaults and embedding index lifecycle

| Main provider | Default summary | Default embedding |
|---------------|-----------------|-------------------|
| Hosted `openai` | `gpt-6-luna` | `text-embedding-3-small` |
| Hosted `anthropic` | `claude-haiku-5`, native Anthropic | none — explicitly configure another embedding provider |
| Hosted `openrouter` | `google/gemini-3.5-flash-lite` | `openai/text-embedding-3-small` |
| Default `ollama` endpoint | main model | `nomic-embed-text` |
| Custom endpoint | main model | none — explicitly configure `embeddingModel` |

For embeddings, an object may also include `dimensions`, a positive integer requested from models that support it. Kern validates the actual output size. Models that do not support this option should omit it.

Startup logs resolved model routes and probes the embedding endpoint with one real request (60-second timeout, no automatic retries). Failed probes preserve existing vectors and metadata, disable embedding work for that process, and log the actual failure. Fix the endpoint and restart to resume.

The vector index records the model, requested dimensions, and actual output dimensions as a fingerprint; moving the same model to another endpoint keeps existing vectors. A successful probe for a changed fingerprint rebuilds vectors, including existing chunks from inactive sessions, while preserving messages, chunk text, segment boundaries, summaries, and recall/segment cursors. Backfill restores existing vectors; subsequent indexing embeds only new history. Credential rotation or an endpoint change alone does not rebuild memory. Legacy databases without a fingerprint adopt it when their dimensions match the probed model; upgrading alone never re-embeds. No database deletion is needed when changing models.

### Migrating from earlier configuration

Kern runs one-time file migrations before startup and before reconfiguring an existing agent. A missing `version` means legacy configuration. Migration versions are package release versions; the stamp advances only after a migration succeeds. An agent stamped by a newer package cannot be opened by an older package.

The first migration (`0.43.0-next`) moves legacy `OPENAI_BASE_URL` and `OLLAMA_BASE_URL` settings into JSON `baseURL`, preserving their endpoint and authentication. A custom OpenAI endpoint gets no `embeddingModel` or `summaryModel`: summaries use the chat model and recall stays off until an embedding model is configured. Ollama endpoints keep `nomic-embed-text`. It makes previously inferred OpenRouter summary routes explicit, including Anthropic background routes. Explicit new connection settings win, valid string references stay strings, and unrelated JSON fields and `.env` entries are retained. Legacy endpoint environment variables are consulted only during this one-time migration; subsequent routing uses JSON or the supported `KERN_*` overrides.

Each run creates a verified snapshot in `.kern/backups/<old-version-or-legacy>-<timestamp>-<suffix>/` before replacing any target file. Snapshots contain the exact original bytes of every changed existing file and a `manifest.json` recording which files existed. They have restricted permissions and are gitignored, including for agents created before the new template. Files are staged and validated before replacement; `config.json` is replaced last so its version marks completion. On a write failure, Kern restores files already replaced and aborts startup. If restoration also fails, the error names the backup and files to restore. Migrations must accept partially migrated files so retrying after process interruption is safe.

The existing live-PID check runs before migration. If the agent is already running under another process, stop it before upgrading or reconfiguring. This reuses Kern's existing guard and does not add a separate lock. `loadConfig()` remains read-only. Database and embedding-index migrations retain their own lifecycle.

After automatic conversion, review these intentional behavior changes:

1. Set `embeddingModel` to the model actually hosted by a custom server, or to `false` to silence the startup warning. The migration does not guess which model is installed.
2. Configure `audioModel` explicitly for cross-provider audio. An OpenRouter key no longer adds a cloud fallback automatically.
3. Fresh Anthropic agents use native Anthropic summaries and require an explicit external embedding connection. Migrated agents keep their explicit old OpenRouter routes; change them if you prefer native summaries.

To restore manually, stop Kern, copy each backed-up file listed as `existed: true` in `manifest.json` into `.kern/`, and remove any target listed as `existed: false`. Use a package compatible with the restored configuration, or fix the migration error before restarting. Keep the entire snapshot together, especially when both config and `.env` changed. See [adding migrations](migrations.md) for contributor guidance.

`kern init` offers connection, embedding model, and manual model-ID selection. Reconfiguration preserves other JSON fields and existing `.env` variables/comments. You can edit JSON directly for advanced overrides.

## Environment variable overrides

Environment variables override matching `config.json` fields. Useful for Docker deployments where config is passed via environment.

| Env var | Config field | Type |
|---------|-------------|------|
| `KERN_NAME` | `name` | string |
| `KERN_PORT` | `port` | number |
| `KERN_MODEL` | `model` | string |
| `KERN_PROVIDER` | `provider` | string |
| `KERN_BASE_URL` | `baseURL` | string |
| `KERN_EMBEDDING_MODEL` | `embeddingModel` | string |
| `KERN_SUMMARY_MODEL` | `summaryModel` | string |

Env vars take priority over `config.json`. Overrides are logged on startup.

## Per-agent: .kern/.env

Secrets. Gitignored. Never committed. Values here override inherited environment variables — the agent's own `.env` is authoritative, so don't set the same variable in both.

```
OPENROUTER_API_KEY=sk-or-...
# LOCAL_MODEL_API_KEY=...  # optional: referenced by apiKeyEnv in config.json
# Endpoint URLs belong in config.json as baseURL
SEARXNG_URL=http://searxng:8080
JINA_API_KEY=jina_...
TELEGRAM_BOT_TOKEN=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
DISCORD_TOKEN=your-discord-bot-token
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_USER_ID=@myagent:example.com
MATRIX_ACCESS_TOKEN=syt_...
NOSTR_NSEC=nsec1...
# NOSTR_RELAYS=wss://relay.example.com  # optional: overrides nostrRelays config
# IRC_URL=ircs://myagent@irc.example.com:6697/#homelab  # optional: overrides irc config
KERN_AUTH_TOKEN=...
```

Only set the API keys for providers/interfaces you use.

**`SEARXNG_URL`** — URL of a self-hosted [SearXNG](https://github.com/searxng/searxng) instance with JSON API enabled. When set, `websearch` tool uses SearXNG as primary search provider with DuckDuckGo as fallback.

**`JINA_API_KEY`** — Optional [Jina Reader](https://jina.ai/reader/) API key. The `webfetch` tool uses Jina Reader as the primary provider for converting URLs to markdown. Without a key: 20 RPM (IP rate-limited). With a free key: 500 RPM. Falls back to local Turndown conversion on failure.

### Auth tokens

**`KERN_AUTH_TOKEN`** — per-agent Bearer token required on all agent API endpoints (except `/health`).

- Auto-generated on first agent start — written to `.kern/.env` automatically
- The TUI reads it from the agent's `.kern/.env` automatically
- The web UI asks for it when you add the agent in the sidebar

You never need to set it manually unless you want a specific value.

## No global config

There is no `~/.kern/config.json`. The only configuration kern reads is `<agent>/.kern/config.json` and `<agent>/.kern/.env`. The web daemon's port and host are command flags (`kern web start --port 8080 --host 0.0.0.0`); see [docs/cli.md](cli.md#kern-web-runstartstatusstop---port-p---host-h).

## .kern/ local files

Local files (sessions, database, logs) live in `.kern/` and are gitignored.
