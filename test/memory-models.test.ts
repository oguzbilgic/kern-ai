import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDB } from "../src/memory.js";
import { configDefaults } from "../src/config.js";
import { RecallIndex } from "../src/plugins/recall/recall.js";
import { modelServer } from "./helpers/model-server.js";

async function directory(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "kern-memory-"));
  await mkdir(join(dir, ".kern"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function seed(memory: MemoryDB) {
  memory.db.exec("INSERT INTO chunks (id, session_id, msg_start, msg_end, text, timestamp, token_count) VALUES (1, 'inactive', 0, 2, 'stored memory', '2026-01-01', 3); INSERT INTO index_state VALUES ('inactive', 2); INSERT INTO segment_state VALUES ('inactive', 2); INSERT INTO semantic_segments (id,session_id,msg_start,msg_end,level,summary,token_count,summarized,summary_token_count) VALUES (1,'inactive',0,2,0,'preserved summary',3,1,3);");
  memory.db.prepare("INSERT INTO vec_chunks(rowid,embedding) VALUES (?,?)").run(1n, new Float32Array([0.1,0.2,0.3,0.4]));
}

test("offline probe preserves existing vectors, identity, cursors, and summaries", async t => {
  const dir = await directory(t);
  const memory = new MemoryDB(dir, { dimensions: 4, fingerprint: "known" });
  seed(memory);
  memory.close();
  const server = await modelServer(t, () => ({ status: 401, body: { error: { message: "Invalid API key" } } }));
  const config = { ...configDefaults, embeddingModel: { provider: "openai-compatible", baseURL: server.baseURL, model: "embed" } };
  const profile = await MemoryDB.probeEmbeddingModel(config);
  assert.equal(profile, null);
  assert.equal(server.requests.length, 1);
  const offline = new MemoryDB(dir, profile);
  t.after(() => offline.close());
  assert.equal(offline.embeddingsReady, false);
  assert.equal((offline.db.prepare("SELECT count(*) as n FROM vec_chunks").get() as any).n, 1);
  assert.equal((offline.db.prepare("SELECT fingerprint FROM embedding_metadata").get() as any).fingerprint, "known");
  assert.equal((offline.db.prepare("SELECT last_indexed_msg FROM index_state").get() as any).last_indexed_msg, 2);
  assert.equal((offline.db.prepare("SELECT summary FROM semantic_segments").get() as any).summary, "preserved summary");
});

test("same-dimension model change rebuilds inactive-session vectors and preserves the summary tree", async t => {
  const dir = await directory(t);
  const initial = new MemoryDB(dir, { dimensions: 4, fingerprint: "old-model" });
  seed(initial);
  initial.close();
  const server = await modelServer(t);
  const config = { ...configDefaults, embeddingModel: { provider: "openai-compatible", baseURL: server.baseURL, model: "new-model" } };
  const profile = await MemoryDB.probeEmbeddingModel(config);
  assert.ok(profile);
  const migrated = new MemoryDB(dir, profile);
  t.after(() => migrated.close());
  assert.equal((migrated.db.prepare("SELECT count(*) as n FROM vec_chunks").get() as any).n, 0);
  assert.equal((migrated.db.prepare("SELECT summary FROM semantic_segments").get() as any).summary, "preserved summary");
  assert.equal((migrated.db.prepare("SELECT last_segmented_msg FROM segment_state").get() as any).last_segmented_msg, 2);
  assert.equal((migrated.db.prepare("SELECT last_indexed_msg FROM index_state").get() as any).last_indexed_msg, 2);
  await new RecallIndex(migrated, dir, config).backfillVectors();
  assert.equal((migrated.db.prepare("SELECT count(*) as n FROM vec_chunks").get() as any).n, 1);
  assert.equal((migrated.db.prepare("SELECT text FROM chunks").get() as any).text, "stored memory");
});

test("vector migration embeds stored history once and normal indexing only handles the new tail", async t => {
  const dir = await directory(t);
  await mkdir(join(dir, ".kern", "sessions"));
  const path = join(dir, ".kern", "sessions", "active.jsonl");
  const oldMessages = [{ role: "user", content: "old user history ".repeat(60) }, { role: "assistant", content: "old assistant history ".repeat(40) }];
  await writeFile(path, [JSON.stringify({ id: "active", createdAt: "2026-01-01T00:00:00Z" }), ...oldMessages.map(message => JSON.stringify(message))].join("\n") + "\n");
  const server = await modelServer(t);
  const config = { ...configDefaults, provider: "openai-compatible", baseURL: server.baseURL, auth: "none" as const, model: "chat", embeddingModel: "embed" };
  const initial = new MemoryDB(dir, { dimensions: 4, fingerprint: "old" });
  await new RecallIndex(initial, dir, config).indexSession("active");
  initial.close();
  const migrated = new MemoryDB(dir, { dimensions: 4, fingerprint: "new" });
  t.after(() => migrated.close());
  const recall = new RecallIndex(migrated, dir, config);
  await recall.backfillVectors();
  const afterBackfill = server.requests.length;
  assert.equal(await recall.indexSession("active"), 0);
  assert.equal(server.requests.length, afterBackfill);
  await appendFile(path, [{ role: "user", content: "new user tail ".repeat(60) }, { role: "assistant", content: "new assistant tail ".repeat(40) }].map(message => JSON.stringify(message)).join("\n") + "\n");
  assert.equal(await recall.indexSession("active"), 1);
  assert.equal(server.requests.length, afterBackfill + 1);
  assert.ok(JSON.stringify(server.requests.at(-1)!.body.input).includes("new user tail"));
  assert.ok(!JSON.stringify(server.requests.at(-1)!.body.input).includes("old user history"));
  assert.equal((migrated.db.prepare("SELECT last_indexed_msg FROM index_state WHERE session_id='active'").get() as any).last_indexed_msg, 4);
});

test("unchanged fingerprint keeps vector rows and recall cursors", async t => {
  const dir = await directory(t);
  const profile = { dimensions: 4, fingerprint: "same" };
  const initial = new MemoryDB(dir, profile);
  seed(initial);
  initial.close();
  const reopened = new MemoryDB(dir, profile);
  t.after(() => reopened.close());
  assert.equal((reopened.db.prepare("SELECT count(*) as n FROM vec_chunks").get() as any).n, 1);
  assert.equal((reopened.db.prepare("SELECT last_indexed_msg FROM index_state").get() as any).last_indexed_msg, 2);
});

test("disabled embeddings never probe or invent vector dimensions", async t => {
  const profile = await MemoryDB.probeEmbeddingModel({ ...configDefaults, embeddingModel: false });
  assert.equal(profile, null);
  const memory = new MemoryDB(await directory(t), profile);
  t.after(() => memory.close());
  assert.equal(memory.db.prepare("SELECT name FROM sqlite_master WHERE name='vec_chunks'").get(), undefined);
});

test("legacy vectors are preserved while offline and rebuilt once when validated", async t => {
  const dir = await directory(t);
  const legacy = new MemoryDB(dir);
  legacy.db.exec("CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding FLOAT[4])");
  seed(legacy);
  legacy.close();
  const offline = new MemoryDB(dir);
  assert.equal((offline.db.prepare("SELECT count(*) as n FROM vec_chunks").get() as any).n, 1);
  offline.close();
  const upgraded = new MemoryDB(dir, { dimensions: 4, fingerprint: "validated-model" });
  assert.equal((upgraded.db.prepare("SELECT count(*) as n FROM vec_chunks").get() as any).n, 0);
  upgraded.close();
  const reopened = new MemoryDB(dir, { dimensions: 4, fingerprint: "validated-model" });
  t.after(() => reopened.close());
  assert.equal((reopened.db.prepare("SELECT summary FROM semantic_segments").get() as any).summary, "preserved summary");
});
