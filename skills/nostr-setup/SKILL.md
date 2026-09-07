---
name: nostr-setup
description: Generate a Nostr identity for yourself and wire it into .kern/.env so the operator can DM you over public relays
---

# Nostr Setup

Get yourself a Nostr identity so the operator can send you encrypted DMs. No server, no signup — a keypair is the whole account.

## When to use this

The operator wants to reach you over Nostr and hasn't handed you an `nsec`. If they already have a key for you, skip to **Step 3**.

## Step 1: generate a keypair

Use the `nostr-tools` that ships with kern — don't install anything:

```bash
KERN_DIR=$(dirname "$(dirname "$(readlink -f "$(which kern)")")")
node -e '
const { generateSecretKey, getPublicKey, nip19 } = require(process.argv[1] + "/node_modules/nostr-tools/lib/cjs/index.js");
const sk = generateSecretKey();
console.log("NOSTR_NSEC=" + nip19.nsecEncode(sk));
console.log("npub=" + nip19.npubEncode(getPublicKey(sk)));
' "$KERN_DIR"
```

Output:
- `NOSTR_NSEC=nsec1...` — your private key. Secret. Never paste it into chat, notes, or git.
- `npub=npub1...` — your public key. Share this freely; it's your address.

If `which kern` fails (Docker, odd install), try `$(npm root -g)/kern-ai` as `KERN_DIR`.

## Step 2: back up the private key

The nsec is the identity. Lose it and you're a different agent to everyone on Nostr.

If the operator uses a secrets manager (1Password `op`, Bitwarden, Vault), store it there before continuing. Otherwise tell the operator to save it somewhere durable. Only ever show the nsec via a secure channel the operator chose — not in a group room.

## Step 3: write credentials to .kern/.env

Append — don't overwrite:

```
NOSTR_NSEC=nsec1...
```

Optionally pin relays (default is `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`):

```
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol
```

For a private tailnet-only relay, list only that relay — then nothing leaves the tailnet.

Use `edit` or a `bash` append with `>>`. Don't commit `.kern/.env` — it's gitignored.

## Step 4: ask the operator to restart

The Nostr interface only initializes on startup.

Tell the operator:

> My Nostr address is `npub1...`. Type `/restart` and I'll connect to the relays. Then DM me from your Nostr client — the first person to message me is auto-paired as operator.

## Step 5: verify after restart

`/status` should show `nostr: connected (N/N relays)`. Logs (`kern logs <agent>`) show `[nostr] identity npub1...` then `connected via wss://...`.

## Notes

- DMs are NIP-04 encrypted end-to-end. Relays see only ciphertext plus sender/recipient pubkeys.
- Only DMs (kind 4) are handled. Public notes, channels, and mentions are ignored.
- Pairing works like Telegram: first sender auto-pairs; later unknown senders get a pairing code for the operator to approve with the `kern` tool. Record paired users in `USERS.md`.
- Relays are dumb store-and-forward; if all configured relays are down you'll see `nostr: error (no relays reachable)` and it keeps retrying with backoff.

## Troubleshooting

- **`invalid NOSTR_NSEC`** — must be bech32 `nsec1...` (63 chars) or 64-char hex. Check for trailing whitespace or a quote.
- **`no relays reachable`** — outbound WSS blocked, or relay list has a typo. `curl -sI https://relay.damus.io` from the agent host to check egress.
- **Operator's DM never arrives** — their client must publish to at least one relay in your list. Ask which relays they write to and add one.
- **Want a fresh identity** — generate a new keypair, replace `NOSTR_NSEC`, restart. Previously paired npubs stay paired (pairing is by sender key, not yours).
