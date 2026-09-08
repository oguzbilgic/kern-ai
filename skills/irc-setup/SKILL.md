---
name: irc-setup
description: Register a NickServ account on an IRC server and configure the IRC interface in .kern/config.json
---

# IRC Setup

Get yourself connected to an IRC server (like Ergo, InspIRCd, or Libera.Chat) so the operator and other users can DM you and chat in channels.

## Prerequisites

Ask the operator for (or determine from homelab state):
- **IRC Server Host & Port** — e.g. `irc:6667` (plaintext/tailnet) or `irc.example.com:6697` (TLS)
- **Desired Nick/Username** — e.g. `myagent` (defaults to agent name if unspecified)
- **Channels to join** — e.g. `#homelab`
- **Password** — generate a secure random password if creating a fresh account

## Identity Model

Kern's IRC interface authenticates via `PASS <account>:<password>` on connection and identifies users via the IRCv3 `account-tag` capability:
- Authenticated users appear as `irc:<host>/<account>` (e.g. `irc:irc/oguz`).
- Unauthenticated users receive a leading tilde `~` (e.g. `irc:irc/~thelounge40`) and cannot auto-pair.
- Direct messages (DMs) are gated by pairing (first DM sender auto-pairs, subsequent senders get a pairing code).
- Channels require mentioning the agent's nick or `@nick` unless responded to in an ongoing context.

## Step 1: Generate or Retrieve Credentials

Pick a strong random password:

```bash
PASS=$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
```

Store this password in your password manager (e.g. 1Password `op`) under `<AgentName> / IRC (<Server>)`.

## Step 2: Register NickServ Account on the Server

If the server supports in-band registration (standard on Ergo with `accounts.registration.enabled: true`):

```bash
node -e '
const net = require("net");
const client = net.createConnection({ host: process.argv[1], port: parseInt(process.argv[2], 10) }, () => {
  const nick = process.argv[3];
  const pass = process.argv[4];
  client.write(`NICK ${nick}\r\nUSER ${nick} 0 * :${nick}\r\n`);
  setTimeout(() => {
    client.write(`PRIVMSG NickServ :REGISTER ${pass}\r\n`);
    setTimeout(() => {
      client.write("QUIT :done\r\n");
      client.end();
    }, 2000);
  }, 2000);
});
client.on("data", (d) => process.stdout.write(d.toString()));
' "<SERVER_HOST>" "<SERVER_PORT>" "<NICK>" "$PASS"
```

Look for `Account created` or confirmation from NickServ in the output.

*Note:* If the server requires SASL registration or manual admin provisioning, request the operator to create the account or supply SASL credentials.

## Step 3: Configure .kern/config.json

Format the connection URL:

```
irc://<nick>:<encoded_pass>@<host>:<port>/<channel1>,<channel2>
```

**Important encoding rules:**
- If using account password login (`<account>:<password>`), encode the inner colon as `%3A`:
  e.g. `irc://vega:vega%3Amypassword@irc:6667/#homelab`
- For TLS (e.g. port 6697), use `ircs://`. Note that self-signed certificates will fail TLS validation unless CA certificates are trusted system-wide; within WireGuard/Tailscale networks, plain `irc://` on port 6667 is typically preferred.

Update `.kern/config.json`:

```bash
node -e '
const fs = require("fs");
const file = "/root/.kern/config.json"; // adjust path to current agent config
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
cfg.irc = process.argv[1];
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "irc://<nick>:<encoded_pass>@<host>:<port>/#channel"
```

## Step 4: Ask the Operator to Restart

The IRC interface initializes on process startup.

Tell the operator:

> IRC is configured for `<nick>` on `<host>:<port>`. Type `/restart` and I will connect and join `<channels>`.

## Step 5: Verify After Restart

1. Check `/status` in chat — should list `irc: connected`.
2. Inspect logs: `kern logs <agent>` should show:
   - `[irc] connecting to <host>:<port>`
   - `[irc] registered as <nick>`
   - `[irc] joined #<channel>`
3. Send a test message mentioning `<nick>` in the channel or a direct message to test pairing.
