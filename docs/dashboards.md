# Dashboards

Agents can create and maintain their own web dashboards — HTML pages with live data, served from the agent and displayed in the web UI side panel.

## File contract

A dashboard is a folder inside the agent's working directory:

```
dashboards/<name>/
  index.html    # visualization (required)
  data.json     # structured data (optional)
```

- **`index.html`** — the dashboard UI. Rendered in a sandboxed iframe with scripts enabled. Include CDN libraries (Chart.js, D3, etc.) via `<script>` and `<link>` tags directly.
- **`data.json`** — structured data the agent writes. Automatically injected into the dashboard as `window.__KERN_DATA__` at serve time.

## Creating a dashboard

The agent uses the `render` tool with the `dashboard` parameter:

```
render({ dashboard: "homelab" })
```

This opens `dashboards/homelab/index.html` in the side panel. Before calling render, the agent creates the files:

1. Write `dashboards/homelab/data.json` with structured data
2. Write `dashboards/homelab/index.html` that reads `window.__KERN_DATA__`
3. Call `render({ dashboard: "homelab" })` to display it

## Data injection

When the server serves a dashboard's `index.html`, it reads `data.json` from the same folder and injects it as a script tag:

```html
<script>window.__KERN_DATA__ = { "hosts": [...], "updatedAt": "..." };</script>
```

The dashboard HTML reads this on load:

```javascript
const data = window.__KERN_DATA__ || {};
document.getElementById('hosts').innerHTML = data.hosts.map(renderHost).join('');
```

To refresh: update `data.json` and call `render({ dashboard: "homelab" })` again. The panel reloads with fresh data.

## Inline HTML

The `render` tool also supports inline HTML — one-off visuals rendered directly in the chat:

```
render({ html: "<div style='padding:20px'>...</div>" })
```

Inline renders appear as embedded iframes in the conversation. Use them for quick status cards, tables, or charts that don't need persistence.

## The render tool

The `render` tool has two modes:

| Parameter | Behavior |
|-----------|----------|
| `html` | Inline render in chat. Self-contained HTML with inline styles. |
| `dashboard` | Opens `dashboards/<name>/index.html` in the side panel. |

Both modes render in sandboxed iframes with `allow-scripts allow-popups allow-popups-to-escape-sandbox`. External links open in a new tab.

## Discovery and UI

The web UI automatically discovers dashboards from connected agents:

- **Sidebar** — dashboards appear below agents with colored status indicators
- **Side panel** — clicking a dashboard opens it in a resizable panel alongside the chat
- **Header** — a dropdown lists all available dashboards for quick switching

The panel is resizable by dragging its left edge (min 280px, max dependent on viewport).

## CDN libraries

Since dashboards render in iframes with scripts enabled, you can include any CDN library:

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/...">
```

Chart.js, D3, Leaflet, or any other client-side library works out of the box.

## Example

A minimal homelab dashboard:

**`dashboards/homelab/data.json`**
```json
{
  "hosts": [
    { "name": "kamrui", "status": "online", "cpu": 12, "ram": 78 },
    { "name": "mac-64", "status": "online", "cpu": 5, "ram": 45 }
  ],
  "updatedAt": "2026-04-11T19:00:00Z"
}
```

**`dashboards/homelab/index.html`**
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 8px; text-align: left; border-bottom: 1px solid #21262d; }
    .online { color: #3fb950; }
    .offline { color: #f85149; }
  </style>
</head>
<body>
  <h3>Homelab</h3>
  <table>
    <tr><th>Host</th><th>Status</th><th>CPU</th><th>RAM</th></tr>
    <tbody id="hosts"></tbody>
  </table>
  <p id="updated" style="color:#484f58; font-size:12px; margin-top:16px;"></p>
  <script>
    const data = window.__KERN_DATA__ || {};
    document.getElementById('hosts').innerHTML = (data.hosts || []).map(h =>
      `<tr><td>${h.name}</td><td class="${h.status}">${h.status}</td><td>${h.cpu}%</td><td>${h.ram}%</td></tr>`
    ).join('');
    if (data.updatedAt) document.getElementById('updated').textContent = `Updated: ${new Date(data.updatedAt).toLocaleString()}`;
  </script>
</body>
</html>
```

Then the agent runs:
```
render({ dashboard: "homelab" })
```

## HTTP endpoints

Dashboards are served by the agent's HTTP server:

| Endpoint | Description |
|----------|-------------|
| `GET /dashboards` | List all dashboards (JSON array of names) |
| `GET /d/<name>/` | Serve `index.html` with `data.json` injected |
| `GET /d/<name>/<file>` | Serve other static files from the dashboard folder |

All endpoints require agent auth (`KERN_AUTH_TOKEN`). The web UI sends the token it was given for the agent.
