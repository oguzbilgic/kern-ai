---
name: irc-setup
description: Register a NickServ account on an IRC server and configure the IRC interface in .kern/config.json
---

# IRC Setup

Get yourself connected to an IRC server (like Ergo, InspIRCd, or Libera.Chat) so the operator and other users can DM you and chat in channels.

## Prerequisites

Ask the operator for (or determine from homelab state):
- **IRC Server Host & Port** — e.g. `irc` port `6667` (plaintext/tailnet) or `irc.example.com` port `6697` (TLS)
- **Desired Nick/Username** — e.g. `myagent` (defaults to agent name if unspecified)
- **Channels to join** — e.g. `#homelab`
- **Password** — generate a secure random password if creating a fresh account

## Identity Model

Kern's IRC interface authenticates via `PASS <account>:<password>` on connection and identifies users via the IRCv3 `account-tag` capability:
- Authenticated users appear as `irc:<host>/<account>` (e.g. `irc:irc/oguz`).
- Unauthenticated users receive a leading tilde `~` (e.g. `irc:irc/~thelounge40`) and cannot auto-pair.
- Direct messages (DMs) are gated by pairing (first DM sender auto-pairs, subsequent senders get a pairing code).
- Channels deliver all messages to the agent context. When replying in channels, keep it relevant and concise.

## Step 1: Probe the Server

Use the built-in `irc` tool to verify network connectivity and available capabilities:

Call tool: `irc({ action: "probe", host: "<SERVER_HOST>", port: 6667, tls: false })`

Check the returned response for:
- Server name and software version (e.g. `ergo-2.19.1`)
- Supported IRCv3 capabilities (`account-tag`, `message-tags`, etc.)

## Step 2: Generate Password & Register NickServ Account

Pick a strong random password and store it in your secrets manager (e.g. 1Password `op` or agent vault under `<AgentName> / IRC (<Server>)`).

Register the account on the IRC server directly using the tool:

Call tool: `irc({ action: "register", host: "<SERVER_HOST>", port: 6667, nick: "<NICK>", password: "<PASSWORD>" })`

This handles:
- Opening socket and CAP negotiation
- Registering nick with NickServ (`PRIVMSG NickServ :REGISTER <password>`)
- Parsing the server notice to confirm account creation (e.g. `Account created`)

## Step 3: Configure the IRC Interface

Use the `configure` action of the `irc` tool to format the connection URL (including proper `%3A` colon escaping for `account:password`) and update `.kern/config.json`:

Call tool: `irc({ action: "configure", host: "<SERVER_HOST>", port: 6667, tls: false, nick: "<NICK>", password: "<PASSWORD>", channels: "#homelab" })`

The tool automatically saves the correct `irc://` or `ircs://` URL into `.kern/config.json`.

## Step 4: Ask the Operator to Restart

The IRC interface starts up with the kern runtime.

Prompt your operator:
> IRC has been configured for `<nick>` on `<host>`. Please run `/restart` to bring up the connection.

## Step 5: Verify & Manage at Runtime

Once restarted:
1. Run `/status` — IRC should report `connected`.
2. Send commands directly to the server using `action: "send"`:
   - Identify or authenticate:
     `irc({ action: "send", command: "PRIVMSG NickServ :IDENTIFY <password>" })`
   - Inspect channel members:
     `irc({ action: "send", command: "NAMES #homelab" })`
   - Inspect user accounts and hostmasks:
     `irc({ action: "send", command: "WHOIS <nick>" })`
   - Join or leave channels on the fly:
     `irc({ action: "send", command: "JOIN #dev" })`
     `irc({ action: "send", command: "PART #dev :Leaving" })`
   - Inspect or set channel topic/modes:
     `irc({ action: "send", command: "TOPIC #homelab" })`
     `irc({ action: "send", command: "MODE #homelab" })`
