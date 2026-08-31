# Changelog

## 0.33.1 (2026-08-31)

### Fixes
- **`summaryModel` can now offload summaries from local-model agents** — on `ollama` and `openai` agents, a namespaced `summaryModel` ID (e.g. `openai/gpt-4.1-mini`) routes via OpenRouter when `OPENROUTER_API_KEY` is set. Previously the ID was sent to the agent's own provider, so an Ollama agent couldn't point summaries at a cloud model at all — background summarization competed with chat for the single local GPU slot, starving both. Ollama `hf.co/...` IDs still route locally.

## 0.33.0 (2026-08-21)

### Features
- **Your agent can hear** ([#297](https://github.com/oguzbilgic/kern-ai/issues/297), [#304](https://github.com/oguzbilgic/kern-ai/pull/304)) — voice messages and audio files are now first-class media, parallel to images. Send a Telegram voice note and the agent just understands it: audio is auto-transcribed at ingest (cached like image descriptions), no tool call needed. A new `audio(file, prompt?)` tool transcribes or answers questions about any audio file on disk — sub-agents get it too. Works out of the box on OpenRouter (`google/gemini-3.7-flash` accepts ogg/opus natively, no ffmpeg); agents on other providers fall back through OpenRouter automatically. Override with the new `audioModel` config field.
- **Your agent can speak** ([#323](https://github.com/oguzbilgic/kern-ai/pull/323)) — voice note in, voice note out. When you send a voice message, the reply comes back as voice too: a real voice note on Telegram, a playable audio clip on Slack (needs the `files:write` scope). Text messages still get text replies. Works with your existing setup — no new config — and degrades gracefully to text if synthesis fails.

## 0.32.5 (2026-08-19)

### Fixes
- **One long message could freeze segmentation permanently** ([#320](https://github.com/oguzbilgic/kern-ai/issues/320)) — text from multi-part messages (any tool call, any attachment) was never length-capped, so one long message pushed its embedding window past the 8192-token limit, 400ing the whole batch before `segment_state` advanced — the same messages retried forever, no new summaries, and no trimming either under the 0.32.3 clamp. Boundary-detection text is now capped, and a rejected batch is retried value-by-value with shrinking input, so a pathological window degrades instead of stalling the index.

## 0.32.4 (2026-08-18)

### Fixes
- **Multi-line skill descriptions showed up as `>-`** ([#318](https://github.com/oguzbilgic/kern-ai/issues/318)) — skill frontmatter written with a YAML block scalar (`>`, `>-`, `|`, `|-`) parsed the indicator as the description and dropped the text, leaving the catalog with no trigger info for the model. Block scalars are now parsed properly.

## 0.32.3 (2026-08-11)

### Fixes
- **Turns that hit the step limit now end with a message instead of silence** ([#310](https://github.com/oguzbilgic/kern-ai/issues/310)) — when a turn reaches `maxSteps`, the final step is forced to be text-only (`prepareStep` disables tools and nudges the model to wrap up), so the user always gets a closing message instead of the turn dying on a tool result with nothing sent.
- **Context trimming can no longer drop messages before they're summarized** ([#311](https://github.com/oguzbilgic/kern-ai/issues/311)) — the trim boundary is clamped to summarizer coverage (last L0 segment end). Previously a heavy turn could be trimmed out of the raw window before its summary existed, making the agent forget work it finished seconds earlier; now unsummarized messages stay in the raw window even if the token budget is temporarily overshot.

## 0.32.2 (2026-08-11)

### Fixes
- **Turn timeout is now idle-based and actually aborts the stream** — the 5-minute turn timeout was wall-clock: long productive turns (many tool calls) died mid-work while the abandoned LLM stream kept running as a zombie, burning tokens on work that was thrown away. The timer now resets on every stream event, so only turns with no activity for 5 minutes are killed — and the kill aborts the underlying stream via `AbortSignal` instead of leaving it running.

## 0.32.1 (2026-07-28)

### Fixes
- **`.kern/.env` overrides inherited environment variables** ([#306](https://github.com/oguzbilgic/kern-ai/pull/306)) — an agent spawned from a shell (or another agent) with provider keys exported silently inherited them instead of using its own `.env`. The agent's `.kern/.env` is now authoritative — don't set the same variable in both.
- **`kern-media://` URIs leaking to the provider** ([#307](https://github.com/oguzbilgic/kern-ai/pull/307)) — a failed media resolution sent the raw URI to the provider, which rejects the scheme — permanently, since session history never changes. Failures now degrade to text placeholders, and a final strip pass guarantees no raw URI reaches the provider.
- **Session write amplification** ([#305](https://github.com/oguzbilgic/kern-ai/pull/305)) — every step rewrote the entire session `.jsonl`, so persistence cost grew with session size (a 15-step turn on a 20 MB session rewrote ~300 MB). Appends now write only the new records — O(new messages), same on-disk format. `load()` also repairs a torn trailing line left by a crash mid-append.

## 0.32.0 (2026-06-24)

### Features
- **`summaryModel` config field** ([#282](https://github.com/oguzbilgic/kern-ai/issues/282)) — override the model used for segment summarization. Set a non-thinking model when the main `model` is a thinking one — thinking burns the summary token budget and leaves segments unsummarized.
- **`subAgentModel` config field** ([#287](https://github.com/oguzbilgic/kern-ai/issues/287)) — run spawned sub-agents on a cheaper model than the parent. Empty = inherit. The `spawn` tool also accepts a per-child `model` override.

### Improvements
- **`kern scripts recover-session`** ([#301](https://github.com/oguzbilgic/kern-ai/issues/301)) — rebuild a lost or truncated session `.jsonl` from `recall.db`. New `kern scripts <name>` command group.
- **`OPENAI_BASE_URL` support** ([#289](https://github.com/oguzbilgic/kern-ai/issues/289)) — route the `openai` provider to any OpenAI-compatible endpoint (Azure, LiteLLM, local proxies) via `.kern/.env`.
- **Refreshed model defaults** — default model is now `anthropic/claude-opus-4.8`; init fallback lists updated for all providers; Anthropic media vision fallback bumped to `claude-sonnet-4-6`.
- **Disable thinking on Ollama auxiliary calls** — `think: false` now also applies to summarization and media digest, preventing empty summaries and missing image descriptions on thinking models.

### Fixes
- **Prompt cache thrashing on long sessions** ([#295](https://github.com/oguzbilgic/kern-ai/issues/295)) — the trim boundary advanced every turn on tool-heavy sessions, rewriting the full ~100k+ token cache prefix at 1.25× input price per message. The boundary is now sticky (hysteresis): it holds until the message window reaches the configured budget, then jumps forward in one step to 60% of budget — the budget remains a hard ceiling. One cache write per jump instead of one per turn — roughly 10× cheaper per message on active large sessions.
- **Pin `unpdf` to exact 1.6.2** ([#285](https://github.com/oguzbilgic/kern-ai/issues/285)) — unpdf 1.6.0 broke the `pdf` tool on Node 22; pinning prevents untested upstream releases from breaking fresh installs.

## v0.31.1

### Improvements
- **Local-timezone envelope** ([#268](https://github.com/oguzbilgic/kern-ai/issues/268)) — the `time:` field the agent reads is now in local time with UTC offset (e.g. `2026-04-20T20:08:45-07:00`) instead of UTC. Defaults to host timezone; override with the new `timezone` config field (IANA string).
- **Envelope reference docs** — `docs/interfaces.md` now covers system-generated envelopes (heartbeat, sub-agent announce) alongside human interfaces and includes a reference table of all current `interface`/`channel` values. `docs/architecture.md` frames the envelope as the core multi-channel contract. `docs/tools.md` sub-agent envelope example updated to match the canonical bracketed form.

### Fixes
- **NO_REPLY leaks through interfaces** ([#273](https://github.com/oguzbilgic/kern-ai/issues/273)) — replies ending with `NO_REPLY` (e.g. `"…notes are up to date.\n\nNO_REPLY"`) are now suppressed on Telegram, Slack, Matrix, web UI, and TUI. Previously only exact-match `NO_REPLY` was caught.
- **Sub-agent announce header leaking into UI** — successful sub-agent results no longer include the `[subagent:<id> done, 12s, N tool calls]` debug header on top of the result body. The `[via subagent, subagent:<id>, ...]` envelope already identifies the source. Failed or cancelled runs still include a brief `[subagent:<id> failed, 12s]` header so the outcome is visible.

## v0.31.0

### Features
- **Sub-agents** ([#258](https://github.com/oguzbilgic/kern-ai/issues/258)) — delegate a bounded task to a child agent and keep working
  - `spawn` tool returns immediately with a sub-agent id; the child runs in the background with its own LLM loop
  - Result announces back as a new turn on channel `subagent:<id>` when the child finishes — parent can react to it like any other message
  - `subagents` tool for inspection: `list`, `status <id>`, `result <id>`, `cancel <id>`
  - Read-only toolset for children: `read`, `glob`, `grep`, `webfetch`, `websearch`, `pdf`, `image`. No `bash`, `edit`, `write`, `message`, plugin tools, or nested spawning
  - State persisted at `.kern/subagents/<id>/` (`record.json` metadata, `session.jsonl` transcript); running children are cancelled on shutdown
  - `/subagents` slash command — operator peek at what the agent has spawned
  - Shipped as the `subagents` plugin
  - See [docs/subagents.md](docs/subagents.md)
- **Pop-out dashboard panel** ([#267](https://github.com/oguzbilgic/kern-ai/pull/267)) — ⧉ button in the panel header opens the current dashboard in a standalone browser window. Resizable, movable, ideal for a second monitor while chat stays in the main window.
- **Import OpenClaw sessions from LCM** ([#269](https://github.com/oguzbilgic/kern-ai/issues/269)) — `kern import openclaw-lcm <lcm.db>` converts a Lossless Context Memory database into a kern JSONL session
  - `--list` enumerates conversations; defaults to the primary `agent:main:main` session
  - Reconstructs assistant/tool-call/tool-result pairs from the `message_parts` table with zero unpaired IDs
  - Falls back to flat `messages.content` for older rows that predate the parts table
  - Normalizes OpenClaw runtime injections (preambles, heartbeats, system-exec events, queued-message blocks) into kern-native bracketed prefixes
  - Drops reasoning/compaction/system rows; keeps media references as text

### Improvements
- **`pdf` and `image` are now core tools** ([#262](https://github.com/oguzbilgic/kern-ai/issues/262)) — moved out of the media plugin
- **Import commands write to cwd** ([#271](https://github.com/oguzbilgic/kern-ai/issues/271)) — `kern import opencode` and `kern import openclaw-lcm` now write `<uuid>.jsonl` to the current directory. Move it into any agent's `.kern/sessions/` yourself. `--agent` flag removed.

## v0.30.0

### Features
- **MCP support** ([#47](https://github.com/oguzbilgic/kern-ai/issues/47)) — connect agents to Model Context Protocol servers and expose their tools alongside kern's native tools
  - Configure servers under `mcpServers` in `.kern/config.json`. Three transports: `http`, `sse`, `stdio`
  - `${VAR}` substitution in any config string so tokens and secrets live in `.kern/.env`
  - `/mcp` slash command shows configured servers, connection state, and available tools at a glance ([#253](https://github.com/oguzbilgic/kern-ai/issues/253))
  - Bundled `add-mcp-server` skill walks the agent through adding a new server
  - See [docs/mcp.md](docs/mcp.md)

### Fixes
- **Mid-turn injection position** ([#245](https://github.com/oguzbilgic/kern-ai/issues/245)) — injections were re-appended as the freshest message every step, causing repeated re-acknowledgment. Now spliced at chronological arrival position
- **Skill activation takes effect immediately** ([#252](https://github.com/oguzbilgic/kern-ai/issues/252)) — `skill activate` now returns the full skill body as its tool result so instructions are available in the current turn. Previously the body only appeared in the system prompt on the following turn

## v0.29.0

### Features
- **Matrix interface** ([#238](https://github.com/oguzbilgic/kern-ai/issues/238)) — agents join Matrix homeservers as first-class participants, alongside Telegram and Slack
  - Long-polls `/sync`, auto-accepts room invites, sends typing indicators while thinking, replies as plain `m.text`
  - Works against any homeserver (Synapse, Dendrite, Conduit, public or tailnet-local)
  - Config via `.kern/.env`: `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`
  - Agents in shared rooms can message each other directly — two kern agents can coexist or DM. Routable from the `message` tool with `interface: "matrix"`
  - Resilient reconnect — startup is non-blocking, sync loop uses exponential backoff with jitter (1s → 60s cap), stops on auth failure (401/403, `M_UNKNOWN_TOKEN`)
  - MVP scope — text only. Rooms with `m.room.encryption` are joined but messages are skipped. No media, reactions, edits, or threads yet
- **Bundled `matrix-signup` skill** — walks the agent through registering on any Matrix homeserver (open, token, or shared-secret admin) and wiring credentials into `.kern/.env`

### Improvements
- **Docker base image** ([#225](https://github.com/oguzbilgic/kern-ai/issues/225)) — switched to Ubuntu 24.04 with Node.js 22; added `curl`, `wget`, `jq`, `python3`, `pip`, `unzip`, `build-essential`. User-space `npm` and `pip` installs persist when `/home/kern` is volume-mounted
- **Summary model defaults** ([#232](https://github.com/oguzbilgic/kern-ai/issues/232)) — `openai` → `gpt-4.1-mini`, `anthropic` → `claude-haiku-4.5`, `openrouter` → `openai/gpt-4.1-mini`. Ollama now reuses the agent's chat model — no more separate `gemma3:4b` pull
- **Embedding model defaults** — unified per-provider switch matching summary models. No behavior change, cleaner code
- **Default model bumped to Claude Opus 4.7** ([#234](https://github.com/oguzbilgic/kern-ai/pull/234)) — applies to `kern init` fallback and the Docker `--init-if-needed` path. Sonnet stays on 4.6 (no 4.7 yet)
- **Hardened default `.gitignore`** ([#226](https://github.com/oguzbilgic/kern-ai/issues/226)) — added `.kern/agent.pid`, swapped `.kern/recall.db` for `.kern/*.db`
- **Init templates** ([#236](https://github.com/oguzbilgic/kern-ai/pull/236)) — moved `IDENTITY.md`, `KNOWLEDGE.md`, `USERS.md` into `templates/`. `IDENTITY.md` now prompts the agent to settle name / purpose / vibe on first run

### Fixes
- Offline agents no longer block sidebar load ([#229](https://github.com/oguzbilgic/kern-ai/issues/229))
- **Duplicate replies from mid-turn same-channel injections** ([#239](https://github.com/oguzbilgic/kern-ai/issues/239)) — drained injections resolve with `NO_REPLY`; undrained ones requeue as their own turn. Most visible in agent-to-agent Matrix rooms

## v0.28.0

### Features
- **AgentSkills support** ([#213](https://github.com/oguzbilgic/kern-ai/issues/213)) — progressive disclosure skill system following the [AgentSkills](https://agentskills.io/) universal spec, part of the [skills.sh](https://skills.sh) ecosystem
  - Scans `skills/` (agent-created) and `.agents/skills/` (installed) for `SKILL.md` files
  - Compact skill catalog always present in system prompt (~tokens per skill)
  - Standalone `skill` tool with `list`, `activate`, `deactivate` actions
  - Active skill instructions injected into system prompt — durable, never trimmed
  - API endpoints: `GET /skills`, `GET /skills/:name`
  - Bundled `create-skill` builtin — helps agents write new skills following the standard ([#218](https://github.com/oguzbilgic/kern-ai/pull/218))
  - `/skills` slash command shows catalog with active state ([#219](https://github.com/oguzbilgic/kern-ai/pull/219))
  - Install community skills with `npx skills -a universal -y`
### Improvements
- **Plugin status in `/status`** ([#224](https://github.com/oguzbilgic/kern-ai/pull/224)) — plugins report status via `onStatus` hook, aggregated and shown in `/status` output (e.g. `skills: 2 active / 3 total`)
- **Plugin slash commands** ([#219](https://github.com/oguzbilgic/kern-ai/pull/219)) — plugins can register slash commands via `commands` field; `/help` auto-lists all available commands
  - Web UI fetches available commands from `GET /commands` endpoint; plugin commands appear in autocomplete automatically
- **Unified context assembly** ([#217](https://github.com/oguzbilgic/kern-ai/pull/217)) — plugin injections (notes, skills, recall) now applied inside `buildPromptContext()`, making it the single source of truth for both model calls and the `/context/system` debug endpoint. Cache breakpoints now computed on the final message array including injections.

## v0.27.0

### Features
- **Dockerized agents** ([#157](https://github.com/oguzbilgic/kern-ai/issues/157)) — official Docker image for running agents and web UI in containers. See [docs/docker.md](docs/docker.md)
  - Auto-scaffolds on first start — no manual `kern init` needed ([#193](https://github.com/oguzbilgic/kern-ai/issues/193))
  - `KERN_MODEL`, `KERN_PORT`, `KERN_NAME`, `KERN_PROVIDER` env vars override config ([#192](https://github.com/oguzbilgic/kern-ai/issues/192))
  - Mount a volume at `/home/kern/agent` for persistent state
- **Dockerized web UI** — same image runs the web UI in a container
  - `kern web run` runs the server in the foreground for container use

### Examples
```bash
# Run an agent
docker run -d --restart=unless-stopped \
  -p 4100:4100 \
  -v agent:/home/kern/agent \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e KERN_AUTH_TOKEN=my-secret-token \
  ghcr.io/oguzbilgic/kern-ai

# Run the web UI
docker run -d -p 8080:8080 ghcr.io/oguzbilgic/kern-ai kern web run
```

### Fixes
- **Agent name not persisting** — `name` field was missing from config validation, causing it to be silently dropped on every config load

## v0.26.0

### Features
- **Jina Reader for webfetch** ([#180](https://github.com/oguzbilgic/kern-ai/issues/180)) — `webfetch` tool now uses [Jina Reader](https://jina.ai/reader/) as primary provider for URL→markdown conversion with local Turndown as fallback. Jina handles JS-rendered pages and PDFs. Optional `JINA_API_KEY` env var for higher rate limits (500 RPM vs 20 RPM free)
- **SearXNG websearch provider** ([#177](https://github.com/oguzbilgic/kern-ai/issues/177)) — `websearch` tool now supports a provider fallback chain: SearXNG (if `SEARXNG_URL` set) → DuckDuckGo. SearXNG results formatted as markdown (top 10), DDG falls back to HTML scraping. Each provider has a 5s timeout; failures log and fall through
- **Markdown search output** — `websearch` and `webfetch` tool results render as styled markdown in the web UI instead of plain monospace text
- **Sidebar agent reordering** ([#145](https://github.com/oguzbilgic/kern-ai/issues/145)) — drag-and-drop to reorder direct agents in the sidebar; order persisted across sessions; Cmd/Ctrl+1..9 shortcuts follow sidebar order
- **Agent connection info** ([#164](https://github.com/oguzbilgic/kern-ai/issues/164)) — info panel shows agent URL and masked token with copy buttons; both pinnable to header
- **Code block copy button** ([#156](https://github.com/oguzbilgic/kern-ai/issues/156)) — fenced code blocks show a copy-to-clipboard button on hover with language label

### Improvements
- **Zustand store** ([#148](https://github.com/oguzbilgic/kern-ai/pull/148)) — replaced ~12 fragmented localStorage keys with a single persisted Zustand store; automatic migration from legacy keys on first load
- **OpenRouter attribution** — updated app title to "Kern Agent" and added `X-OpenRouter-Title` header alongside legacy `X-Title`

### Fixes
- **Add modal styling** — aligned with app design language: flat background, sidebar-depth inputs, tighter spacing, get-started link for new users
- **Offline agent names** ([#166](https://github.com/oguzbilgic/kern-ai/issues/166)) — offline direct agents now show their cached name instead of repeating the hostname
- **Mini sidebar remove button** ([#159](https://github.com/oguzbilgic/kern-ai/issues/159)) — remove button no longer renders in mini mode, preventing accidental agent removal
- **Dashboard panel resize** ([#121](https://github.com/oguzbilgic/kern-ai/issues/121)) — panel width now clamps on window resize; auto-closes when window is too narrow
- **Panel resize text selection** ([#122](https://github.com/oguzbilgic/kern-ai/issues/122)) — dragging the panel resize handle no longer selects text in the chat area
- **Dashboard links** ([#141](https://github.com/oguzbilgic/kern-ai/issues/141)) — external links inside dashboard iframes now open in a new tab
- **Recall tool in-context filtering** ([#58](https://github.com/oguzbilgic/kern-ai/issues/58)) — Recall tool no longer returns chunks already in the context window

## desktop-v0.3.2

### Fixes
- **External links open in system browser** ([#190](https://github.com/oguzbilgic/kern-ai/pull/190)) — links to external sites (docs, GitHub, etc.) now open in the default browser instead of navigating inside the WebView

## desktop-v0.3.1

### Fixes
- **Dashboard iframe rendering** — fixed iframes not rendering in desktop app caused by overly strict navigation filter blocking iframe sub-resource loads

## desktop-v0.3.0

### Features
- **Default to app.kern-ai.com** ([#170](https://github.com/oguzbilgic/kern-ai/issues/170)) — app opens directly to `app.kern-ai.com`, no connect screen. Self-hosted users can set a custom URL via Kern → Custom Server… menu.

## desktop-v0.2.0

### Improvements
- **Simplified connect screen** — removed token input; just enter the kern web URL. Agents are added with tokens through the web UI sidebar.

## v0.25.0

### Features
- **Self-contained agents** ([#126](https://github.com/oguzbilgic/kern-ai/issues/126)) — all agent runtime state (port, token, PID) now lives in the agent's own `.kern/` directory instead of a central registry
  - Agent list moved from `~/.kern/agents.json` to `agents` field in `~/.kern/config.json` — one global config file for everything
  - Legacy `agents.json` auto-migrates on first load and gets deleted
  - Sticky ports: agents get a fixed port (4100-4999) assigned on creation or first start — no more random ports
  - Server binds `0.0.0.0` by default, enabling direct connections over Tailscale or LAN
- **Direct agent connections** ([#124](https://github.com/oguzbilgic/kern-ai/issues/124)) — connect to any agent from the web UI without running `kern web`. Click **+** in the sidebar, enter the agent's URL and token.
  - `kern web` is now optional — useful for multi-agent proxy, but not required
  - Login page removed — the web UI loads instantly, agents are added from the sidebar
- **Agent name auto-migration** ([#131](https://github.com/oguzbilgic/kern-ai/issues/131)) — `name` field auto-set to directory basename on first startup if missing, persisted to config, and exposed in `/status` API for reliable UI display
- **`kern proxy`** ([#127](https://github.com/oguzbilgic/kern-ai/issues/127)) — authenticated reverse proxy extracted from `kern web` into its own command
  - `kern proxy <start|stop|status|token>` — manages the proxy server with agent discovery, token auth, and API routing
  - `kern web` is now a minimal static file server with no auth or proxy routes
  - Token renamed from `KERN_WEB_TOKEN` to `KERN_PROXY_TOKEN` (legacy token accepted as fallback)
  - Proxy uses `proxy_port` config (default 9000), web uses `web_port` (default 8080)
  - `kern install --proxy` installs a systemd service for the proxy

### Improvements
- **Agent prompt: "How replies work"** ([#138](https://github.com/oguzbilgic/kern-ai/pull/138)) — new section in KERN.md explaining reply vs `message` tool vs NO_REPLY, clarified pairing scope (Telegram/Slack DMs only, first user auto-paired), and expanded USERS.md description

### Migration
- **Web UI now connects directly to agents** — add agents via the sidebar `+` button with their URL (`http://<host>:<port>`) and `KERN_AUTH_TOKEN` from `.kern/.env`
  - `kern proxy` is no longer required for single-agent setups
  - If you still need multi-agent proxy, use the new `kern proxy` command — `kern web` no longer proxies or requires auth
- Rename `KERN_WEB_TOKEN` to `KERN_PROXY_TOKEN` in `~/.kern/.env` (old name still works as fallback)
- Agents now bind `0.0.0.0` by default — set `host: "127.0.0.1"` in agent config if you want localhost only

## v0.24.1

### Fixes
- Unread counter now counts per text message instead of per turn — text after tool calls counts separately ([#118](https://github.com/oguzbilgic/kern-ai/pull/118))
- Input field auto-focuses on agent switch and initial page load ([#117](https://github.com/oguzbilgic/kern-ai/pull/117))
- Chat now uses reverse-flow scrolling — browser-native bottom pinning eliminates scroll flicker, agent switch jump, and streaming jank ([#114](https://github.com/oguzbilgic/kern-ai/issues/114))
- Unread counter no longer reappears after switching away from an agent ([#112](https://github.com/oguzbilgic/kern-ai/issues/112))
- Desktop app: logout from web UI now returns to desktop connect screen instead of web login page ([#110](https://github.com/oguzbilgic/kern-ai/pull/110))
- Side panel resize no longer grows beyond available space, preventing close button from being pushed off-screen ([#111](https://github.com/oguzbilgic/kern-ai/pull/111))

## v0.24.0

### Features
- **Plugin architecture** ([#108](https://github.com/oguzbilgic/kern-ai/pull/108)) — optional features (dashboard, media, notes, recall) extracted into self-contained plugins with a shared lifecycle interface
  - Each plugin bundles its own tools, routes, context injections, and event handling — no more scattered wiring in `app.ts` and `runtime.ts`
  - Single `plugins` object API with consistent naming: `collect*` (merge data), `dispatch*` (fire hooks)
  - Plugins declare where context gets injected (`system` vs `user-prepend`) and attach SSE events to injections
  - Shared `extractText` utility for AI SDK message content parsing
- **Dashboards and rendered HTML** ([#101](https://github.com/oguzbilgic/kern-ai/issues/101), [#103](https://github.com/oguzbilgic/kern-ai/issues/103), [#105](https://github.com/oguzbilgic/kern-ai/pull/105)) — agents can create rich visual content and persistent dashboards
  - New `render` tool lets agents produce charts, tables, and status cards as sandboxed HTML — displayed inline in chat or in a resizable side panel
  - Agents write `dashboards/<name>/` folders with HTML + JSON data, served with live data injection via `window.__KERN_DATA__`
  - Dashboards auto-discovered across all running agents and listed in the sidebar with ownership labels
  - Resizable side panel with dashboard switching from header and sidebar
- **Hide tool calls in Telegram** ([#76](https://github.com/oguzbilgic/kern-ai/issues/76)) — new `telegramTools` config (default `false`) hides tool call progress from Telegram messages
- **Infinite scroll** ([#53](https://github.com/oguzbilgic/kern-ai/issues/53)) — scroll up in chat to load older messages with scroll-position preservation

### Improvements
- **Markdown rendering** ([#95](https://github.com/oguzbilgic/kern-ai/issues/95)) — replaced hand-rolled regex parser with `marked`; fixes loose lists, nested bullets, multi-paragraph list items

### Fixes
- **Mid-turn steering** ([#94](https://github.com/oguzbilgic/kern-ai/pull/94)) — operator messages sent during an agent's turn now persist across all steps instead of being lost after one step
- **web/out packaging** ([#97](https://github.com/oguzbilgic/kern-ai/issues/97)) — build artifacts no longer tracked in git; npm package still includes them

## v0.23.2

### Improvements
- Login page polish — correct `kern.` logo, subtle button style, sticky footer with Website and GitHub links, no loading flash

### Fixes
- Login page centering on full viewport

## v0.23.1

### Fixes
- Include `web/out/` static export in npm package — v0.23.0 shipped without the web UI build, causing 404 on fresh installs

## v0.23.0

### Features
- **Web UI rewrite** ([#92](https://github.com/oguzbilgic/kern-ai/pull/92)) — rebuilt from scratch in React/Next.js + TypeScript + Tailwind, replacing the 5800-line vanilla JS single file
  - **Two chat layouts**: Bubble (iMessage-style) and Flat (Slack-style with avatars, usernames, and continuation grouping)
  - **Activity narration** — thinking indicator shows what the agent is doing in real time ("running command", "editing file") with animated transitions and hover tooltip
  - **User preferences** — dropdown to toggle layout, show/hide tools, colored tool names, peek last tool output, and pick from 11 dark code themes
  - Channel-specific avatars and colors for Telegram, Slack, and Hub messages in Flat layout

## v0.22.0

### Features
- **Live agent activity in sidebar** ([#75](https://github.com/oguzbilgic/kern-ai/pull/75)) — see which agents are thinking, get unread counts, and know what's happening across all your agents without switching
  - Unread message count badges on agent avatars
  - Pulsing indicator when an agent is busy — works for the active chat and background agents
  - Connects to all running agents on page load; idles out after 15 minutes

- **Pinnable agent stats** ([#80](https://github.com/oguzbilgic/kern-ai/pull/80)) — pin status fields (model, context, uptime) to the header and agent sidebar; click header stats or agent name to open info panel; whole row clickable to pin/unpin
- **Server-driven thinking indicator** ([#70](https://github.com/oguzbilgic/kern-ai/pull/70)) — thinking dots triggered by server event at start of message handling, replacing client-side guessing
- **Sidebar behavior** ([#71](https://github.com/oguzbilgic/kern-ai/pull/71)) — hamburger toggles collapsed ↔ previous state; small windows use mini sidebar instead of overlay

### Improvements
- **Ollama embeddings** — agents using Ollama provider now get local embeddings via `nomic-embed-text` for recall and segments, no API key needed
- **Auto-detect embedding dimension mismatch** — when switching embedding models (e.g. OpenAI → Ollama), vector tables are automatically rebuilt with the correct dimensions instead of failing silently
- Document `.kern/.env` secrets location in KERN.md template

### Fixes
- Provider errors (502, HTML error pages) now show clean messages instead of raw HTML ([#84](https://github.com/oguzbilgic/kern-ai/pull/84))
- Scroll-to-bottom button overlapping multi-line input ([#72](https://github.com/oguzbilgic/kern-ai/issues/72)) — repositions dynamically above input pill; chat re-anchors on window resize
- Chat loses scroll position on window resize ([#73](https://github.com/oguzbilgic/kern-ai/issues/73))
- URL auto-linking capturing trailing punctuation

## desktop-v0.1.1

### Features
- **Cmd+1-9 agent switching** — switch between agents with keyboard shortcuts; uses `KernBridge.switchAgent()` bridge API

## desktop-v0.1.0

### Features
- **Desktop app** ([#62](https://github.com/oguzbilgic/kern-ai/pull/62)) — native Tauri 2.0 wrapper that loads kern web UI in a single window
  - Connect screen with server URL + token input, saved server list
  - Auto-reconnect to last server on launch
  - App menu: Logout, Reconnect, Reload (Cmd+R), Open in Browser, About
  - File drag-and-drop into chat
  - External links open in system browser
  - macOS ad-hoc code signing with DMG packaging
  - CI builds for macOS ARM/Intel and Linux; Windows build available via manual dispatch
  - Desktop CI triggers on `desktop/*` branches only

## v0.21.0

### Features
- **Ollama provider** ([#69](https://github.com/oguzbilgic/kern-ai/pull/69)) — run agents on local models via Ollama. `kern init` auto-discovers pulled models. Set `OLLAMA_BASE_URL` in `.env` for remote servers.
- **Advanced prompt caching** ([#67](https://github.com/oguzbilgic/kern-ai/pull/67)) — dual cache breakpoints and turn-safe trim snapping for near-perfect cache hit rates
  - Stable prefix breakpoint snapped every 20 messages + turn breakpoint at last user message
  - Trim boundary snapped to L0 segment edges then walked back to nearest user message to prevent orphaned tool results
  - Caching logic consolidated in `context.ts` — removed duplication between runtime and context modules
  - New `docs/caching.md` with full design documentation

### Improvements
- **Web UI redesign** ([#59](https://github.com/oguzbilgic/kern-ai/pull/59))
  - Centered conversation layout with narrower bubbles, redesigned input pill with inline file attachments
  - Resizable sidebar — drag the edge to switch between full, mini (avatars only), and collapsed states
  - Syntax highlighting in code blocks, bash command formatting with line breaking, refreshed header with info panel
  - Emoji-only messages render large without bubble background

### Fixes
- **Non-Anthropic OpenRouter models** ([#65](https://github.com/oguzbilgic/kern-ai/pull/65)) — GPT-5.4 and Gemini stopped streaming after first text message due to Responses API routing. Fixed by forcing Chat Completions API. OpenAI models on OpenRouter still lack multi-step interleaved text+tool support due to upstream Responses API incompatibility.

## v0.20.0

### Features
- **Prompt caching for Anthropic models** ([#54](https://github.com/oguzbilgic/kern-ai/pull/54)) — system prompt marked with `cache_control: ephemeral` for Anthropic models (direct or via OpenRouter), enabling ~90% cost reduction on cached input tokens
  - Cache read/write stats logged per request with hit rate percentage
  - Cache stats visible in `/status` output and persisted in `usage.json`
- **Stable summary caching** ([#54](https://github.com/oguzbilgic/kern-ai/pull/54)) — trim boundary snapped to nearest L0 segment edge, keeping the conversation summary identical across consecutive turns and maximizing cache hits
- **Breadth-first summary expansion** ([#54](https://github.com/oguzbilgic/kern-ai/pull/54)) — expand highest-level segments first (L2→L1 before L1→L0) for balanced coverage across full conversation history instead of over-detailing recent segments

### Improvements
- **Syntax highlighting in chat** — fenced code blocks in assistant messages now get language-aware syntax highlighting via highlight.js (same theme as tool output)
- **Auto-link bare URLs** — plain `https://` URLs in messages are now clickable links
- **Status output cleanup** — message count and trimmed count moved to messages line; cache stats on separate line from API usage

### Config changes
- `maxContextTokens` default: 50k → 100k (affordable with prompt caching)
- `summaryBudget` default: 20% → 75% (summary is cached, effectively free)

## v0.19.0

### Features
- **Multi-modal media** ([#38](https://github.com/oguzbilgic/kern-ai/pull/38)) — send images and files to your agent from any interface. Content-addressed storage in `.kern/media/` (SHA-256 hashed filenames).
  - **Telegram**: photos, documents, stickers, voice, video, and audio
  - **Slack**: files shared in messages
  - **Web UI**: drag-and-drop or file picker upload with inline preview
  - Inline image rendering and file download links in chat history
  - Media served via `/media/:filename` endpoint, proxied with auth through web server
- **Image pre-digest** ([#38](https://github.com/oguzbilgic/kern-ai/pull/38)) — images automatically described by a vision model on arrival. Descriptions cached and reused across turns, saving tokens and enabling text-only models.
  - Model fallback chain: `mediaModel` config → agent's main model → provider default
  - Config: `mediaDigest` (boolean, default `true`), `mediaModel` (string, optional)
- **PDF tool** ([#38](https://github.com/oguzbilgic/kern-ai/pull/38)) — `pdf(file, pages?, prompt?)` for reading and analyzing PDFs.
  - Text extraction via `unpdf`. Page ranges: `1-5`, `2,4,7-9`. Header shows total page count.
  - Optional `prompt` sends extracted text to the AI model for analysis
- **Image tool** ([#38](https://github.com/oguzbilgic/kern-ai/pull/38)) — `image(file, prompt?)` for on-demand vision analysis of any image on disk or in `.kern/media/`.
- **Web search** ([#37](https://github.com/oguzbilgic/kern-ai/pull/37)) — `websearch` tool searches DuckDuckGo, returns markdown results with titles, URLs, and snippets.
- **Web fetch** ([#37](https://github.com/oguzbilgic/kern-ai/pull/37)) — `webfetch` tool fetches any URL with automatic HTML-to-markdown conversion. JSON and plain text returned as-is. `raw` option for original HTML.

## v0.18.1

### Changes
- **USERS.md injection** ([#33](https://github.com/oguzbilgic/kern-ai/pull/33)) — `USERS.md` is now auto-injected into the system prompt. Agents always know their paired users without reading the file manually.
- **Notes filtering** ([#34](https://github.com/oguzbilgic/kern-ai/pull/34)) — only `YYYY-MM-DD.md` files in `notes/` are recognized as daily notes. Stray files are ignored.
- **Browser title** ([#35](https://github.com/oguzbilgic/kern-ai/pull/35)) — tab title shows active agent name instead of "kern", with `⋯` indicator while agent is thinking.

## v0.18.0

### Features
- **Memory UI** ([#32](https://github.com/oguzbilgic/kern-ai/pull/32)) — unified web UI overlay for inspecting all agent memory. Five tabs: Sessions, Segments, Notes, Recall, and Context. Tab switcher with underline-style navigation and per-tab action buttons.
  - **Sessions**: session list with message counts, durations, role breakdowns, daily/hourly activity charts. Live session indicator. Click to expand details.
  - **Segments**: hierarchical segment tree with L0/L1/L2 levels. Fixed L1 segment visibility bug (segments with parent_id were excluded from level index). Collapsible rolled-up groups. Detail pane with dark background, markdown summaries, token compression stats, and resummarize action.
  - **Notes**: notes summaries with regeneration trigger. Rendered as markdown.
  - **Recall**: stats cards (messages, chunks, sessions, date range) and search interface.
  - **Context**: structured view parsing XML prompt tags into collapsible sections with token cost bars. Raw message count and timestamp. Real token breakdown from `/status`.

### Changes
- **New APIs** ([#32](https://github.com/oguzbilgic/kern-ai/pull/32)) — `/sessions` (with `currentSessionId`), `/context/system`, `/context/segments`, `/recall/stats`. Context breakdown in `/status` reports system + summary + messages token counts.
- **Token estimation** ([#32](https://github.com/oguzbilgic/kern-ai/pull/32)) — improved from chars/4 to chars/3.3 with per-message overhead (~25% more accurate).
- **Config rename** ([#32](https://github.com/oguzbilgic/kern-ai/pull/32)) — `historyBudget` → `summaryBudget`.

## v0.17.0

### Features
- **Android app** ([#15](https://github.com/oguzbilgic/kern-ai/pull/15)) — native mobile app for chatting with kern from Android devices.
  - Connects to any `kern web` server (local, LAN, Tailscale, or tunnel)
  - Improves mobile streaming reliability
  - Adds voice input and text-to-speech
- **Segment summary improvements** ([#29](https://github.com/oguzbilgic/kern-ai/pull/29)) — summaries preserve request → action → outcome causality while keeping the concrete details that make an event recognizable later.
  - Summaries are grounded with `IDENTITY.md` and `USERS.md` so operator, channel, and participant distinctions survive compression better
  - Added single-segment `Resummarize` to regenerate one summary in place
  - `composeHistory()` now returns the exact selected segment metadata, not just rendered text
- **Service management** ([#28](https://github.com/oguzbilgic/kern-ai/pull/28)) — `kern install` sets up user-level systemd services for agents and the web daemon. Crash recovery, boot persistence, one command.
  - `kern install` — all agents + web. `kern install <name>` or `kern install --web` for individual.
  - `kern uninstall [name]` — remove services.
  - `kern start/stop/restart` automatically delegate to systemd when installed, fall back to PID daemon otherwise.
  - `kern remove` cleans up the systemd service before unregistering.
  - Hints shown after `kern init`, `kern start`, and in `kern status` when systemd is available but not installed.
- **Context inspection** ([#29](https://github.com/oguzbilgic/kern-ai/pull/29)) — new APIs and web UI make prompt composition inspectable.
  - `/prompt/system` replaced by `GET /context/system`
  - Added `GET /context/segments` for the exact segments currently injected into prompt history
  - System prompt overlay supports `Markdown` / `Raw` views
  - Segment detail panel renders markdown summaries, has cleaner metadata layout, and preserves expanded/selected state during live refresh
  - Segment overlay shows `All` / `Context` filters, clearer modal styling, and confirmation prompts for `Clean` / `Rebuild`
- **Cross-platform shell** ([#25](https://github.com/oguzbilgic/kern-ai/pull/25)) — `bash` tool on Unix, `pwsh` tool on Windows. One shell tool per platform, selected automatically. No config needed.
  - `grep` works on Unix only; on Windows suggests `Select-String` via pwsh

### Changes
- **Logging** ([#24](https://github.com/oguzbilgic/kern-ai/pull/24)) — structured, leveled, colored log output. All levels written to file, filtering only at read time.
  - `kern logs` — follow mode by default. `-n 50` for last N lines. `--level warn` to filter.
  - `kern({ action: "logs" })` — agent can inspect its own logs (default warn+).
- **Status overhaul** ([#28](https://github.com/oguzbilgic/kern-ai/pull/28)) — `kern status` now shows the web daemon alongside agents. New `mode` field (systemd/daemon/—) shows how each process is managed.
- **Config validation** ([#23](https://github.com/oguzbilgic/kern-ai/pull/23)) — warns on unknown fields and wrong types at startup. Invalid values ignored, defaults apply.
- **Config cleanup** ([#23](https://github.com/oguzbilgic/kern-ai/pull/23)) — `kern init` now writes minimal config and stale legacy fields are ignored.
  - `kern init` writes `model`, `provider`, and `toolScope` only
  - Removed stale `telegram.allowedUsers` and `telegram.showTools` config fields
  - Dropped legacy `tools` array support (use `toolScope` instead)

## v0.16.0

### Features
- **Semantic segments** — messages are automatically grouped into topic-coherent segments (L0) based on embedding cosine distance. Each segment is summarized by gpt-4.1-mini (~10-20:1 compression). First-person, bullet-point style focusing on intent, outcomes, and decisions.
- **Hierarchical rollups** — every 10 L0 segments are summarized into an L1 parent. 10 L1s → L2, etc. Builds a multi-level summary tree.
- **Compressed history injection** — when old messages are trimmed from context, `composeHistory()` fills a token budget (`historyBudget`, default 20% of context) with segment summaries. High-level summaries cover old history cheaply, recent segments expand to detailed lower levels. Injected as `<conversation_summary>` in the system prompt.
- **Structured system prompt** — all system prompt sections wrapped in XML tags for clear identification:
  - `<document path="...">` for loaded markdown files
  - `<notes_summary>` for daily notes summary
  - `<tools>` for tool list
  - `<conversation_summary>` with nested `<summary>` blocks for compressed history
  - No more `---` delimiters between sections.
- **System prompt endpoint** — `GET /prompt/system` returns the full composed system prompt for inspection.
- **Status enrichment** — `/status` now reports history tokens injected, segment level counts, and total segments per level.

### Web UI
- **Segments visualization** — proportional colored blocks representing token density and message spans. Hover detail panel with full summary text, message range, timestamps, token counts.
- **Level toggle** — switch between L0, L1, L2 views with collapsible rolled-up child segments.
- **Segment controls** — Start, Stop, Rebuild, Clean buttons for managing segmentation lifecycle.
- **System prompt overlay** — button opens full composed system prompt in a scrollable panel.

### Config
- `historyBudget` (default `0.2`) — fraction of `maxContextTokens` allocated to compressed history. Set to `0` to disable.

### Changes
- `prepareContext()` now accepts `sessionId` and `segmentIndex` for history injection. Returns `systemAdditions` array and `trimmedCount`.
- `trimToTokenBudget()` returns trimmed message count for history injection.
- `loadNotesContext()` returns `latestFile` for document path tagging.
- `Runtime` gains `buildPromptContext()` and `getSystemPrompt()` public methods.

### Docs
- Updated `memory.md` — segments and conversation summary section with XML examples, tag reference table.
- Updated `config.md` — `historyBudget` field, new DB tables in schema section.
- Updated `KERN.md` template — references `<conversation_summary>` instead of `<history>`.

---

## v0.15.0

### Features
- **Notes injection** — agent system prompt now includes latest daily note (full content) and an LLM-generated summary of the previous 5 daily notes. Agents boot with recent context automatically.
  - Summary cached in SQLite `summaries` table. Non-blocking regeneration on day rollover.
  - System prompt reloaded per message — picks up new notes/knowledge/summaries without restart.
- **MemoryDB** (`memory.ts`) — new module owns SQLite database, schema, and summaries table. Always created on startup (works even with `recall: false`).
  - RecallIndex now takes MemoryDB instead of managing its own connection.
- **Tool result truncation** — `maxToolResultChars` config (default 20,000) caps oversized tool results in context only. Full results preserved in session JSONL and recall.
- **Context pipeline** (`context.ts`) — extracted from runtime.ts. Owns truncate → trim → stats. Single `prepareContext()` entry point.

### Web UI
- **Syntax highlighting** — highlight.js via CDN for tool output rendering.
  - **Read**: line number gutter + language-detected highlighting (TS, JS, Python, Go, Rust, SQL, YAML, Bash, etc.)
  - **Edit**: syntax-highlighted unified diff. Old lines dimmed (40% opacity), new lines full brightness. `−`/`+` gutter markers.
  - **Write**: syntax-highlighted content based on file extension.
  - **Grep**: ANSI color passthrough — file paths magenta, line numbers green, matches bold red.
- **Fullscreen expand** — `⛶` button on tool header line. Only visible when expanded and content overflows. Dark overlay, Escape/click-outside to dismiss.
- ANSI color support in all tool output (`ansiToHtml` renderer).
- Consistent spacing for tool results (`tool-result-text` div replaces `\n\n` whitespace).
- Fix SSE duplicate stream bug by tracking active EventSource.
- Debounced streaming render + textarea auto-resize to reduce input lag on mobile.
- Disable autocorrect/spellcheck on input textarea.
- Prevent duplicate agents when local URL added as remote server.

### Tools
- **grep** — new `options` param for raw grep flags (`-C 3 -i -l`, etc.). Auto-excludes `node_modules`, `.git`, `dist`. `--color=always` for colored output. Single-file mode drops `-r` for clean line-only output.

### Changes
- Default `maxContextTokens` increased from 40k to 50k.
- OpenRouter: added `X-OpenRouter-Categories` header for attribution.

### Docs
- New `memory.md` page covering all memory layers, auto-injection, and persistence.
- Updated `config.md` with `maxToolResultChars` and `maxContextTokens` defaults.
- Updated `KERN.md` template with auto-injected context details.

---

## v0.14.2

### Fixes
- Strip leading newlines from assistant messages (stream + persisted).

### Web UI
- Sidebar footer: version left, links right.

---

## v0.14.1

### Fixes
- Errors (credit limits, auth failures) now surface to the user instead of silent empty responses.
- Focus input on agent switch.

### Web UI
- Sidebar footer with Docs, GitHub, and version.
- Logo links to kern-ai.com.
- Cleaner tool styling — borderless, rounded corners. Bash shows `$ command`.
- User messages — no border, fully rounded.
- Darker, consistent tool background.
- Removed "connected" system message.

### Docs
- Added Get Started guide.
- Docs included in npm package.

---

## v0.14.0

### Features
- **Web proxy** — `kern web` now proxies all agent API requests. Browser never talks to agents directly.
  - Routes: `/api/agents/:name/status`, `/api/agents/:name/message`, `/api/agents/:name/events`, `/api/agents/:name/history`, `/api/agents/:name/health`.
  - Agent HTTP servers bind to `127.0.0.1` — only reachable locally via proxy.
  - Proxy injects agent auth tokens automatically — web UI never sees them.
- **Web auth** — `KERN_WEB_TOKEN` auto-generated on first `kern web start`, stored in `~/.kern/.env`.
  - All `/api/*` routes require Bearer token or `?token=` query param.
  - Static HTML/PWA files remain public.
  - Web UI prompts with a modal on first visit. Token saved to localStorage.
  - Logout button in sidebar header clears token and returns to auth prompt.
- **`kern web token`** — print the web UI URL with auth token anytime.
- **`kern web start` prints token** — always shows the URL with token on start and when already running.
- **Multi-server discovery** — web UI sidebar groups agents by server.
  - Local agents shown first, remote servers shown with hostname header.
  - "Add server" modal with URL + token fields.
  - Remove button on remote server headers.
  - Servers stored as `{url, token}` objects in localStorage.
- **Auto-expand last tool call** — latest tool call stays expanded during streaming. Collapses when the next tool starts or text response begins.
- **Smart scroll** — won't pull you down when scrolled up reading history. Auto-scrolls only when at the bottom.
- **Scroll-to-bottom button** — floating ↓ button appears when scrolled up, click to jump back down.
- **SSE cleanup** — proxy aborts agent connection when browser disconnects.

### Changes
- Agents bind `127.0.0.1` instead of `0.0.0.0` — no longer directly accessible over the network.
- Web UI no longer stores or manages per-agent tokens. Auth is at the proxy level.
- Agent discovery returns name and running state only — no port or token exposed.
- Removed `host` config field — agents always bind localhost now.

## v0.13.0

### Features
- **Recall tool** — semantic search over past conversations outside the current context window. Agents can now remember things from weeks ago.
  - **Search mode** — query by meaning, get ranked results with distance scores. Optional `before`/`after` date filters.
  - **Load mode** — fetch raw messages by session ID and index range for full context around a search hit.
  - **Messages in sqlite** — raw messages stored in recall.db alongside embedded chunks. Load mode reads from sqlite, no JSONL parsing on retrieval.
  - **Non-blocking backfill** — index builds in background on startup. Agent is available immediately. Status shows `(building)` until complete.
  - **Incremental indexing** — only new JSONL lines are parsed after each turn. No full-file re-reads.
  - **sqlite-vec** — local vector database using sqlite-vec extension. No external services needed.
  - **Turn-based chunking** — messages chunked by user→assistant turns, embedded via `text-embedding-3-small` (1536 dimensions).
  - **Recall in status** — `kern({ action: "status" })` and web UI show message/chunk counts and build state.
  - **Opt-out** — set `"recall": false` in config to disable.
  - 11 built-in tools (was 10).
- **Auto-recall** — before each turn, relevant old context is automatically injected into the sliding window.
  - Embeds user message, searches recall index (top 3, distance < 0.95).
  - Skips chunks already visible in context window (dedup by message index).
  - Injects `<recall>` block at top of context (ephemeral, not persisted to session).
  - Capped at ~2000 tokens.
  - Web UI shows collapsible `📎 N memories recalled` with query and chunk details.
  - **Opt-in** — set `"autoRecall": true` in config to enable.
- **KNOWLEDGE.md in system prompt** — memory index file is now loaded into the system prompt automatically, so agents know what state files exist without being told.

## v0.12.0

### Features
- **Incremental session persistence** — session is saved after each step via `onStepFinish`, not just at end of turn. Crash mid-turn no longer loses the entire turn's work. History is available on page refresh mid-turn.
- **Mid-turn thinking indicator** — web UI checks `/status` on load and shows thinking dots if the agent is mid-turn. Dots also show during tool execution.
- **Mid-turn messaging** — send messages while the agent is working. Input stays enabled in both Web UI and TUI. Messages are injected between tool steps via `prepareStep` and the agent addresses them inline.
- **Interface status** — `/status` API and slash command now report `telegram` and `slack` connection state (connected/disconnected/error). Web UI info panel shows them.
- **Queue status in `/status`** — shows busy/idle and pending message count.
- **Slash commands bypass queue** — `/status`, `/restart`, `/help` respond instantly even when the queue is busy.
- **Tool output in web UI** — `write` shows file content, `message` shows message text in collapsible tool output.

### Fixes
- **Telegram crash on restart** — SIGTERM handler now stops Telegram bot polling before exit. Previously, the old `getUpdates` long-poll lingered for up to 30s, causing the new process to hit a 409 Conflict and crash with an unhandled grammyError. Added `bot.catch()` and 409 retry logic.
- **Graceful shutdown** — SIGTERM/SIGINT stop Telegram and Slack interfaces before `process.exit()`.
- **Cross-client message sync** — SSE clients get unique connection IDs; broadcasts exclude the sender to prevent echo. New `user-remote` message type for messages from other web/TUI tabs.
- **History tool output** — appends to pre-filled content instead of overwriting.
- **Session-scoped active agent** — uses `sessionStorage` so each browser tab tracks its own agent independently.

### Changes
- Web UI info panel closes on agent switch to prevent stale data.
- TUI cursor stays visible during agent processing.
- README updated with npm install instructions and browser references.

## v0.11.0

### Features
- **Web UI** — browser-based chat interface via `kern web start/stop/status`.
  - **Streaming** — full conversation history with live streaming responses and thinking indicator between tool steps.
  - **Agent sidebar** — avatars with online/offline status. Collapsible on desktop, slide-out on mobile.
  - **Slash commands** — `/status`, `/restart`, `/help` with autocomplete popup.
  - **Collapsible tool output** — click to expand. Edit tools show inline red/green diffs.
  - **Markdown** — headers, lists, blockquotes, tables, code blocks, inline formatting.
  - **Message filters** — toggle heartbeats, TUI, tool calls, Telegram/Slack. Hides entire turns.
  - **Timestamps** — shown on user, incoming, and outgoing messages.
  - **Agent info panel** — version, model, uptime, session stats, connection string with copy.
  - **Auto-discovery** — finds running agents, reconnects after restart.
  - **Dark theme** — mobile-friendly, PWA support.
- **Auto-generated auth tokens** — `KERN_AUTH_TOKEN` generated on first agent start, stored in `.kern/.env` and `agents.json`. All API endpoints require token (except `/health`).
- **Agents bind `0.0.0.0` by default** — accessible over Tailscale/LAN, secured by auto-generated token.
- **`/help` slash command** — lists available commands with descriptions.
- **Global config** — `~/.kern/config.json` for `web_port` and `web_host`.
- **`kern init` next steps** — shows `kern tui` and `kern web start` after agent creation.

### Changes
- Agents serve API only — no HTML from agent process. `KERN_HOST`/`KERN_PORT` env vars removed. `host` field in `.kern/config.json` (default `0.0.0.0`).
- Status data shared across tool, slash command, HTTP API, and web UI via `getStatusData()`.
- KERN.md: added web UI interface guidance, markdown note, `/help` command.
- Docs updated: README, config, interfaces, commands.

## v0.10.0

### Features
- **Slash commands** — runtime-level commands that bypass the LLM entirely.
  - `/restart` — restarts the agent daemon. 2-second delay to let Telegram acknowledge before process dies. Registered as a Telegram bot command.
  - `/status` — instant runtime status (model, uptime, session size, API usage, TUI connection). Shares implementation with the `kern` tool's status action.
- **Heartbeat TUI awareness** — heartbeat message now includes TUI connection status (`[heartbeat, tui: connected/disconnected]`). Agent knows whether the operator is watching and can use the message tool to reach them if not.
- **Session recovery** — on session load, detects incomplete turns (assistant tool-call without matching result) and injects a synthetic continuation message to prevent restart loops.
- **Interactive import** — `kern import opencode` now shows pickers for project, session, and destination agent. Supports `--project`, `--session`, `--agent` flags for automation. Always confirms selection (no silent auto-select).

### Changes
- Restart moved from kern tool to `/restart` slash command — agent cannot restart itself, must ask operator.
- Import flags use space-separated format (`--project /path`) matching standard CLI conventions.
- KERN.md updated: config changes require restart, agent told to ask operator for `/restart`.

## v0.9.1

### Changes
- **Dynamic model list** — `kern init` now fetches available models live from provider APIs (OpenRouter, Anthropic, OpenAI). Falls back to curated defaults if offline or API key not yet provided. (Community PR #1)
- **Better error messages** — captures the real provider error from the `onError` stream hook instead of showing generic "No response from model" when the API fails.

### Fixes
- **Message tool misuse** — agents were using the `message` tool to reply to incoming Telegram messages instead of responding directly. Tool description now explicitly prevents this.
- **Anthropic model IDs** — fixed direct Anthropic API model aliases (`claude-opus-4-6`, `claude-sonnet-4-6`). (Community PR #1)

## v0.9.0

### Features
- **TUI Redesign** — complete rewrite using Ink (React for CLIs).
  - Clean block-based layout with deterministic vertical spacing (no double lines).
  - Robust terminal resizing using ANSI erase-in-line (`\x1b[K`) logic.
  - Live connection status indicator (`●`/`○`) that automatically reconnects and refetches agent status when the daemon restarts.
- **TUI Markdown Support** — custom markdown parsing inside the TUI to render code blocks, blockquotes, headings, bold, italic, and inline code natively in the terminal.
- **TUI Muted Content** — system output like `NO_REPLY` is now rendered dimmed and italicized to preserve visual hierarchy.

## v0.8.0

### Features
- **`kern import opencode`** — migrate sessions from OpenCode to kern. Reads OpenCode's SQLite, converts messages/parts to AI SDK ModelMessage format, validates pairing, writes JSONL.

### Fixes
- **Trim performance** — O(n) with WeakMap cache for per-message token sizes (was O(n²), slow on large imported sessions)
- **Telegram NO_REPLY** — suppress and delete placeholder message instead of sending

## v0.7.0

### Features
- **Heartbeat** — periodic `[heartbeat]` message every N minutes (configurable `heartbeatInterval`, default 60). Agent reviews notes, updates knowledge, messages operator if needed. TUI-only visibility (`♡` marker).
- **Message queue** — all messages serialized through a queue with 5-minute timeout. Same-channel messages injected mid-turn via `prepareStep`. Cross-channel messages wait in FIFO. Heartbeats deferred.
- **Same-channel injection** — send a follow-up while the agent is working, it sees your message at the next tool step wrapped in `<system-reminder>`. No waiting for the full turn to finish.
- **Kernel auto-update** — AGENTS.md ships with kern, versioned `<!-- kernel: v1.0 -->`. Updated automatically on `kern start` if a newer version is bundled.
- **Timestamps** — all messages tagged with `time:` in metadata. Agent can reason about time ("remind me in 30 minutes").
- **`kern logs`** — tail agent logs with `kern logs [name]`. Auto-selects agent.
- **Structured logging** — colored, timestamped logs across all components: kern, queue, runtime, telegram, slack, server. Startup/shutdown bookends.

### Changes
- Templates (AGENTS.md, KERN.md) moved to `templates/` in the package
- Startup header replaced with structured log lines
- All interfaces (Telegram, Slack, TUI, HTTP, heartbeat) route through message queue
- Telegram event flow restored via queue onEvent callback — tool calls show during processing
- Telegram multi-block: text → tools → text produces separate messages
- Tool display shows action for kern tool, userId for message tool
- Slack suppresses `(no text response)` alongside NO_REPLY
- Kern agents noted as loop-aware in KERN.md

## v0.6.3

### Fixes
- **Streaming actually works now** — `text-delta` events use `delta` field in AI SDK v6, not `text`. Was reading undefined since v0.1.0. Text now streams word-by-word instead of appearing all at once.

## v0.6.2

### Features
- **Auto-pair first user** — first person to message the bot becomes the operator. No code needed, silent pairing. Every user after goes through the code flow.
- **`kern pair` CLI command** — approve pairing codes from the command line: `kern pair <agent> <code>`. No agent interaction needed.

## v0.6.1

### Features
- **Non-interactive init** — `kern init <name> --api-key <key>` for automation. Defaults to openrouter + opus 4.6. Optional flags: `--provider`, `--model`, `--telegram-token`, `--slack-bot-token`, `--slack-app-token`.

## v0.6.0

### Features
- **Backup & restore** — `kern backup <name>` creates `.tar.gz` in `~/.kern/backups/`. `kern restore <file>` extracts, registers, warns on overwrite. Full agent portability — move agents between machines with memory intact.

## v0.5.0

### Features
- **Slack integration** — Bolt SDK + Socket Mode. DMs with pairing. Channels: agent reads all messages, only responds when @mentioned or relevant (NO_REPLY suppression). Replies post to channel directly. Markdown converted to Slack mrkdwn. Rich text blocks parsed for full message content.
- **Agent-to-agent awareness** — KERN.md teaches agents not to loop with other agents. NO_REPLY to break infinite volleys, let humans drive.
- **Documentation** — `docs/` with config, tools, interfaces, pairing, commands reference. Linked from KERN.md for agent self-reference.

### Fixes
- SSE keepalive pings every 15s — prevents TUI body timeout crash on long-lived connections

## v0.4.0

### Features
- **User pairing** — code-based user approval for Telegram. Unpaired users get a `KERN-XXXX` code, operator approves via agent with context, agent writes USERS.md.
- **`kern({ action: "pair" })`** — approve a pairing code from within the agent
- **`kern({ action: "users" })`** — list paired and pending users
- **USERS.md** — per-agent user directory with identity, role, guardrails. Created by `kern init`.
- **No more allowlist** — pairing replaces `telegram.allowedUsers` config. Everyone pairs, including the operator.
- **Message tool** — agent can proactively send messages to paired users on any channel. `message({ userId, interface, text })`.
- **Outgoing messages in TUI** — green `→` marker shows when agent sends a message to a channel.

### Changes
- Telegram adapter uses PairingManager instead of allowedUsers array
- PairedUser stores chatId for outgoing messages
- 10 built-in tools (was 8): added message, updated kern with pair/users actions
- KERN.md documents full pairing flow and operator identity
- TUI recognized as operator in system prompt — no pairing needed, full trust
- TUI layout flush left for all markers (◇ ◆ → and tool calls)

## v0.3.0

### Features
- **Daemon mode** — `kern start` / `kern stop` / `kern restart` to run agents in background with PID tracking
- **HTTP server per agent** — each agent runs an HTTP server on a random local port for TUI and future web UI
- **SSE event stream** — all events (text, tool calls, cross-channel messages) broadcast via Server-Sent Events
- **`kern tui`** — connects to running daemon via HTTP/SSE, auto-starts if needed, auto-selects if one agent
- **Cross-channel TUI** — see Telegram messages in real time from the TUI (yellow ◇ marker)
- **Agent registry** — `~/.kern/agents.json` auto-populated by init, start, and run commands
- **`kern list`** — show all registered agents with running state (green/red/dim dots), port numbers
- **`kern init` config mode** — re-run on existing agent to reconfigure (arrow-key select, masked passwords), auto-restart
- **Inquirer prompts** — arrow-key provider and model selection in init wizard
- **Startup verification** — `kern start` waits 2s, shows error log if agent crashes
- **Context window trimming** — sliding window over message history, configurable `maxContextTokens`
- **Persistent API usage** — token counts saved to `.kern/usage.json`, survives restarts
- **Status shows session vs context** — full session size and trimmed context window separately
- **Uniform channel metadata** — all messages (TUI, Telegram, Slack) tagged with `[via interface, channel, user]`
- **OpenRouter app headers** — requests show "kern-ai" in OpenRouter logs
- **Model list** — updated from OpenRouter leaderboard (Opus 4.6, Sonnet 4.6, MiMo, DeepSeek V3.2, GPT-5.4, Gemini 3.1 Pro, etc.)
- **`kern init` adopts existing repos** — adds `.kern/` without overwriting AGENTS.md, IDENTITY.md, etc.
- **`kern remove`** — unregister an agent (stops if running, doesn't delete files)
- **Help screen** — colorized command reference with `kern` or `kern help`

### Changes
- `kern` (no args) shows help instead of running in cwd
- `kern tui` always CLI, `kern start` runs Telegram/Slack in background
- `kern status` renamed to `kern list` (`status` still works as alias)
- All channels get metadata prefix — no special cases for TUI
- Default `maxContextTokens`: 40000 (estimated, ~160k real tokens)

### Fixes
- `kern restart` works (process.exit removed from daemon internals)
- TUI doesn't echo own messages from SSE broadcast
- TUI spinner only when sending, no CLEAR_LINE wiping cross-channel content
- Token estimate uses full JSON.stringify (was undercounting with text-only)
- `kern init` detects agents by registry name, not just path

## v0.2.0

### Features
- **WebFetch tool** — fetch URLs directly, no need for `curl` via bash
- **Kern self-management tool** — agent can check its own status, view config, inspect env vars via `kern({ action: "status" | "config" | "env" })`
- **Token tracking** — prompt and completion tokens tracked per session, shown in kern status
- **Tool scopes** — replace per-tool config with `toolScope: "full" | "write" | "read"`. New tools automatically available to all agents.
- **Context-aware messaging** — messages include `[via <interface>, <channel>, user: <id>]` metadata so the agent knows who's talking and where
- **Runtime context** — system prompt includes interface adaptation rules (brief on Telegram, detailed on CLI, professional in Slack channels)
- **Tool list injection** — available tools and descriptions injected into system prompt dynamically
- **KERN.md** — externalized runtime context file, editable per agent, ships with package as fallback
- **Telegram formatting** — markdown converted to Telegram HTML (bold, italic, code, blockquotes, lists) with plain text fallback
- **Telegram typing indicator** — stays active throughout long responses, refreshes every 4 seconds
- **Telegram tool visibility** — tool calls shown live (⚙ read, ⚙ bash...) then replaced by response
- **Version display** — shown in CLI header and kern tool status
- **Dual bin** — both `kern` and `kern-ai` commands work

### Fixes
- Descriptive error messages — rate limit, credits exhausted, auth failure, DNS errors shown clearly instead of generic "No output generated"
- Safe token usage tracking — won't crash if usage data unavailable

### Changes
- Renamed repo and npm package to `kern-ai`
- `toolScope` replaces `tools` array in config (legacy `tools` field ignored)
- 8 built-in tools (was 6): added webfetch, kern

## v0.1.0

First release.

### Features
- **CLI agent** with streaming TUI — live text, spinner, color-coded tool calls, blue diamond response marker
- **6 built-in tools** — bash, read, write, edit, glob, grep
- **Session persistence** — conversations saved as JSONL, resume across restarts
- **3 providers** — OpenRouter, Anthropic, OpenAI
- **Telegram adapter** — long polling, works behind NAT, user allowlist
- **`kern init` wizard** — scaffolds agent-kernel repo with config, secrets, git
- **CLI interface** — conversation history on startup, streaming responses
- **Agent kernel pattern** — AGENTS.md + IDENTITY.md as system prompt
