# Architecture

How kern's processes fit together.

## Overview

```
Browser ──→ agent A (:4100)              # direct connection
Browser ──→ kern proxy (:9000) ──→ agent A (:4100)   # via proxy
                                 ├─→ agent B (:4101)
                                 └─→ agent C (:4102)
Browser ──→ kern web (:8080)             # static files only

TUI ──────────────────────────→ agent A (:4100)
Telegram ←────────────────────→ agent A (long poll)
Slack ←───────────────────────→ agent A (socket mode)
Matrix ←──────────────────────→ agent A (/sync long poll)
```

Each agent is a separate process. `kern web` serves the UI as static files. `kern proxy` is an optional authenticated reverse proxy for multi-agent access. Browsers can connect directly to agents or through the proxy.

## Multi-Agent Host Architecture

kern operates in two modes depending on machine configuration:

1. **System-Managed Multi-User Fleet (`/etc/kern/config.json`)**:
   - For dedicated Linux servers and VMs running multiple agents (e.g. `agents.homelab`).
   - Declares agents with isolated Linux user accounts: `agents: [{ user: "alice", workspace: "/home/alice/workspace" }]`.
   - Fleet lifecycle commands (`start`, `stop`, `restart`, `remove`, `init`, `install`, `uninstall`) must be executed by `root`.
   - `kern start` drops privileges to each declared agent user (`uid`/`gid`/`HOME`).
   - Supervised via a single system-wide template unit: `/etc/systemd/system/kern@.service`, running instances as `kern@<user>`.
2. **Single-User Environment (`~/.kern/config.json`)**:
   - For dev laptops, macOS workstations, and single-container Docker environments.
   - All agents run under the current user's privileges with workspace paths in `agents: ["/path/to/agent"]`.
   - Optional user-level systemd supervision via `~/.config/systemd/user/kern-agent-<name>.service`.

## Agent process

`kern start` launches an agent as a background daemon. Each agent process:

- Binds an HTTP server to `0.0.0.0` on a **sticky port** (auto-assigned from 4100-4999 on first start, saved to config)
- Registers its path in `~/.kern/config.json` and writes PID to its own `.kern/agent.pid`
- Connects to Telegram (long polling), Slack (socket mode), and/or Matrix (`/sync` long poll) if tokens are configured
- Runs the message queue, tool executor, and model calls
- Serves SSE for real-time streaming to connected clients (TUI, web UI)

Agents bind to `0.0.0.0` so they're reachable over the network (e.g. via Tailscale). The proxy is optional — clients can connect directly if they have the agent's port and token.

### Agent HTTP endpoints

These are internal — the web proxy forwards to them, TUI connects directly.

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

Each agent generates a random token on first start, stored in `.kern/.env` as `KERN_AUTH_TOKEN`. Every request must include `Authorization: Bearer <token>`. The TUI and proxy read the token from the agent's `.kern/.env` file.

## Web server

`kern web` launches a minimal static file server (default port 8080, configurable via `web_port` in `~/.kern/config.json`). It serves only the web UI static files — no auth, no proxy, no agent discovery. Connect to agents directly from the sidebar by entering their URL and token. Use `kern web run` for foreground mode (Docker) or `kern web start` to daemonize.

## Proxy server

`kern proxy start` launches an authenticated reverse proxy (default port 9000, configurable via `proxy_port` in `~/.kern/config.json`). It also serves the web UI static files.

It provides:
1. **Agent discovery** — `GET /api/agents` returns all registered agents
2. **Agent proxy** — forwards `/api/agents/:name/*` to the correct agent process with token injection

### Proxy flow

```
Browser → GET /api/agents/vega/status
       → kern proxy reads ~/.kern/config.json agents list
       → finds vega: { port: 4100, token: "abc..." }
       → forwards to 127.0.0.1:4100/status with Authorization header
       → streams response back to browser
```

The proxy injects agent tokens on behalf of the browser, so proxy clients don't need individual agent credentials.

### Proxy auth

**Static files** are served without authentication.

**Proxy routes** (`/api/*`) are protected by `KERN_PROXY_TOKEN` (auto-generated on first `kern proxy start`, stored in `~/.kern/.env`). Also accepts legacy `KERN_WEB_TOKEN`. The token is passed as a Bearer header or `?token=` query param.

**Direct connections** bypass the proxy entirely. The browser connects to the agent's port with `KERN_AUTH_TOKEN`. No proxy needed.

Users add agents or proxy servers from the sidebar UI, entering the URL and token manually.

## Registry

`~/.kern/config.json` is the coordination point. Every agent registers its path on start:

```json
{
  "web_port": 8080,
  "proxy_port": 9000,
  "agents": ["/root/vega", "/home/kern/atlas"]
}
```

The proxy, TUI, and CLI read this file to discover agents, then read each agent's `.kern/` directory for port, token, and PID. `kern list` reads it to show status. PIDs are checked with `kill -0` to detect stale entries.

## TUI

`kern tui [name]` connects directly to an agent's HTTP server — no proxy involved. It reads the agent's port and token from the agent's `.kern/` directory, opens an SSE connection for streaming, and sends messages via POST. It's a direct localhost connection.

## Telegram, Slack & Matrix

These run inside the agent process itself — not separate services.

- **Telegram**: grammY bot with long polling. No incoming port needed.
- **Slack**: Bolt with Socket Mode. No incoming port needed.
- **Matrix**: `/sync` long poll against a Matrix homeserver (Synapse, Dendrite, etc.). No incoming port needed.

All inject messages into the same queue as TUI and web. The agent doesn't know or care which interface a message came from — it sees metadata tags like `[via telegram, user: oguz]`. See [docs/interfaces.md § Metadata contract](interfaces.md#metadata-contract) for the full metadata surfaces (text prefix, internal message object, SSE events) and per-interface field mappings.

### The envelope is the contract

Every message reaching the model — from humans on any interface, from heartbeat timers, from sub-agent announces — is prefixed with the same metadata envelope: `[via <interface>, <channel>, user: <id>, time: <iso8601>]`. This uniformity is what makes multi-channel unification work: the agent reads one message stream, decides based on envelope metadata who's talking and how to respond, and trusts the runtime to route replies back to the right place. New interfaces and internal message sources just need to produce valid envelopes; everything downstream is already wired.

## Service management

`kern install` creates systemd user services for agents, the web server, and the proxy. This gives you:

- Auto-restart on crash
- Start on boot (with lingering enabled)
- Standard `systemctl --user` management

```bash
kern install vega       # install agent as systemd service
kern install --web      # install web server as systemd service
kern install --proxy    # install proxy server as systemd service
kern uninstall vega     # remove service
```

Without `kern install`, agents run as plain daemons managed by PID files.

## File layout

```
~/.kern/
  config.json          # global config + agent registry
  .env                 # KERN_WEB_TOKEN (for proxy auth)
  web.pid              # web server PID

~/my-agent/
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
| Web server | 0.0.0.0 (configurable) | 9000 (configurable) | LAN / Tailscale |
| Telegram | outbound only | — | — |
| Slack | outbound only | — | — |
| Matrix | outbound only | — | — |
