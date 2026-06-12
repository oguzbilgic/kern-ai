# Sub-agents

Sub-agents let an agent spawn focused, read-only children to work on tasks in parallel. The parent keeps working while each child runs its own LLM loop and reports back.

## When to use them

- **Research fan-out** — spawn 3 sub-agents to look up different topics, synthesize the results
- **Parallel documentation lookups** — one reads the source, another searches the web, a third checks notes
- **Candidate evaluation** — one sub-agent per option, each returns a verdict
- **Any read-only task you can hand off** while you keep working on something else

Don't use them for trivial one-off reads — just call `read`, `grep`, or `webfetch` directly. Sub-agents are for work that needs its own reasoning loop.

## Tools

### spawn

Creates a sub-agent. Returns immediately.

```
spawn({
  prompt: "Read /root/kern/src/runtime.ts and list every singleton/module-level variable. Return a table.",
  maxSteps: 20
})
```

- `prompt` — self-contained task. The child starts with no context about the parent's current work.
- `maxSteps` — max reasoning steps (default 20, max 50)
- `model` — optional model override for this child (same provider as the parent). Defaults to the `subAgentModel` config field, or the parent's model.

Returns a sub-agent ID like `sa_abc123`. The child runs in the background.

### subagents

Inspect and manage sub-agents.

```
subagents({ action: "list" })                      // all sub-agents
subagents({ action: "status", id: "sa_abc123" })   // detailed status
subagents({ action: "result", id: "sa_abc123" })   // final result text
subagents({ action: "cancel", id: "sa_abc123" })   // abort a running child
```

## How it works

### Runtime model

Each sub-agent runs as its own in-process task, with:

- A restricted tool set (read-only — see below)
- Its own session file at `.kern/subagents/<id>/session.jsonl`
- Its own LLM loop on the parent's provider. Model resolution: per-spawn `model` param > `subAgentModel` config > parent's `model`
- An `AbortSignal` so `cancel` can interrupt mid-turn

Sub-agents do **not** share the parent's plugin context — no notes, skills, recall, MCP. They're stateless workers, not full agents.

Sub-agents run concurrently with the parent and with each other. The parent's turn is *not* blocked by any of them.

### Announces

When a sub-agent finishes, its final answer is enqueued as a new message turn on a `subagent:<id>` channel. On success, the body is just the child's final answer — the standard `[via subagent, subagent:<id>, user: subagent, time: ...]` envelope identifies the source, no other header is added. On `failed`, a `[subagent:<id> failed, 12s]` style header precedes the error message so the parent can see the outcome. On `cancelled`, only the `[subagent:<id> cancelled, 12s]` header is emitted — no body.

From the parent's perspective, this looks like any other incoming message — it will be picked up after the current turn (or mid-turn if the parent is still running).

The web UI renders these with a distinct orange ⎘ avatar so you can tell them apart from user messages.

### Allowed tools

Sub-agents run with a strict read-only toolset:

| Tool | Purpose |
|---|---|
| `read` | Read files, list directories |
| `glob` | Find files by pattern |
| `grep` | Search file contents |
| `webfetch` | Fetch a URL |
| `websearch` | Search the web |
| `pdf` | Read or analyze PDF files |
| `image` | Analyze an image with the AI model |

Sub-agents **cannot**:

- Run shell commands (`bash` / `pwsh`)
- Edit or write files (`edit`, `write`)
- Send messages (`message`)
- Manage the runtime (`kern`)
- Call plugin tools (`recall`, MCP tools)
- Spawn further sub-agents (no nested delegation in v1)

This boundary is intentional. If you need a child that can mutate state, call the destructive tool in the parent based on the sub-agent's report.

### State and persistence

Sub-agent state lives under `.kern/subagents/<id>/`:

| File | Contents |
|---|---|
| `record.json` | Metadata: id, status, prompt, result, timings, tool call count, token totals |
| `session.jsonl` | Full transcript — the child's messages, tool calls, tool results |

Statuses: `running`, `done`, `failed`, `cancelled`.

Sub-agent state is written to disk under `.kern/subagents/<id>/`, but completed children are not reloaded into the in-memory list on startup — the `subagents` and `/subagents` commands only show sub-agents spawned in the current process lifetime. Running children do not survive a restart either — they're cancelled on shutdown.

## Slash command

As the operator, you can peek at what your agent has spawned:

```
/subagents
```

Lists all sub-agents with status, prompt preview, duration, and tool call count. Running first, then most recently finished. Output is user-only — the agent doesn't see it. For detailed inspection the agent has the `subagents` tool (`list`, `status <id>`, `result <id>`, `cancel <id>`).

## Limits and costs

- **Concurrency** — no hard cap. Each sub-agent is a real LLM loop, so spawning 20 at once costs 20 model calls in flight.
- **Tokens** — each sub-agent has its own context. A sub-agent with `maxSteps: 20` can easily burn 20k–100k tokens depending on the task.
- **Cache** — sub-agents don't share prompt cache with the parent or each other (different prompts, different sessions).
- **Model** — defaults to the parent's model. Set `subAgentModel` in config to run all children on a cheaper model (they're read-only and bounded — they rarely need frontier-tier reasoning), or pass `model` on an individual `spawn` call.

## Disabling

The sub-agents plugin is on by default. There's no config flag to disable it today — if you don't want it, the model simply won't call `spawn` without a reason to.

## See also

- [Tools](tools.md) — full tool list including `spawn` and `subagents`
- [Memory](memory.md) — how `recall` works (sub-agents use it too)
