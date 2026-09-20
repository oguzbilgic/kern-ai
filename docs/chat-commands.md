# Chat Commands

Chat commands are interactive commands sent directly in conversation across any supported interface (Matrix, Slack, Discord, Telegram, IRC, Nostr, TUI, and Web UI).

## Invocation & Prefixes

Both slash (`/`) and bang (`!`) prefixes are supported interchangeably:

```text
/status
!status
```

- **Runtime-handled**: Intercepted at the message queue layer (`enqueueMessage`). They are **never sent to the LLM**, cost zero tokens, and execute immediately.
- **Unified output**: Output is formatted cleanly (typically structured YAML or monospace text) and broadcast back to the calling interface.
- **Matrix / Slack / Discord friendly**: The `!` prefix prevents native client autocomplete from swallowing or hijacking commands (e.g., Matrix or Slack clients that intercept `/status`).

---

## Core Commands

### /status (or !status)

Displays the runtime status of the active agent:
- Runtime version & agent name
- Model, provider, and reasoning status
- Process uptime and PID
- Active session message count and raw file size
- Token usage & cost breakdown
- Active interface connections (Telegram, Slack, Matrix, Discord, IRC, Nostr)
- Message queue state

```text
!status
```

### /wyd (or !wyd)

Surfaces what the agent is currently working on:
- If idle, reports waiting for input.
- If processing a turn, returns a concise summary of the active user request, current step progress, and recent tool invocations.

```text
!wyd
```

### /plugins (or !plugins)

Shows status, registered tools, routes, and active configuration for all loaded plugins (MCP, Skills, Dashboards, Sub-agents, Recall, Media, Slack, Matrix, Telegram, Discord, etc.).

```text
!plugins
```

### /restart (or !restart)

Gracefully restarts the agent process.

- Introduces a 2-second delay to ensure the calling interface receives confirmation before shutdown.
- Registered as a Telegram bot command (appears in Telegram's `/` menu).
- Safe — delegates to the supervisor daemon or systemd without corrupting sessions or causing restart loops.
- Agents cannot invoke this command themselves; it must be typed by a human operator.

```text
!restart
```

### /help (or !help)

Lists all available chat commands with descriptions, including builtin runtime commands and dynamically loaded plugin commands.

```text
!help
```

---

## Plugin Commands

### /recall-health (or !recall-health)

*Provided by the `recall` plugin.*

Runs an instant, read-only diagnostic on the active session's vector embedding index in `recall.db`:
- Indexed message scan progress and true vector coverage percentage
- Chunk size distribution (percentiles and token buckets)
- Oversized batch blockers (>8192 tokens or >16k chars)
- UTF-16 surrogate integrity (`isWellFormed`)
- Virtual table vector invariants (ghost vectors or missing rows)
- Stalled tail identification (exact message index and role blocking the pipeline)
- Overall 0–100 health score

```text
!recall-health
```

### /segment-health (or !segment-health)

*Provided by the `recall` plugin.*

Runs an instant, read-only diagnostic on the active session's semantic summary DAG in `recall.db`:
- Segment tiling invariant per level (L0, L1, L2): overlaps, gaps, stragglers, and orphans
- Injected summary waste percentage under the agent's real context budget
- Parent/child consistency check (range mismatches, child outside parent)
- Overall 0–100 health score

```text
!segment-health
```

### /skills (or !skills)

*Provided by the `skills` plugin.*

Lists all discovered skills across local workspace (`skills/`), installed directory (`.agents/skills/`), and bundled skills, showing their active/inactive status.

```text
!skills
```

### /subagents (or !subagents)

*Provided by the `subagents` plugin.*

Lists active and completed sub-agent tasks spawned during the current agent process lifetime, showing their ID, status, step count, and execution time.

```text
!subagents
```

### /mcp (or !mcp)

*Provided by the `mcp` plugin.*

Shows configured Model Context Protocol (MCP) servers, connection states, and registered external tools.

```text
!mcp
```

---

## HTTP API

### GET /commands

Agents expose an authenticated endpoint returning all active chat commands (builtins + loaded plugins) as a JSON dictionary mapping command names to descriptions.

Used by the Web UI for dynamic autocomplete.

```json
{
  "/status": "show agent status",
  "/restart": "restart agent daemon",
  "/help": "show available slash commands",
  "/plugins": "show status and tools for all plugins",
  "/skills": "list available skills and active status",
  "/recall-health": "show recall embedding health and pipeline stalls",
  "/segment-health": "show semantic segment summary tree health and rollup invariants",
  "/subagents": "list active and recent sub-agents",
  "/mcp": "show MCP server connection status and tools"
}
```
