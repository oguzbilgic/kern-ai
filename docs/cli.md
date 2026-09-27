# CLI Commands

The `kern` command-line interface manages agent lifecycles, background daemons, pairing, logs, and backups.

An agent is a directory containing `.kern/`. There is no registry and no global config file: the only configuration kern reads is `<agent>/.kern/config.json` and `<agent>/.kern/.env`. Every agent command takes an optional `[path]`, which defaults to the current directory. Nothing is written outside the agent directory except runtime state under `~/.kern/` (the web daemon's state file and log, and backups).

To run several agents, give each its own directory: `kern start ~/alice`, `kern start ~/bob`, `kern status ~/bob`.

## General

### kern

Show help and available CLI commands.

```bash
kern
```

### kern init [path]

Create a new agent or reconfigure an existing one.

- **Target**: `path` defaults to the current directory. A bare name such as `kern init my-agent` scaffolds into `./my-agent/`.
- **New agent**: interactive wizard asks for name, provider, API key, model, Telegram/Slack tokens. Scaffolds agent-kernel files (`AGENTS.md`, `IDENTITY.md`, `KNOWLEDGE.md`, `USERS.md`), creates `.kern/` config, initializes git, and starts the agent.
- **Existing agent**: if the directory already has `.kern/`, shows current config with masked secrets. Update any field — press enter to keep current value. Restarts automatically after changes.
- **Adopting an existing repo**: if the directory exists but has no `.kern/`, creates only `.kern/` config without overwriting existing `AGENTS.md`, `IDENTITY.md`, etc.
- **Non-interactive mode**: pass `--api-key` to skip prompts. For automation and CI. The agent name is the directory's basename.

```bash
kern init my-agent --api-key sk-or-...
kern init my-agent --api-key sk-ant-... --provider anthropic --model claude-opus-5-5
kern init my-agent --api-key sk-or-... --telegram-token 123:ABC --slack-bot-token xoxb-... --slack-app-token xapp-...
kern init my-agent --provider ollama --api-key http://localhost:11434 --model gemma4:31b
kern init . --api-key sk-or-...          # adopt the current directory
```

Defaults to `openrouter` + `google/gemini-3.8-flash` when flags are used. For Ollama, `--api-key` is the server URL.

---

## Agent Lifecycle

Every command below resolves `[path]` to an absolute directory and requires it to contain `.kern/`. Anything else exits 1 with:

```
Error: no agent in /abs/path (no .kern/ directory). Run 'kern init' there first.
```

### kern start [path]

Start the agent as a background daemon.

- Spawns a detached process with the same `node` binary that runs the CLI (never `node` from `PATH`)
- Writes PID to `<path>/.kern/agent.pid`, logs to `<path>/.kern/logs/kern.log`
- Waits 2 seconds after fork, verifies process is alive; shows the error log if startup fails
- Already running (live PID): prints and exits 0

```bash
kern start            # agent in the current directory
kern start ~/atlas    # agent elsewhere
```

### kern stop [path]

Stop the agent via its PID file. Sends SIGTERM and removes `<path>/.kern/agent.pid`. A stale PID file is cleared.

```bash
kern stop
kern stop ~/atlas
```

### kern restart [path]

Stop then start. 500ms delay between for clean shutdown.

```bash
kern restart ~/atlas
```

### kern run [path]

Run the agent in the foreground (for development, debugging, and Docker). Starts all configured interfaces (Telegram, Slack, Matrix, Discord, IRC, Nostr) in-process.

```bash
kern run
kern run ./my-agent
```

#### --init-if-needed

Auto-scaffolds the agent directory on first start if `.kern/config.json` is missing. Reads `KERN_*` environment variables for configuration — no interactive prompts. Designed for Docker containers starting on empty volumes.

```bash
kern run --init-if-needed /home/agent/workspace
```

Environment variables used during scaffold:
- `KERN_NAME` — agent name (default: directory basename)
- `KERN_MODEL` — model identifier (default: `google/gemini-3.8-flash`)
- `KERN_PROVIDER` — provider name (default: `openrouter`)
- `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_BASE_URL` — written to `.kern/.env`
- `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` — written to `.kern/.env` if set

### Ports

Each agent gets a **sticky port** from 4100–4999, picked by live bind checking on first start and saved to `.kern/config.json`. If that port is busy when the agent starts (for example two agents that were both handed 4100 while stopped), the agent picks a fresh port, saves it, and logs `port :4100 in use, reassigned :4101`. A port set with `KERN_PORT` is never reassigned.

### Removing an agent

Agents are directories; delete the folder to remove one. `kern remove` no longer exists.

---

## Inspection & Interaction

### kern status [path]

Show a single status card for the agent: name, provider/model, port, PID, uptime, tool scope, and mode (`daemon` / `—`).

Aliases: `kern list`, `kern ls`

```bash
kern status
kern status ~/atlas
```

Run in a directory without `.kern/`, it explains where to look. If an old `~/.kern/config.json` from a previous kern version still lists agents, it prints those paths once as a hint and suggests deleting the file; that file is never read for anything else.

Web daemon status is under `kern web status`.

### kern tui [path]

Interactive terminal chat. Connects to the running daemon via HTTP/SSE.

- Auto-starts the daemon if not running
- After a `/restart`, re-reads the port from `<path>/.kern/` and reconnects
- Cross-channel messages visible in real time
- Heartbeat activity visible
- Ctrl-C only exits TUI, daemon stays alive

```bash
kern tui
kern tui ~/atlas
```

### kern logs [path] [-f] [-n N] [--level LEVEL]

Follow agent logs. Structured, leveled, colored output.

- Default: follow mode (like `tail -f`). `-n 50` shows last 50 lines and exits.
- `--level warn` filters to warnings and errors only. Levels: `debug`, `info`, `warn`, `error`.
- Logs stored in `<path>/.kern/logs/kern.log`
- Components: `[kern]` `[queue]` `[runtime]` `[context]` `[telegram]` `[slack]` `[matrix]` `[discord]` `[irc]` `[nostr]` `[server]` `[recall]` `[segments]` `[notes]` `[config]` `[memory]`
- Level labels: `ERR` (red), `WRN` (yellow), `DBG` (dim). Info has no label.

```bash
kern logs -f
kern logs ~/atlas -n 100 --level error
```

### kern pair [path] <code>

Approve a pairing code from the command line. No agent interaction needed. With one argument, `path` is the current directory.

```bash
kern pair KERN-7X4M
kern pair ~/atlas KERN-7X4M
```

---

## Daemons

### kern web <run|start|status|stop> [--port P] [--host H]

Minimal static file server for the web UI. No auth, no proxy, no agent directory needed.

```bash
kern web run                          # run in foreground (for Docker or manual use)
kern web start                        # start as background daemon
kern web start --port 9090 --host 127.0.0.1
kern web status                       # check if running
kern web stop                         # stop daemon
```

- Serves the web UI static files only — no API proxy, no auth
- `--port` defaults to 8080, `--host` to `0.0.0.0`; both apply to `run` and `start` only
- `kern web start` daemonizes: `{ pid, port, host }` recorded in `~/.kern/web.json`, logs in `~/.kern/web.log`; `status` reads that file
- Connect to agents directly from the sidebar (enter URL + token)

### kern proxy, kern install, kern uninstall

Removed. The proxy is gone; `kern install` needs systemd unit management, which returns with fleet mode. Each exits 1 with a message saying so.

---

## Backup & Import

### kern backup [path]

Backup an agent to a `.tar.gz` file.

- Creates `~/.kern/backups/{name}-{date}.tar.gz` from the agent in `path`
- Includes everything: `AGENTS.md`, `IDENTITY.md`, `knowledge/`, `notes/`, `.kern/config.json`, `.kern/sessions/`, `.kern/.env`, `.kern/pairing.json`
- Excludes: `.kern/logs/`
- Agent can be running during backup

```bash
kern backup
kern backup ~/atlas
```

### kern restore <file>

Restore an agent from a backup archive.

- Extracts to `./{agent-name}/` in the current directory
- Registers nothing — the extracted directory is the agent
- If that directory already exists: asks to confirm overwrite
- If the agent there is running: stops it before overwriting

```bash
kern restore ~/.kern/backups/atlas-2026-09-19.tar.gz
```

### kern import opencode

Convert an OpenCode session into a kern JSONL file.

- Finds OpenCode's SQLite database at `~/.local/share/opencode/opencode.db`
- Interactive: prompts to select project and session (skippable via flags)
- Converts messages and tool calls to kern's ModelMessage format
- Validates tool-call/tool-result pairing
- Writes `<uuid>.jsonl` to the current working directory — move it into any agent's `.kern/sessions/` dir yourself

```bash
cd /tmp
kern import opencode                                          # interactive pickers
kern import opencode /root/myproject                          # skip project picker
kern import opencode --project /root/myproject --session <id> # fully non-interactive
mv /tmp/<uuid>.jsonl ~/atlas/.kern/sessions/                  # install wherever
```

Tested against OpenCode v1.3.3.

### kern import openclaw-lcm

Convert an OpenClaw Lossless Context Memory (LCM) database into a kern JSONL file.

- Reads any `lcm.db` file path you give it
- `--list` prints all conversations in the DB with row counts and date ranges
- Picks the primary conversation (`agent:main:main`) by default; pass `--conversation <id>` to target another
- Normalizes OpenClaw runtime injections (preambles, heartbeats, system-exec events, queued-message blocks) into kern-native bracketed prefixes
- Writes `<uuid>.jsonl` to the current working directory

```bash
cd /tmp
kern import openclaw-lcm /path/to/lcm.db --list                # list conversations
kern import openclaw-lcm /path/to/lcm.db                       # main conversation
kern import openclaw-lcm /path/to/lcm.db --conversation 4      # specific conversation
scp /tmp/<uuid>.jsonl dockerhost:~/agent/.kern/sessions/       # install remotely
```

Tested against lossless-claw v0.9.1. Older LCM DBs may fall through to flat message content or error on missing columns.
