import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfig, configDefaults, validateModelConfig } from "../src/config.js";

test("accepts independent model references and validates nested settings", () => {
  validateModelConfig({ ...configDefaults, embeddingModel: { provider: "openai-compatible", baseURL: "http://localhost:1234/v1", auth: "none", model: "local", dimensions: 4 }, summaryModel: { provider: "anthropic", model: "haiku" } });
  for (const ref of [{ model: "embed", dimensions: 0 }, { model: "embed", apiKey: "secret" }, { model: "embed", provider: "typo" }, { model: "embed", auth: "none", apiKeyEnv: "KEY" }, { model: "embed", apiKeyEnv: "BAD NAME" }, { model: "embed", baseURL: "http://user:password@localhost/v1" }]) {
    assert.throws(() => validateModelConfig({ ...configDefaults, embeddingModel: ref } as any));
  }
});

test("invalid model fields and malformed JSON fail instead of selecting a default", async t => {
  const dir = await mkdtemp(join(tmpdir(), "kern-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".kern"));
  for (const content of ['{"embeddingModel":42}', '{"summaryModel":{"model":"local","baseUrl":"wrong"}}', '{broken']) {
    await writeFile(join(dir, ".kern", "config.json"), content);
    await assert.rejects(loadConfig(dir));
  }
});

test("environment overrides apply even without a config file and never mutate defaults", async t => {
  const dir = await mkdtemp(join(tmpdir(), "kern-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = process.env.KERN_MODEL;
  process.env.KERN_MODEL = "env-model";
  t.after(() => { if (saved === undefined) delete process.env.KERN_MODEL; else process.env.KERN_MODEL = saved; });
  assert.equal((await loadConfig(dir)).model, "env-model");
  assert.equal(configDefaults.model, "google/gemini-3.8-flash");
});

test("effective validation applies environment overrides without mutating stored settings", () => {
  const raw = { provider: "anthropic", model: "chat", embeddingModel: "embed", baseURL: "http://local.test/v1", auth: "none" };
  const env = { KERN_PROVIDER: "openai" };
  assert.throws(() => resolveConfig(raw, {}), /Anthropic has no embeddings API/);
  assert.equal(resolveConfig(raw, env).provider, "openai");
  assert.equal(raw.provider, "anthropic");
  assert.deepEqual(env, { KERN_PROVIDER: "openai" });
  assert.throws(() => resolveConfig({ provider: "ollama", model: "chat", summaryModel: { provider: "anthropic", model: "haiku", api: "responses" } }, {}), /does not support api/);
});
