# kern

Coworker agents that live in your chat.

kern runs an agent as a long-lived process with one persistent memory, reachable on Slack, Matrix, Telegram, Discord, IRC, and Nostr. Give it a job title, a container, and a bot account. It remembers what happened months ago, runs long jobs in the background, delegates research to sub-agents, and reports back in the channel where the work was asked for.

No dashboards to host, no ports to expose. A fleet is a set of containers, each one a coworker in your workspace.

![kern](https://kern-ai.com/images/agent-intranet.png)

## Why kern

- **One brain, every channel** — Slack, Matrix, Telegram, Discord, IRC, Nostr, and the terminal all feed one session. The agent knows who is talking, which room it is in, and what was said 10,000 messages ago.
- **Memory like a coworker** — conversations are segmented by topic, summarized into a hierarchy, and compressed into context. Semantic recall over everything. Notes and knowledge files live in a git repo the agent maintains. It gets better the longer it runs.
- **Does the work** — shell, files, web, PDFs, images, audio. Long commands run as background jobs and the agent keeps talking. Sub-agents fan out research in parallel. Skills and MCP servers extend what it can do.
- **Reports back where it was asked** — a background job started from `#builds` finishes in `#builds`. A sub-agent spawned from a Telegram DM answers in that DM. No polling, no lost results.
- **A fleet is just containers** — one image, one volume per agent, one bot account per agent. Ten agents on Slack with ten job titles is ten `docker run` lines.
- **Your infra, your data** — runs on your laptop, server, or homelab. Pay only for API tokens, or use Ollama for local inference.

kern pairs with [agent-kernel](https://github.com/oguzbilgic/agent-kernel) — the kernel defines how an agent remembers, kern runs it.

## Quick start

Put an agent on Slack:

```bash
docker run -d --restart=unless-stopped \
  --name ops \
  -v ops-home:/home/agent \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e SLACK_BOT_TOKEN=xoxb-... \
  -e SLACK_APP_TOKEN=xapp-... \
  ghcr.io/oguzbilgic/kern-ai
```

Or on Telegram:

```bash
docker run -d --restart=unless-stopped \
  --name ops \
  -v ops-home:/home/agent \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e TELEGRAM_BOT_TOKEN=123456:ABC-... \
  ghcr.io/oguzbilgic/kern-ai
```

Message the bot. The first person to DM it is paired as its operator. Everyone else gets a `KERN-XXXX` pairing code to hand to the operator.

On first run the agent saves its config and credentials into the volume. Every run after that needs no environment variables:

```bash
docker run -d --restart=unless-stopped -v ops-home:/home/agent ghcr.io/oguzbilgic/kern-ai
```

The volume holds everything: sessions, memory, notes, knowledge, and whatever the agent installs for itself (`npm install -g`, `pip install`, SSH keys, dotfiles). See [Docker docs](docs/docker.md) for every variable and provider.

The agent's display label is its directory basename (`workspace` in the default Docker image), not the container name. Use a [custom workspace directory](docs/docker.md#custom-workspace-directory) to choose a different label.

## Running a team

Each agent is a directory with a `.kern/` folder, so each agent is a container with its own volume and bot account. Name them after the job:

```yaml
services:
  ops:
    image: ghcr.io/oguzbilgic/kern-ai
    restart: unless-stopped
    volumes: ["ops-home:/home/agent"]
    command: ["kern", "run", "--init-if-needed", "/home/agent/ops"]
    environment:
      OPENROUTER_API_KEY: sk-or-...
      SLACK_BOT_TOKEN: xoxb-...
      SLACK_APP_TOKEN: xapp-...

  research:
    image: ghcr.io/oguzbilgic/kern-ai
    restart: unless-stopped
    volumes: ["research-home:/home/agent"]
    command: ["kern", "run", "--init-if-needed", "/home/agent/research"]
    environment:
      OPENROUTER_API_KEY: sk-or-...
      SLACK_BOT_TOKEN: xoxb-...
      SLACK_APP_TOKEN: xapp-...

volumes:
  ops-home:
  research-home:
```

Docker owns the process lifecycle. Restarts, logs, and resource limits are Docker's job, not kern's. Agents in the same workspace can see each other in shared channels and are told to keep quiet unless addressed, so they do not talk in loops.

## Working in chat

**Background jobs.** Long commands run detached and the agent keeps working. When the job ends, its exit code and output tail arrive in the conversation that started it, and the agent's reply goes back there.

```
[via slack, #builds, user: U04ABC, time: 2026-09-22T15:04:05-07:00]
[job:job_a1b2c3d4 exited 0, 42s] npm test
```

Opt in to `remindEvery` and the agent gets a periodic nudge so it can tail or kill a job that has stalled. `/jobs` lists them.

**Sub-agents.** `spawn` hands a bounded, read-only task to a child that runs its own loop. Results announce back into the originating chat. Run several in parallel and synthesize as they land. A cheaper `subAgentModel` keeps fan-out affordable.

**Heartbeat.** On a schedule the agent wakes up, reviews its notes, updates its knowledge files, and messages the operator if something needs attention.

**Chat commands.** `/status`, `/wyd` (what are you doing right now), `/jobs`, `/subagents`, `/skills`, `/mcp`, `/plugins`, `/restart`, `/help`. Prefix with `!` on networks that reserve `/`. See [chat commands](docs/chat-commands.md).

**Platform tools.** The agent can read channel history, react, pin, list rooms, and manage its own presence on Slack, Matrix, Telegram, Discord, and IRC. It can register its own IRC nick or Nostr identity using bundled skills.

**Voice.** Send a voice note and the agent transcribes it. Reply comes back as a voice note.

## Memory

Conversations are automatically segmented by topic, summarized, and rolled up into a hierarchy (L0 → L1 → L2). When old messages fall out of context, compressed summaries take their place, so the agent sees its full history at decreasing resolution. Semantic recall searches everything.

Alongside that, the agent keeps plain text in a git repo it maintains itself:

- `knowledge/` — mutable facts about how things are right now
- `notes/` — append-only daily logs of what happened and what was decided
- `USERS.md` — who it has met, on which channel, and what they are allowed to see

The latest daily note and a rolling summary of the last five are injected on every message. The agent boots already knowing what happened recently.

Offline health and repair scripts (`recall-health`, `segment-health`, `segment-prune`, `recall-repair`) keep the memory database honest on long-running agents.

[Memory docs](docs/memory.md) · [Context & segments](docs/context.md) · [Blog: Lossless context management](https://kern-ai.com/blog/lossless-context-management)

## Interfaces

| Interface | Setup |
|-----------|-------|
| **Slack** | `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` |
| **Matrix** | `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN` |
| **Telegram** | `TELEGRAM_BOT_TOKEN` |
| **Discord** | `DISCORD_TOKEN` |
| **IRC** | `IRC_URL` (`ircs://nick:pass@host:6697/#channel`) |
| **Nostr** | `NOSTR_NSEC` — DM the agent's npub from any Nostr client |
| **Terminal** | `kern tui` |

Set these in `.kern/.env` or pass them as environment variables to the container. All of them feed the same session: ask on Telegram, follow up in Slack, and the agent remembers both.

```
Slack ────────┐
Matrix ───────┤
Telegram ─────┤── one session
Discord ──────┤
IRC ──────────┤
Nostr ────────┘
```

Every message carries an envelope (`[via slack, #ops, user: U04ABC, time: ...]`) so the agent knows who is talking and where. DMs are gated by pairing. Shared rooms are open, and the agent stays quiet unless addressed.

[Interfaces docs](docs/interfaces.md) · [Pairing](docs/pairing.md) · [Blog: Why your agent needs one session](https://kern-ai.com/blog/why-your-agent-needs-one-session)

## Sharing artifacts

Agents that live in chat do not need a public port. They share files through the channel's own upload, and larger artifacts (reports, tables, live pages) through a paste or hosting service. Matrix agents can pin a hosted page as a room widget.

If you do want a browser, `kern web` serves a UI with a memory inspector and agent-served dashboards. Reach the agent's port through a tunnel or LAN. See [Dashboards](docs/dashboards.md) and [Clients](docs/clients.md).

## Local development

```bash
npm install -g kern-ai
kern init my-agent/
kern tui my-agent/
```

An agent is a directory containing `.kern/`. Every command takes an optional `[path]`, defaulting to the current directory.

```bash
kern init [path]          # create or configure an agent
kern start [path]         # start the agent in the background
kern stop [path]          # stop the agent
kern restart [path]       # restart the agent
kern status [path]        # show the agent status
kern tui [path]           # interactive chat
kern logs [path]          # follow agent logs
kern backup [path]        # backup agent to .tar.gz
kern scripts <name>       # offline memory diagnostics and repair
```

Non-interactive: `kern init my-agent/ --api-key sk-or-...`. Ollama: `kern init my-agent/ --provider ollama --api-key http://localhost:11434 --model gemma4:31b`.

[CLI docs](docs/cli.md) · [Get started](docs/get-started.md)

## Configuration

### `.kern/config.json`

```json
{
  "model": "google/gemini-3.8-flash",
  "provider": "openrouter",
  "toolScope": "full",
  "heartbeatInterval": 60,
  "maxContextTokens": 100000,
  "summaryBudget": 0.75
}
```

### Tool scopes

- **full** — shell and background jobs, read, write, edit, glob, grep, webfetch, websearch, pdf, image, audio, kern, message
- **write** — everything except shell
- **read** — read-only tools

Plugins add their own tools on top: recall, spawn and subagents, render, MCP servers, and the platform tools for Slack, Matrix, Telegram, Discord, and IRC.

### Providers

| Provider | Description |
|----------|-------------|
| **openrouter** | Any model via OpenRouter (default) |
| **anthropic** | Direct Anthropic API |
| **openai** | OpenAI, Azure, or any OpenAI-compatible endpoint via `OPENAI_BASE_URL` |
| **ollama** | Local models via [Ollama](https://ollama.com) |

Set `model` for chat. `summaryModel`, `subAgentModel`, and `mediaModel` can point cheaper models at background work. See [docs/config.md](docs/config.md).

## Documentation

- [Docker](docs/docker.md)
- [Get started](docs/get-started.md)
- [Configuration](docs/config.md)
- [Architecture](docs/architecture.md)
- [Interfaces](docs/interfaces.md)
- [Pairing](docs/pairing.md)
- [Memory](docs/memory.md)
- [Context & segments](docs/context.md)
- [Tools](docs/tools.md)
- [Sub-agents](docs/subagents.md)
- [Skills](docs/skills.md)
- [MCP](docs/mcp.md)
- [Media](docs/media.md)
- [Chat commands](docs/chat-commands.md)
- [CLI commands](docs/cli.md)
- [Offline scripts](docs/scripts.md)
- [Prompt caching](docs/caching.md)
- [Dashboards](docs/dashboards.md)
- [Clients](docs/clients.md)

## Built with

- [Vercel AI SDK](https://sdk.vercel.ai) — model-agnostic AI layer
- [grammY](https://grammy.dev) — Telegram
- [@slack/bolt](https://slack.dev/bolt-js) — Slack
- [discord.js](https://discord.js.org) — Discord
- [nostr-tools](https://github.com/nbd-wtf/nostr-tools) — Nostr
- [agent-kernel](https://github.com/oguzbilgic/agent-kernel) — the memory pattern

## License

MIT
