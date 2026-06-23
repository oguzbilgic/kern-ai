# Commands

## kern

Show help and available commands.

## kern init \<name\>

Create a new agent or reconfigure an existing one.

**New agent**: interactive wizard asks for provider, API key, model, Telegram/Slack tokens. Scaffolds agent-kernel files (AGENTS.md, IDENTITY.md, KNOWLEDGE.md, USERS.md), creates `.kern/` config, initializes git, registers in `~/.kern/config.json`, and starts the agent.

**Existing agent**: detects by name or path. Shows current config with masked secrets. Update any field — press enter to keep current value. Restarts automatically after changes.

**Adopting an existing repo**: if the directory exists but has no `.kern/`, creates only `.kern/` config without overwriting existing AGENTS.md, IDENTITY.md, etc.

**Non-interactive mode**: pass `--api-key` to skip prompts. For automation and CI.

```bash
kern init my-agent --api-key sk-or-...
kern init my-agent --api-key sk-or-... --provider anthropic --model claude-opus-4.6
kern init my-agent --api-key sk-or-... --telegram-token 123:ABC --slack-bot-token xoxb-... --slack-app-token xapp-...
kern init my-agent --provider ollama --api-key http://localhost:11434 --model gemma4:31b
```

Defaults to openrouter + claude-opus-4.6 when flags are used. For Ollama, `--api-key` is the server URL.

## kern install [name|--web]

Install systemd user services for agents and the web daemon. Provides auto-restart on crash and boot persistence.

- No argument: installs all registered agents + web
- With name: installs a single agent
- `--web`: installs only the web daemon
- Migrates from PID-based daemon: stops existing process before installing
- Warns if `loginctl enable-linger` is not enabled (required for services to survive logout)
- Idempotent — safe to run again after adding new agents

Services are written to `~/.config/systemd/user/`:
- `kern-agent-<name>.service` for each agent
- `kern-web.service` for the web daemon

```bash
kern install          # all agents + web
kern install atlas    # single agent
kern install --web    # web only
```

Requires Linux with systemd. On systems without systemd, use `kern start` instead.

## kern uninstall [name]

Remove systemd services installed by `kern install`.

- No argument: uninstalls all agent services + web
- With name: uninstalls a single agent service
- Stops and disables the service, deletes the unit file

```bash
kern uninstall        # all
kern uninstall atlas  # single agent
```

## kern start [name|path]

Start agents as background daemons.

- No argument: starts all registered agents
- With name: starts that agent (looks up in `~/.kern/config.json`)
- With path: auto-registers and starts (e.g. `kern start ./cloned-repo`)
- Waits 2 seconds after fork, verifies process is alive
- Shows error log if startup fails
- Writes PID to agent's `.kern/agent.pid`
- If a systemd service is installed for the agent, delegates to `systemctl --user start`

## kern stop [name]

Stop agents.

- No argument: stops all running agents
- With name: stops that agent
- Sends SIGTERM, removes agent's `.kern/agent.pid`
- If a systemd service is installed, delegates to `systemctl --user stop`

## kern restart [name]

Stop then start. 500ms delay between for clean shutdown. Delegates to systemd when installed.

## kern list

Show all registered agents and the web daemon with status.

- Green dot: running (shows PID and port)
- Dim dot: stopped
- Red dot: path not found
- Shows model, tool scope, and mode (systemd/daemon/—)
- Shows web daemon status and port

Aliases: `kern ls`, `kern status`

## kern tui [name]

Interactive terminal chat. Connects to running daemon via HTTP/SSE.

- No argument, one agent: auto-connects
- No argument, multiple agents: arrow-key select
- Auto-starts daemon if not running
- Cross-channel messages visible in real time
- Heartbeat activity visible
- Ctrl-C only exits TUI, daemon stays alive

## kern logs [name] [-f] [-n N] [--level LEVEL]

Follow agent logs. Structured, leveled, colored output.

- No argument: auto-selects agent
- Default: follow mode (like `tail -f`). `-n 50` shows last 50 lines and exits.
- `--level warn` filters to warnings and errors only. Levels: `debug`, `info`, `warn`, `error`.
- Logs stored in `.kern/logs/kern.log`
- Components: `[kern]` `[queue]` `[runtime]` `[context]` `[telegram]` `[slack]` `[server]` `[recall]` `[segments]` `[notes]` `[config]` `[memory]`
- Level labels: `ERR` (red), `WRN` (yellow), `DBG` (dim). Info has no label.

## kern remove \<name\>

Unregister an agent. Uninstalls systemd service if installed, stops it if running. Does not delete files.

Alias: `kern rm`

## kern pair \<agent\> \<code\>

Approve a pairing code from the command line. No agent interaction needed.

```bash
kern pair atlas KERN-7X4M
```

## kern backup \<name\>

Backup an agent to a `.tar.gz` file.

- Creates `~/.kern/backups/{name}-{date}.tar.gz`
- Includes everything: AGENTS.md, IDENTITY.md, knowledge/, notes/, .kern/config.json, .kern/sessions/, .kern/.env, .kern/pairing.json
- Excludes: .kern/logs/
- Agent can be running during backup

## kern restore \<file\>

Restore an agent from a backup archive.

- Extracts to `./{agent-name}/` in the current directory
- Registers the agent in `~/.kern/config.json`
- If agent already exists: warns and asks to confirm overwrite
- If agent is running: stops it before overwriting

## kern web \<run|start|stop|status\>

Minimal static file server for the web UI. No auth, no proxy.

```bash
kern web run      # run in foreground (for Docker or manual use)
kern web start    # start as background daemon
kern web stop     # stop daemon
kern web status   # check if running
```

- Serves the web UI static files only — no API proxy, no auth
- Port configurable via `web_port` in `~/.kern/config.json` (default 8080)
- `kern web run` runs in the foreground — useful for Docker containers
- `kern web start` daemonizes: PID tracked in `~/.kern/web.pid`, logs in `~/.kern/web.log`
- If installed via `kern install --web`, start/stop/restart delegate to systemd
- Connect to agents directly from the sidebar (enter URL + token)

## kern proxy \<start|stop|status|token\>

Authenticated reverse proxy for multi-agent access. Also serves the web UI.

```bash
kern proxy start    # start proxy, prints URL with auth token
kern proxy stop     # stop it
kern proxy status   # check if running
kern proxy token    # print URL with auth token
```

- Proxies all agent API requests (`/api/agents/:name/*`) with token injection
- `KERN_PROXY_TOKEN` auto-generated on first start, stored in `~/.kern/.env` (also accepts legacy `KERN_WEB_TOKEN`)
- All `/api/*` routes require the proxy token (Bearer header or `?token=` query param)
- Port configurable via `proxy_port` in `~/.kern/config.json` (default 9000)
- PID tracked in `~/.kern/proxy.pid`, logs in `~/.kern/proxy.log`
- If installed via `kern install --proxy`, start/stop/restart delegate to systemd

## kern import opencode

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

## kern import openclaw-lcm

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

## kern scripts recover-session

Rebuild a session `.jsonl` from `recall.db` when the session file is lost or truncated (e.g. a process killed mid-write leaves a 0-byte file, crash-looping the agent on startup). recall.db stores every message losslessly, so the conversation is recoverable.

- Reads any `recall.db` path you give it (read-only — never writes to the DB)
- `--list` prints all sessions in the DB with message counts and date ranges
- Recovers the session with the most messages by default; pass `--session <id>` to target another
- Reuses the original session ID, so the output is a drop-in replacement
- Writes `<session-id>.jsonl` to the current working directory

```bash
cd /tmp
kern scripts recover-session /path/to/recall.db --list             # list sessions
kern scripts recover-session /path/to/recall.db                    # largest session
kern scripts recover-session /path/to/recall.db --session <id>     # specific session
mv /tmp/<session-id>.jsonl <agent>/.kern/sessions/                 # install, then restart kern
```

recall.db only holds messages indexed at turn-finish, so the final turn or two before a crash may be missing — everything indexed is exact. The command warns if message indexes have gaps.

## Slash commands

Type these in any channel (TUI, Web, Telegram, Slack). Handled by the runtime at the queue level — never sent to the LLM. Instant, zero tokens. Results are broadcast to all connected clients via SSE.

### /status

Show agent runtime status: model, uptime, session size, API usage, queue state, and interface connection status (Telegram, Slack).

### /restart

Restart the agent daemon.

- 2-second delay to let interfaces acknowledge the message before the process dies
- Registered as a Telegram bot command (shows in the `/` menu)
- Safe — no restart loops, no session corruption
- The agent cannot restart itself — it must ask the operator to type `/restart`
- Web UI auto-reconnects after restart (re-discovers the new agent port)

### /skills

List all available skills with active/inactive status. Provided by the skills plugin.

### /help

List available slash commands with descriptions. Includes commands registered by plugins.

### API: GET /commands

Returns all available slash commands (builtins + plugins) as a JSON object mapping command names to descriptions. Used by the web UI for dynamic autocomplete.

## kern run \<name|path\>

Run an agent in the foreground (for development/debugging). Starts all interfaces (Telegram, Slack) in-process.

### --init-if-needed

Auto-scaffolds the agent directory on first start if `.kern/config.json` is missing. Reads `KERN_*` environment variables for configuration — no interactive prompts. Designed for Docker containers starting on empty volumes.

```bash
kern run --init-if-needed /home/kern/agent
```

Environment variables used during scaffold:
- `KERN_NAME` — agent name (default: directory basename)
- `KERN_MODEL` — model identifier (default: `anthropic/claude-opus-4.6`)
- `KERN_PROVIDER` — provider name (default: `openrouter`)
- `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_BASE_URL` — written to `.kern/.env`
- `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` — written to `.kern/.env` if set
