# User Pairing

kern uses a code-based pairing system for Telegram, Slack, and Matrix. For Telegram and Slack, pairing applies to DMs only (group rooms are open). For Matrix, pairing is enforced in every room (DMs and group rooms) — an unpaired sender in a shared room will receive a pairing code in that room. TUI and web users connect directly — no pairing needed.

The first user to message the bot on Telegram, Slack, or Matrix is automatically paired as the operator.

## Flow

1. Unknown user messages the bot (Telegram DM, Slack DM, or any Matrix room)
2. Runtime responds with a pairing code: `KERN-XXXX`
3. User shares the code with the operator out-of-band (text, email, in person)
4. Operator tells the agent who this person is:
   > "pair KERN-7X4M — that's Sarah, my cofounder, she handles finance but shouldn't see personal stuff"
5. Agent calls `kern({ action: "pair", code: "KERN-7X4M" })`
6. Agent updates `USERS.md` with identity, role, and access notes
7. User is now paired and can chat

## Pairing codes

- Format: `KERN-XXXX` (4 uppercase chars, no ambiguous characters I/O/0/1)
- Stored in `.kern/pairing.json` (gitignored)
- One code per user — if they message again, same code is returned
- Codes survive until paired or agent restarts

## USERS.md

After pairing, the agent writes user info to `USERS.md`. This is a kern-specific file (not part of agent-kernel).

Example:
```markdown
# Users

## Sarah
- Telegram: 12345678
- Role: cofounder
- Access: financials, not personal
- Paired: 2026-03-24
- Notes: handles quarterly reports

## Igor
- Telegram: 5292022513
- Role: friend, testing
- Access: general
- Paired: 2026-03-24
```

The agent manages this file — reads it to know who people are, updates it as it learns more about users.

## Operator

The first person to message the bot on Telegram, Slack, or Matrix is auto-paired as the operator — no code needed, silent. TUI and web users are always the operator — no pairing needed.

Every subsequent Telegram/Slack/Matrix user goes through the pairing code flow.

## Approving users

Three ways to approve:

1. **Through the agent** — tell it "pair KERN-XXXX — that's Sarah"
2. **CLI** — `kern pair [path] <code>` (no agent interaction needed)
3. **kern tool** — agent calls `kern({ action: "pair", code: "KERN-XXXX" })`

## Checking users

```
kern({ action: "users" })
```

Returns all paired users and pending pairing codes.

## Storage

- `.kern/pairing.json` — pending codes and paired user IDs with chat IDs
- `USERS.md` — human-readable user directory managed by the agent
