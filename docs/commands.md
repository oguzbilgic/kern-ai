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

## kern scripts segment-health

Read-only diagnostics over the semantic summary tree in `recall.db`. The tree has one invariant that should hold at every level: segments tile the message range exactly — no overlaps, no gaps — and every child lies inside its parent. This command reports every violation, plus what it costs: how many redundant summary tokens the agent is actually injecting into its prompt.

```bash
kern scripts segment-health .kern/recall.db                      # largest session, budget from .kern/config.json
kern scripts segment-health .kern/recall.db --list               # list sessions
kern scripts segment-health .kern/recall.db --session <id>       # specific session (prefix ok)
kern scripts segment-health .kern/recall.db --budget 15000       # simulate injection with a given summary budget
kern scripts segment-health .kern/recall.db --limit 50           # show up to 50 rows per finding (default 10)
kern scripts segment-health .kern/recall.db --json               # machine-readable, no truncation
```

Output, per level (L0, L1, L2, …):

| Column | Meaning |
|---|---|
| `Segs` / `Summ` | segments at this level / how many have a summary |
| `Orph` | `parent_id IS NULL` — expected for the recent tail waiting to be rolled up |
| `Strag` | orphans that sit *before* the newest parent at level+1. `rollUpLevels` batches orphans in tens by `msg_start`, so a straggler gets grouped with unrelated segments from weeks later, producing a parent that spans a huge range it never summarized |
| `Ovlp` | pairs whose message ranges intersect by ≥2 messages (re-index or restart artifacts) |
| `Shad` | segments fully contained inside another same-level segment — deletion candidates |
| `Fence` | 1-message overlaps at incremental chunk boundaries (indexer re-includes `last_segmented_msg`). Systematic and benign; counted but not listed |
| `Gaps` | message ranges no segment at this level covers |
| `RedTok` | summary tokens attributable to real overlap (proportional estimate) |
| `Coverage` | span of the level and % of it covered |

Then detail lists (truncated at `--limit`): overlaps with both `created_at` stamps so you can tell a re-index from a concurrent write, gaps, stragglers, and parent/child inconsistencies (`range-mismatch`, `non-contiguous-children`, `childless`, `child-outside-parent`).

**Injected context** runs the exact selection `composeHistory()` uses — same boundary snapping, same breadth-first expansion — with the agent's real budget (`maxContextTokens × summaryBudget` read from the `config.json` next to `recall.db`, or `--budget`). Reports segments picked per level, total tokens, and how many of those tokens describe messages already covered by an earlier selected summary. That waste % is the number that matters: on a local model with a 32k window it is the difference between a warm KV cache and a full re-prefill every turn.

**Health** is 100 minus capped penalties: overlapping segments (−30), shadowed segments (−2 each, −20), injected waste % (−30), stragglers (−2 each, −10), parent issues (−1 each, −10). The breakdown is printed so the score is never a mystery.

The unsegmented tail (messages after the last L0 end) is reported separately — it is pending, not a gap. Never writes to the DB.

## kern scripts segment-prune

Recovery for a summary tree that `segment-health` shows to be violating the tiling invariant — parallel tilings from a re-index, straggler rollups spanning siblings they never summarized, shadowed duplicates. Prune is pure selection: it decides which existing segments form the one true branch and deletes the rest. **Zero LLM calls.** Dry-run by default.

```bash
kern scripts segment-prune .kern/recall.db                       # dry run: plan + before/after health (after = plan applied to a scratch snapshot), nothing written
kern scripts segment-prune .kern/recall.db --session <id>        # specific session (prefix ok)
kern scripts segment-prune .kern/recall.db --budget 50000        # summary budget for the health simulation (default: config.json next to the DB, else 75k)
kern scripts segment-prune .kern/recall.db --apply               # execute; snapshots recall.db → recall.db.pre-prune-<ts> first (SQLite backup API, WAL-safe)
kern scripts segment-prune .kern/recall.db --apply --no-backup   # skip the snapshot
kern scripts segment-prune .kern/recall.db --json                # plan + health as JSON
```

Per level, bottom-up:

1. **Parent validation** (L1+). A parent survives only if the children still alive tile its range exactly (a legacy 1-msg fencepost is tolerated). A hole means the parent summarizes content it never saw or claims a range it doesn't own → deleted, its surviving children detached (`parent_id = NULL`). Losing a shadowed duplicate child is fine as long as what's left still tiles — invalidation only cascades where it has to.
2. **Tiling selection.** Min-cost chain of segments covering the level's span. Every pair of adjacent segments costs its overlap (fencepost free) or its gap. At **L0 gaps outrank overlaps** — a hole at L0 never heals (`indexSession` only moves forward), an overlap only wastes tokens, so an unavoidable L0 overlap is kept and listed as *residual*. At **L1+ overlaps outrank gaps** — a hole there is just orphans below, and the next `rollUpLevels` refills it. Ties: prefer summarized, then segments that already have a parent, then oldest `created_at` (the original tiling is what the tree above was built on; the re-index is the intruder).
3. **Delete** everything at the level not on the chain, plus the matching `vec_segments` embedding rows. Pending (unsummarized) rows take part too, so a fresh re-index intruder goes before it costs a summarizer call; a genuine new tail chunk is on the chain and stays.

Every level is measured against the same floor — the session's first message. An L1 that begins at message 8056 while L0 begins at 0 has a real gap (those L0s have no parent), and the report says so. A leading gap costs the same on every candidate chain, so it never changes what gets selected.

Output: a per-level table (before / kept / deleted / orphaned / remaining overlap / remaining gap / coverage), deletions grouped by reason (`off-path`, `invalid-parent`, `childless-parent`) with `created_at` so a re-index is recognizable, orphan counts per level, residual overlaps, and `segment-health` scores before and (with `--apply`) after.

**Run it with the agent stopped.** Upper levels regrow on their own: the next turn's `indexSession → rollUpLevels` re-batches the orphans into parents. This requires the rollup contiguity fix (#364) to be live first — the old rollup groups orphans in tens by `msg_start` with no adjacency check, and would rebuild the very mega-parents prune just removed. Runs shorter than 10 orphans stay as roots; `composeHistory` injects roots directly, so nothing is lost from the prompt.

Verified on six fleet databases: before → after health 3→90, 21→100, 45→90, 77→90, 98→100, 100→100; zero overlaps remain anywhere. Remaining deductions are stragglers/gaps at L1+ that the next rollup pass clears.

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
