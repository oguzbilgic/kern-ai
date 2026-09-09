import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryDB } from "../src/memory.js";
import { RecallIndex } from "../src/plugins/recall/recall.js";
import { configDefaults, type KernConfig } from "../src/config.js";

const DIMS = 8;
const config: KernConfig = { ...configDefaults, provider: "ollama", model: "gemma3:4b" };

// Stand-in for a provider embedding model: deterministic, offline.
function fakeModel(dims = DIMS) {
  return {
    specificationVersion: "v3" as const,
    provider: "test",
    modelId: "test-embed",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: false,
    async doEmbed({ values }: { values: string[] }) {
      return {
        embeddings: values.map((v) => Array.from({ length: dims }, (_, i) => (v.length + i) / 100)),
        warnings: [],
      };
    },
  };
}

async function agentWithSession(): Promise<{ dir: string; sessionId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kern-recall-"));
  await mkdir(join(dir, ".kern", "sessions"), { recursive: true });
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const lines = [
    JSON.stringify({ createdAt: new Date().toISOString() }),
    JSON.stringify({ role: "user", content: "where are my mounts" }),
    JSON.stringify({ role: "assistant", content: "under /mnt" }),
    JSON.stringify({ role: "user", content: "and the backups" }),
    JSON.stringify({ role: "assistant", content: "read only" }),
  ];
  await writeFile(join(dir, ".kern", "sessions", `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf-8");
  return { dir, sessionId };
}

function index(db: MemoryDB, dir: string) {
  const idx = new RecallIndex(db, dir, config);
  (idx as any).embeddingModel = fakeModel();
  return idx;
}

const count = (db: MemoryDB, table: string) =>
  (db.db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;

test("recall: a dimension rebuild re-vectorizes chunks that already exist", async () => {
  const { dir, sessionId } = await agentWithSession();

  const first = new MemoryDB(dir, DIMS);
  assert.equal(await index(first, dir).indexSession(sessionId), 2);
  assert.equal(count(first, "chunks"), 2);
  assert.equal(count(first, "vec_chunks"), 2);
  first.db.close();

  // Reopen at a different width: vec tables are dropped, chunk rows survive.
  const second = new MemoryDB(dir, DIMS * 2);
  assert.equal(count(second, "chunks"), 2);
  assert.equal(count(second, "vec_chunks"), 0);

  const idx = new RecallIndex(second, dir, config);
  (idx as any).embeddingModel = fakeModel(DIMS * 2);
  await idx.indexSession(sessionId);
  assert.equal(count(second, "vec_chunks"), 2, "existing chunks must be re-vectorized, not skipped");
  assert.equal(count(second, "chunks"), 2, "and not duplicated");
  second.db.close();
});

test("recall: re-indexing an unchanged session does not duplicate vectors", async () => {
  const { dir, sessionId } = await agentWithSession();
  const db = new MemoryDB(dir, DIMS);
  await index(db, dir).indexSession(sessionId);
  db.db.prepare("DELETE FROM index_state").run();
  await index(db, dir).indexSession(sessionId);
  assert.equal(count(db, "vec_chunks"), 2);
  assert.equal(count(db, "chunks"), 2);
  db.db.close();
});

test("memory: a failed probe keeps the width already on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kern-probe-"));
  await mkdir(join(dir, ".kern"), { recursive: true });

  const first = new MemoryDB(dir, 3072);
  first.db.prepare("INSERT INTO chunks (session_id, msg_start, msg_end, text, timestamp, token_count) VALUES ('s', 0, 1, 't', '2026-01-01', 5)").run();
  first.db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)").run(1n, new Float32Array(3072));
  first.db.close();

  const second = new MemoryDB(dir, null);
  assert.equal(second.dimensions, 3072);
  assert.equal(count(second, "vec_chunks"), 1, "a failed probe must not drop a healthy index");
  second.db.close();
});
