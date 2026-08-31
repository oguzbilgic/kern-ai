# Configuration

## Per-agent: .kern/config.json

The main config file. Committed to git. Unknown fields and wrong types are warned on startup and ignored — defaults apply.

```json
{
  "model": "anthropic/claude-opus-4.8",
  "provider": "openrouter",
  "toolScope": "full"
}
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `name` | directory name | Agent name. Auto-set to directory basename on first startup if missing. Exposed in `/status` response. |
| `model` | `anthropic/claude-opus-4.8` | Model ID. Format depends on provider. |
| `provider` | `openrouter` | API provider: `openrouter`, `anthropic`, `openai`, `ollama` |
| `toolScope` | `full` | Tool access level: `full`, `write`, `read` |
| `maxSteps` | `30` | Max tool-use steps per message |
| `port` | auto | Fixed port for the agent HTTP server. Assigned automatically from 4100-4999 on creation or first start. |
| `maxContextTokens` | `100000` | Token budget for context window. Messages beyond this are trimmed oldest-first. Full history stays in session JSONL files. |
| `maxToolResultChars` | `20000` | Max characters per tool result in context. Oversized results are truncated in context only. Full results stay in session storage. Set to `0` to disable. |
| `telegramTools` | `false` | Show tool call progress lines (⚙ bash, etc.) in Telegram messages. |
| `heartbeatInterval` | `60` | Minutes between heartbeat prompts. Agent reviews notes, updates knowledge. 0 to disable. |
| `timezone` | `""` | IANA timezone (e.g. `"America/Los_Angeles"`) used for the `time:` field in the envelope the model reads. Empty = autoresolve to host. Storage (logs, recall, session metadata) stays UTC regardless. |
| `recall` | `true` | Enable recall and segments (embedding-based features). Set to `false` to disable. Requires an embedding API key. Session storage and notes summaries work regardless. |
| `summaryBudget` | `0.75` | Fraction of `maxContextTokens` for compressed conversation summaries from segments. Cached via prompt caching, so effectively free for supported models. Set to `0` to disable. See [Context](context.md#conversation-summary). |
| `summaryModel` | `""` | Model for segment summarization. Empty = provider default (OpenAI: `gpt-4.1-mini`, Anthropic: `anthropic/claude-haiku-4.5` via OpenRouter, OpenRouter: `openai/gpt-4.1-mini`, Ollama: reuses `model`). Summary calls always use an OpenAI-compatible client: `openai` and `ollama` route directly, **all other providers (including `anthropic`) route via OpenRouter** — so on an Anthropic agent `summaryModel` needs an OpenRouter-style ID like `"anthropic/claude-haiku-4.5"`, not a bare Anthropic model ID. Exception: on `ollama` and `openai` agents, a namespaced `summaryModel` (contains `/`, e.g. `"openai/gpt-4.1-mini"`) routes via OpenRouter when `OPENROUTER_API_KEY` is set — lets local-model agents offload summaries to a cheap cloud model. Ollama `hf.co/...` IDs stay local. Useful when the main `model` is a thinking model — thinking burns the summary token budget on reasoning and returns empty text. Set this to a non-thinking model (e.g. `"openai/gpt-4.1-mini"` on OpenRouter/Anthropic, `"qwen3:4b-instruct"` on Ollama). |
| `subAgentModel` | `""` | Model for spawned sub-agents, on the parent's provider. The model ID must be valid for that provider — same format as `model` (e.g. `claude-haiku-4-5` on `anthropic`, `anthropic/claude-haiku-4.5` on `openrouter`). Empty = inherit the parent's `model`. Sub-agents are read-only and bounded, so a cheaper model usually suffices — in heavy research fan-out they can account for most of the token volume. Individual `spawn` calls can override per-child. |
| `autoRecall` | `false` | Automatically inject relevant old context before each turn. Requires recall enabled. |
| `mediaDigest` | `true` | Enable media pre-digest: describes images (vision model) and transcribes audio (audio model) on arrival, caches results, and replaces raw media with text in context. Set to `false` to disable the entire digest pipeline. |
| `mediaModel` | `""` | Vision model for media descriptions. Fallback chain: `mediaModel` → agent model → hardcoded provider default. Example: `"openai/gpt-4.1-mini"`. |
| `audioModel` | `""` | Audio-capable model for the `audio` tool and voice-message transcription at ingest. Fallback chain: `audioModel` → agent model → provider default (`google/gemini-3.7-flash` on OpenRouter, `gpt-audio-mini` on OpenAI) → `google/gemini-3.7-flash` via OpenRouter for anthropic/ollama/openai agents with `OPENROUTER_API_KEY` set. Setting this field skips the (usually failing) attempt on the text-only chat model. |
| `mediaContext` | `0` | How many recent turns resolve raw media Buffers to the model. `0` = never send raw binary (text descriptions or placeholders only). Applies to all media types — useful for non-image files like PDFs on models with native support. |
| `mcpServers` | `{}` | Model Context Protocol servers. Tools namespaced as `<server>__<tool>`. See [MCP](mcp.md). |

### Tool scopes

- **full** — bash, read, write, edit, glob, grep, webfetch, websearch, kern, message, recall, pdf, image, audio
- **write** — read, write, edit, glob, grep, webfetch, websearch, kern, message, recall, pdf, image, audio
- **read** — read, glob, grep, webfetch, websearch, kern, recall, pdf, image, audio

### Providers

- **openrouter** — routes to cheapest provider. Model IDs like `anthropic/claude-opus-4.8`. Uses OpenAI-compatible chat completions API.
- **anthropic** — direct Anthropic API. Model IDs like `claude-opus-4-8`.
- **openai** — OpenAI or any OpenAI-compatible endpoint. Model IDs like `gpt-5.5`. Set `OPENAI_BASE_URL` in `.env` to route to Azure OpenAI, LiteLLM, or other compatible gateways (default: `https://api.openai.com/v1`). With a custom base URL, requests use the Chat Completions API.
- **ollama** — local Ollama server. Model IDs match Ollama model names like `gemma4:31b`. Set `OLLAMA_BASE_URL` in `.env` for remote servers (default: `http://localhost:11434`).

### Summary model

Segment summarization uses a cheap chat model chosen automatically per provider:

| Provider | Summary model |
|----------|--------------|
| `openai` | `gpt-4.1-mini` |
| `anthropic` | `anthropic/claude-haiku-4.5` (via OpenRouter — needs `OPENROUTER_API_KEY`) |
| `openrouter` | `openai/gpt-4.1-mini` |
| `ollama` | reuses the agent's chat model (no extra model to pull) |

### Embedding model

Recall and segment boundary detection use an embedding model chosen automatically per provider:

| Provider | Embedding model |
|----------|-----------------|
| `openai` | `text-embedding-3-small` |
| `anthropic` | `openai/text-embedding-3-small` (via OpenRouter — Anthropic has no embeddings API) |
| `openrouter` | `openai/text-embedding-3-small` |
| `ollama` | `nomic-embed-text` |

## Environment variable overrides

Environment variables override matching `config.json` fields. Useful for Docker deployments where config is passed via environment.

| Env var | Config field | Type |
|---------|-------------|------|
| `KERN_NAME` | `name` | string |
| `KERN_PORT` | `port` | number |
| `KERN_MODEL` | `model` | string |
| `KERN_PROVIDER` | `provider` | string |

Env vars take priority over `config.json`. Overrides are logged on startup.

## Per-agent: .kern/.env

Secrets. Gitignored. Never committed. Values here override inherited environment variables — the agent's own `.env` is authoritative, so don't set the same variable in both.

```
OPENROUTER_API_KEY=sk-or-...
# OPENAI_BASE_URL=https://my-litellm-gateway.example.com/v1  # optional: route openai provider to a compatible endpoint
OLLAMA_BASE_URL=http://localhost:11434
SEARXNG_URL=http://searxng:8080
JINA_API_KEY=jina_...
TELEGRAM_BOT_TOKEN=...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
MATRIX_HOMESERVER=https://matrix.example.com
MATRIX_USER_ID=@myagent:example.com
MATRIX_ACCESS_TOKEN=syt_...
KERN_AUTH_TOKEN=...
```

Only set the API keys for providers/interfaces you use.

**`SEARXNG_URL`** — URL of a self-hosted [SearXNG](https://github.com/searxng/searxng) instance with JSON API enabled. When set, `websearch` tool uses SearXNG as primary search provider with DuckDuckGo as fallback.

**`JINA_API_KEY`** — Optional [Jina Reader](https://jina.ai/reader/) API key. The `webfetch` tool uses Jina Reader as the primary provider for converting URLs to markdown. Without a key: 20 RPM (IP rate-limited). With a free key: 500 RPM. Falls back to local Turndown conversion on failure.

### Auth tokens

**`KERN_AUTH_TOKEN`** — per-agent Bearer token required on all agent API endpoints (except `/health`).

- Auto-generated on first agent start — written to `.kern/.env` automatically
- TUI and web proxy read it from the agent's `.kern/.env` automatically
- Web proxy injects it into proxied requests — the browser never sees agent tokens

**`KERN_PROXY_TOKEN`** — proxy auth token stored in `~/.kern/.env`.

- Auto-generated on first `kern proxy start`
- Required on all `/api/*` proxy routes (Bearer header or `?token=` query param)
- Printed by `kern proxy start` and `kern proxy token`
- Legacy `KERN_WEB_TOKEN` also accepted as fallback

You never need to set either token manually unless you want specific values.

## Global: ~/.kern/config.json

Global settings and agent registry. Optional — defaults apply if the file doesn't exist.

```json
{
  "web_port": 8080,
  "proxy_port": 9000,
  "agents": ["/home/user/my-agent"]
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `web_port` | `8080` | Port for the `kern web` static file server. |
| `proxy_port` | `9000` | Port for the `kern proxy` authenticated reverse proxy. |
| `agents` | `[]` | List of registered agent directory paths. Managed automatically by `kern init` and `kern start`. |

## .kern/ local files

Local files (sessions, database, logs) live in `.kern/` and are gitignored.
