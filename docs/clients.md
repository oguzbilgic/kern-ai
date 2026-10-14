# Clients

UI clients that connect to kern agents. All clients connect via the same HTTP/SSE API — they share the session and see each other's messages in real time.

## TUI

Terminal chat client.

```bash
kern tui [path]
```

- Renders Markdown (code blocks, quotes, bold, italic)
- Live connection indicator (`●`/`○`) with auto-reconnect
- Mid-turn messaging — input stays enabled while agent is working
- Ctrl-C kills TUI only, agent stays alive

### Message styling

Colored left borders by source:

- **green** — your input and outgoing messages
- **yellow** — incoming from other channels (Telegram, Slack, Matrix, Web)
- **magenta** — heartbeat
- Tool calls color-coded by tool name (bash=red, read=cyan, write=green, edit=yellow, glob=magenta, grep=blue)

## Web UI

Browser-based chat served by `kern web`. See [Interfaces](interfaces.md#web-ui) for setup.

### Chat

- Streaming responses with server-driven thinking indicator
- Mid-turn messaging — send follow-ups injected between tool steps
- Full history on connect, including tool call results
- Switching agents mid-stream preserves the partial assistant response instead of dropping the in-progress text
- Slash commands with dynamic autocomplete — fetches available commands from agent, including plugin commands
- Markdown rendering — headers, lists, code blocks, tables, bold, italic, links
- Syntax highlighting in code blocks and tool output
- Dark theme, mobile-friendly

### Tool output

- Collapsible — click to expand full result
- Edit diffs — inline red/green highlighting
- Bash formatting — command chains broken at separators with syntax highlighting
- Fullscreen expand button on scrollable blocks

### Sidebar

- Agents grouped by server with online/offline status dots
- Drag right edge to resize: full → mini (avatars only) → collapsed
- Hamburger toggles collapsed ↔ previous state; small windows force mini
- Add remote servers with URL + token
- Logout button clears auth token

### Agent info

Click agent name in header to see model, uptime, session stats, cache hit rate, context breakdown, and API usage.

### Memory UI

Toolbar overlay with 5 tabs:

- **Sessions** — session list with activity charts
- **Segments** — semantic segment hierarchy with summaries, compression stats, and context filter
- **Notes** — daily note summaries with regeneration
- **Recall** — semantic search over past conversations
- **Context** — structured view of the full prompt with token breakdown

### Media

- Drag-and-drop or click to attach images and files
- Inline image preview in message bubbles
- Attachment thumbnails in input area before sending

## Desktop

Tauri-based native app wrapping the Web UI. Connects to any kern web server.

- macOS and Linux builds
- Auto-reconnect to saved server on launch
- Native menus: Logout, Reconnect, Reload (Cmd+R), Open in Browser
- File drag-and-drop
- External links open in system browser
- Tray icon

See [GitHub releases](https://github.com/oguzbilgic/kern-ai/releases) for downloads.

## Android

Native Android app wrapping the Web UI in a WebView.

- Connects to any kern web server (local, LAN, or remote via Tailscale)
- Native SSE via OkHttp — bypasses WebView EventSource buffering
- Voice input (speech recognition) and TTS output
- Communicates via `window.KernBridge` stable API

See [`android/README.md`](../android/README.md) for build instructions.
