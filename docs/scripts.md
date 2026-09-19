# Offline Scripts

The `kern scripts` subcommands provide offline diagnostic, analysis, and repair utilities that operate directly on `.kern/recall.db` SQLite database files.

Scripts are standalone:
- They run directly from the shell without requiring the agent daemon to be active.
- Analysis tools (`recall-health`, `segment-health`, `recover-session`) are strictly read-only.
- Mutation tools (`recall-repair`, `segment-prune`) are dry-run by default, perform zero LLM calls, and create safe backups before applying modifications.

---

## kern scripts recall-health

Offline diagnostic tool for the recall embedding index in `recall.db`. Read-only. Examines conversation chunks (`chunks` / `vec_chunks`) and semantic segment embeddings (`semantic_segments` / `vec_segments`).

```bash
kern scripts recall-health .kern/recall.db                      # largest session
kern scripts recall-health .kern/recall.db --list               # list sessions with msg & chunk counts
kern scripts recall-health .kern/recall.db --session <id>       # specific session (prefix ok)
kern scripts recall-health .kern/recall.db --limit 20           # show up to 20 blockers (default 10)
kern scripts recall-health .kern/recall.db --json               # machine-readable, no truncation
```

Checks invariants across six dimensions:
1. **Index progress & coverage** — message lag between raw `messages` and `index_state.last_indexed_msg`.
2. **Chunk size distributions** — token and character percentiles (min, p50, p95, max, avg) and token buckets (<1k, 1k–4k, 4k–8k, >8k).
3. **Batch blockers** — detects chunks >8192 tokens or >16k chars that trigger provider HTTP 400 rejection during embedding.
4. **Surrogate pair integrity** — detects lone UTF-16 surrogates or `` lossy replacements that trigger provider `invalid_json` parse failures.
5. **Vector table invariants** — verifies 1:1 synchronization between content tables and virtual vector tables (`orphanContent`, `ghostVectors`, and uniform vector dimension across rows).
6. **Stalled tail identification** — pins the exact message index, role, character length, and preview of the item blocking the indexing pipeline.

Outputs a 0–100 health score with itemized deductions (`lag`, `oversized_chunks`, `lone_surrogates`, `vector_invariants`, `stalled_pipeline`).

---

## kern scripts recall-repair

Inspects and repairs recall index deficiencies (orphaned chunks lacking rows in `vec_chunks`, e.g. following an embedding dimension rebuild). Pure SQLite — zero LLM calls, zero API credentials needed. Dry-run by default. Zero-op if the index is already healthy (0 changes, 0 DB writes).

```bash
kern scripts recall-repair .kern/recall.db                       # dry run: inspects chunks and vec_chunks, displays prune plan
kern scripts recall-repair .kern/recall.db --session <id>        # specific session (prefix ok)
kern scripts recall-repair .kern/recall.db --apply               # execute repair: prunes orphaned chunks and resets index cursor
kern scripts recall-repair .kern/recall.db --apply --no-backup   # skip the SQLite snapshot backup
kern scripts recall-repair .kern/recall.db --json                # machine-readable plan
```

- **Zero-op on healthy**: if `recall-health` shows 100% vector coverage and 0 lag, exits immediately with zero changes.
- **Pure SQLite**: deletes orphaned rows from `chunks` and rewinds `index_state.last_indexed_msg` to the earliest missing message index.
- **Agent self-heals**: on the next agent start or turn, the agent's native background indexer resumes from the reset cursor, re-chunking and re-vectorizing missing messages cleanly.
- **Safe**: snapshots `recall.db` to `<recall.db>.backup-<timestamp>` using SQLite's online backup API before applying modifications.

---

## kern scripts segment-health

Read-only diagnostics over the semantic summary tree in `recall.db`. The tree has one invariant that should hold at every level: segments tile the message range exactly — no overlaps, no gaps — and every child lies inside its parent. This command reports every violation, plus what it costs: how many redundant summary tokens the agent is actually injecting into its prompt.

```bash
kern scripts segment-health .kern/recall.db                      # largest session, budget from .kern/config.json
kern scripts segment-health .kern/recall.db --list               # list sessions
kern scripts segment-health .kern/recall.db --session <id>       # specific session (prefix ok)
kern scripts segment-health .kern/recall.db --budget 15000       # simulate injection with a given summary budget
kern scripts segment-health .kern/recall.db --limit 50           # show up to 50 rows per finding (default 10)
kern scripts segment-health .kern/recall.db --json               # machine-readable, no truncation
```

Output, per level (L0, L1, L2, …):

| Column | Meaning |
|---|---|
| `Segs` / `Summ` | segments at this level / how many have a summary |
| `Orph` | `parent_id IS NULL` — expected for the recent tail waiting to be rolled up |
| `Strag` | orphans that sit *before* the newest parent at level+1 |
| `Ovlp` | pairs whose message ranges intersect by ≥2 messages (re-index or restart artifacts) |
| `Shad` | segments fully contained inside another same-level segment — deletion candidates |
| `Fence` | 1-message overlaps at incremental chunk boundaries (`last_segmented_msg`). Systematic and benign; counted but not listed |
| `Gaps` | message ranges no segment at this level covers |
| `RedTok` | summary tokens attributable to real overlap (proportional estimate) |
| `Coverage` | span of the level and % of it covered |

- **Injected context** runs the exact selection `composeHistory()` uses — same boundary snapping, same breadth-first expansion — with the agent's real budget (`maxContextTokens × summaryBudget` read from the `config.json` next to `recall.db`, or `--budget`). Reports segments picked per level, total tokens, and how many of those tokens describe messages already covered by an earlier selected summary (waste %).
- **Health** is 100 minus capped penalties: overlapping segments (−30), shadowed segments (−2 each, −20), injected waste % (−30), stragglers (−2 each, −10), parent issues (−1 each, −10).
- Unsegmented tail (messages after the last L0 end) is reported separately as pending, not a gap.

---

## kern scripts segment-prune

Recovery for a summary tree that `segment-health` shows to be violating the tiling invariant — parallel tilings from a re-index, straggler rollups spanning siblings they never summarized, shadowed duplicates. Prune is pure selection: it decides which existing segments form the one true branch and deletes the rest. **Zero LLM calls.** Dry-run by default.

```bash
kern scripts segment-prune .kern/recall.db                       # dry run: plan + before/after health, nothing written
kern scripts segment-prune .kern/recall.db --session <id>        # specific session (prefix ok)
kern scripts segment-prune .kern/recall.db --budget 50000        # summary budget for the health simulation (default: config.json next to DB)
kern scripts segment-prune .kern/recall.db --apply               # execute; snapshots recall.db first (WAL-safe backup API)
kern scripts segment-prune .kern/recall.db --apply --no-backup   # skip the snapshot
kern scripts segment-prune .kern/recall.db --json                # plan + health as JSON
```

Per level, bottom-up:
1. **Parent validation** (L1+). A parent survives only if surviving children tile its range exactly. A hole means the parent claims content it never summarized → deleted, its surviving children detached (`parent_id = NULL`).
2. **Tiling selection.** Min-cost chain of segments covering the level's span. At **L0 gaps outrank overlaps** (a hole at L0 never heals, an overlap only wastes tokens). At **L1+ overlaps outrank gaps** (a hole is just orphans below, refilled on the next rollup).
3. **Delete** everything at the level not on the chain, plus matching `vec_segments` rows.

Run with the agent stopped. Upper levels regrow on their own: the next turn's `indexSession → rollUpLevels` re-batches the orphans into parents.

---

## kern scripts recover-session

Rebuild a session `.jsonl` from `recall.db` when the session file is lost or truncated (e.g. a process killed mid-write leaves a 0-byte file, crash-looping the agent on startup). `recall.db` stores every message losslessly, so the conversation is recoverable.

```bash
cd /tmp
kern scripts recover-session /path/to/recall.db --list             # list sessions
kern scripts recover-session /path/to/recall.db                    # largest session
kern scripts recover-session /path/to/recall.db --session <id>     # specific session
mv /tmp/<session-id>.jsonl <agent>/.kern/sessions/                 # install, then restart kern
```

- Reads any `recall.db` path you give it (read-only — never writes to the DB).
- Reuses the original session ID, so the output is a drop-in replacement.
- Writes `<session-id>.jsonl` to the current working directory.
- `recall.db` stores messages indexed at turn-finish, so the final turn or two before an ungraceful crash may be missing. Warns if message indexes have gaps.
