# Architecture

How kern's processes fit together.

## Overview

```
Browser ──→ agent A (:4100)              # direct connection
Browser ──→ kern web (:8080)             # static files only

TUI ──────────────────────────→ agent A (:4100)
Telegram ←────────────────────→ agent A (long poll)
Slack ←───────────────────────→ agent A (socket mode)
Matrix ←──────────────────────→ agent A (/sync long poll)
```

Each agent is a separate process. `kern web` serves the UI as static files. Browsers connect directly to agents.

An agent is a directory containing `.kern/`. There is no registry and no global config file: every CLI command takes a `[path]` (default `.`) and reads everything it needs from `<path>/.kern/`.

## Agent process

`kern start [path]` launches the agent in `path` as a background daemon (`kern run [path]` runs it in the foreground). Each agent process:

- Binds an HTTP server to `0.0.0.0` on a **sticky port** (picked from 4100-4999 by live bind checking on first start, saved to `.kern/config.json`). If the sticky port is busy at startup, the agent picks a fresh one, saves it, and logs `port :4100 in use, reassigned :4101`. A port set with `KERN_PORT` is never reassigned.
- Writes its PID to its own `.kern/agent.pid`
- Connects to Telegram (long polling), Slack (socket mode), and/or Matrix (`/sync` long poll) if tokens are configured
- Runs the message queue, tool executor, and model calls
- Serves SSE for real-time streaming to connected clients (TUI, web UI)

Agents bind to `0.0.0.0` so they're reachable over the network (e.g. via Tailscale). Clients connect directly with the agent's port and token.

### Agent HTTP endpoints

The TUI and the web UI connect to these directly.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/events` | GET | SSE stream (messages, tool calls, status) |
| `/message` | POST | Send a message to the agent |
| `/status` | GET | Agent status, model, uptime, token counts |
| `/history` | GET | Message history with pagination |
| `/health` | GET | Liveness check |
| `/segments` | GET | Semantic segment data |
| `/segments/rebuild` | POST | Trigger segment re-indexing |
| `/context/system` | GET | Full composed system prompt |
| `/context/segments` | GET | Segments currently in context |
| `/sessions` | GET | Session list with current session ID |
| `/recall/stats` | GET | Recall index stats |
| `/commands` | GET | Available slash commands (builtins + plugins) |
| `/skills` | GET | Skill catalog with active status |
| `/skills/:name` | GET | Skill detail including full body |

### Auth

Each agent generates a random token on first start, stored in `.kern/.env` as `KERN_AUTH_TOKEN`. Every request must include `Authorization: Bearer <token>`. The TUI reads the token from the agent's `.kern/.env` file.

## Web server

`kern web` launches a minimal static file server (`--port`, default 8080; `--host`, default `0.0.0.0`). It serves only the web UI static files — no auth, no proxy, no agent discovery. Connect to agents directly from the sidebar by entering their URL and token. Use `kern web run` for foreground mode (Docker) or `kern web start` to daemonize; `start` records `{ pid, port, host }` in `~/.kern/web.json`.

## TUI

`kern tui [path]` connects directly to an agent's HTTP server. It reads the agent's port and token from `<path>/.kern/`, opens an SSE connection for streaming, and sends messages via POST. It's a direct localhost connection. When the connection drops (for example after `/restart`), it re-reads the port from `<path>/.kern/` before reconnecting.

## Telegram, Slack & Matrix

These run inside the agent process itself — not separate services.

- **Telegram**: grammY bot with long polling. No incoming port needed.
- **Slack**: Bolt with Socket Mode. No incoming port needed.
- **Matrix**: `/sync` long poll against a Matrix homeserver (Synapse, Dendrite, etc.). No incoming port needed.

All inject messages into the same queue as TUI and web. The agent doesn't know or care which interface a message came from — it sees metadata tags like `[via telegram, user: oguz]`. See [docs/interfaces.md § Metadata contract](interfaces.md#metadata-contract) for the full metadata surfaces (text prefix, internal message object, SSE events) and per-interface field mappings.

### The envelope is the contract

Every message reaching the model — from humans on any interface, from heartbeat timers, from sub-agent announces — is prefixed with the same metadata envelope: `[via <interface>, <channel>, user: <id>, time: <iso8601>]`. This uniformity is what makes multi-channel unification work: the agent reads one message stream, decides based on envelope metadata who's talking and how to respond, and trusts the runtime to route replies back to the right place. New interfaces and internal message sources just need to produce valid envelopes; everything downstream is already wired.

## File layout

```
~/.kern/                 # runtime state only, never configuration
  web.json             # web daemon { pid, port, host }
  web.log              # web daemon log
  backups/             # kern backup output

~/my-agent/              # an agent is any directory containing .kern/
  .kern/
    config.json        # agent config (model, provider, port, toolScope)
    .env               # API keys, bot tokens, KERN_AUTH_TOKEN
    agent.pid          # PID file (written on start, removed on stop)
    sessions/          # conversation JSONL
    recall.db          # memory database (embeddings, segments, summaries)
    logs/              # structured logs
  AGENTS.md            # agent behavior
  IDENTITY.md          # agent identity
  KNOWLEDGE.md         # knowledge index
  USERS.md             # users and channels encountered
  knowledge/           # mutable state files
  notes/               # daily logs
```

## Port summary

| Process | Binds to | Port | Accessible from |
|---------|----------|------|-----------------|
| Agent | 0.0.0.0 | 4100-4999 | sticky, auto-assigned |
| Web server | 0.0.0.0 (`--host`) | 8080 (`--port`) | LAN / Tailscale |
| Telegram | outbound only | — | — |
| Slack | outbound only | — | — |
| Matrix | outbound only | — | — |
