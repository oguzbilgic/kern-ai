# Docker

Run a kern agent as a Docker container. All state persists in a mounted volume.

## Quick start

### 1. Initialize a new agent

To scaffold a fresh agent, pass its name and API key(s). This creates the agent workspace, generates its configuration, and starts polling on your configured interfaces:

```bash
docker run -d --restart=unless-stopped \
  --name bob \
  -v bob-home:/home/agent \
  -e KERN_NAME=bob \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e TELEGRAM_BOT_TOKEN=123456:ABC-... \
  ghcr.io/oguzbilgic/kern-ai
```

On first run, the agent writes its name, model, and port into `workspace/.kern/config.json`, and saves your API keys into `workspace/.kern/.env`.

### 2. Running an existing agent

Once initialized (or if credentials are saved in `workspace/.kern/.env`), the container needs no environment variables at all:

```bash
docker run -d --restart=unless-stopped \
  --name bob \
  -v bob-home:/home/agent \
  ghcr.io/oguzbilgic/kern-ai
```

Everything — credentials, model selection, conversation history, memory database, and user-installed tools (`npm install -g`, `pip install`) — lives permanently in the `bob-home` volume. Upgrading the agent or recreating the container is just this one command.

## Environment variables

| Variable | Required | Default |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes (or provider-specific key) | — |
| `KERN_AUTH_TOKEN` | No | Auto-generated on first run |
| `KERN_NAME` | No | `agent` (directory basename) |
| `KERN_MODEL` | No | `anthropic/claude-opus-4.6` |
| `KERN_PROVIDER` | No | `openrouter` |
| `KERN_PORT` | No | `4100` |
| `TELEGRAM_BOT_TOKEN` | No | — |
| `SLACK_BOT_TOKEN` | No | — |
| `SLACK_APP_TOKEN` | No | — |

For other providers, pass the matching API key:

```bash
# Anthropic direct
-e KERN_PROVIDER=anthropic -e ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
-e KERN_PROVIDER=openai -e OPENAI_API_KEY=sk-...

# Ollama
-e KERN_PROVIDER=ollama -e OLLAMA_BASE_URL=http://host:11434
```

## Volumes

Mount a volume to `/home/agent` to persist everything across container restarts:
- **Workspace** (`/home/agent/workspace`) — agent config, sessions, knowledge, notes, dashboards
- **Environment** — globally installed packages (`npm install -g`, `pip install`), SSH keys, shell history, dotfiles

```bash
-v kern-data:/home/agent
```

If you only want to mount a local directory for the workspace without persisting user-level packages:
```bash
-v $(pwd):/home/agent/workspace
```

## Pre-installed tools

The base image includes: `git`, `ssh`, `curl`, `wget`, `jq`, `python3`, `pip`, `unzip`, `build-essential`.

Agents can install additional tools at runtime:
- `npm install -g <package>` — installs to user space (`~/.npm-global`)
- `pip install <package>` — installs to user space (`~/.local`)

These persist across container recreation when `/home/agent` is mounted.

## Web UI

Run the web UI as a separate container:

```bash
docker run -d -p 8080:8080 ghcr.io/oguzbilgic/kern-ai kern web run
```

Or start it on the host: `kern web start` / `npx kern-ai web start`.

Then open `http://localhost:8080`, click **+**, enter `http://<host>:4100` and the agent's auth token (found in `.kern/.env` inside the volume).

## Connecting

Connect to agents from the web UI sidebar:

1. Click **+** (Add agent)
2. Enter `http://<host>:4100`
3. Enter the agent's auth token

## Building locally

```bash
docker build -t kern-ai .
docker run -d -v kern-data:/home/agent -p 4100:4100 -e OPENROUTER_API_KEY=sk-or-... kern-ai
```
