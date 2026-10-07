import { test } from "node:test";
import assert from "node:assert/strict";
import { embed, generateText } from "ai";
import { resolveModel, resolveSummaryModel, resolveEmbeddingModel, createModel, createEmbeddingModel, createSummaryModel, embeddingFingerprint, isEmbeddingInputTooLong } from "../src/model.js";
import { configDefaults, type KernConfig } from "../src/config.js";
import { modelServer } from "./helpers/model-server.js";

const cfg = (overrides: Partial<KernConfig>): KernConfig => ({ ...configDefaults, ...overrides });

test("local embeddings work independently of hosted chat and without an API key", async t => {
  const server = await modelServer(t);
  const config = cfg({ embeddingModel: { provider: "openai-compatible", baseURL: server.baseURL, model: "org/local-embed", auth: "none" } });
  const result = await embed({ model: createEmbeddingModel(config)!, value: "remember this" });
  assert.equal(result.embedding.length, 4);
  assert.equal(server.requests[0].body.model, "org/local-embed");
  assert.equal(server.requests[0].path, "/v1/embeddings");
  assert.equal(server.requests[0].authorization, undefined);
  assert.equal(resolveModel(config).provider, "openrouter");
});

test("namespaced local summary ID stays local even with an OpenRouter key", async t => {
  const server = await modelServer(t);
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "unrelated-key";
  t.after(() => { if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved; });
  const config = cfg({ provider: "openai-compatible", baseURL: server.baseURL, model: "org/chat", summaryModel: "org/summary", auth: "none" });
  const result = await generateText({ model: createSummaryModel(config), prompt: "summarize" });
  assert.equal(result.text, "local response");
  assert.equal(server.requests[0].body.model, "org/summary");
  assert.equal(server.requests[0].authorization, undefined);
});

test("provider changes reset connection, credentials, and API selection", () => {
  const main = cfg({ provider: "openai-compatible", baseURL: "http://localhost:1234/v1", apiKeyEnv: "LOCAL_KEY", model: "local" });
  const summary = resolveModel(main, { provider: "openai", model: "gpt-small" });
  assert.equal(summary.baseURL, "https://api.openai.com/v1");
  assert.equal(summary.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(summary.auth, undefined);
  assert.equal(summary.api, "responses");
});

test("endpoint-only override never forwards parent credentials", () => {
  const config = cfg({ apiKeyEnv: "PRIVATE_GATEWAY_KEY" });
  const embedding = resolveModel(config, { model: "embed", baseURL: "http://localhost:8888/v1/" });
  assert.equal(embedding.auth, "none");
  assert.equal(embedding.apiKeyEnv, undefined);
  assert.equal(embedding.baseURL, "http://localhost:8888/v1");
});

test("same-connection string and object overrides inherit authentication", () => {
  const config = cfg({ provider: "openai-compatible", baseURL: "http://localhost:1234/v1", apiKeyEnv: "LOCAL_KEY", model: "chat" });
  for (const ref of ["embed", { model: "embed" }]) assert.equal(resolveModel(config, ref).apiKeyEnv, "LOCAL_KEY");
});

test("undefined secondary connection fields retain hosted provider defaults", () => {
  for (const provider of ["openai", "openrouter"]) {
    const ref = resolveModel(cfg({}), { provider, model: "embed", baseURL: undefined, apiKeyEnv: undefined, auth: undefined, api: undefined });
    assert.ok(ref.baseURL.startsWith("https://"));
    assert.equal(ref.apiKeyEnv, provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY");
    assert.equal(ref.api, provider === "openai" ? "responses" : "chat");
  }
});

test("explicit provider on the same custom URL never restores a hosted credential", async t => {
  const server = await modelServer(t);
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "hosted-key-must-stay-hosted";
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });
  for (const provider of ["openai", "openrouter", "anthropic"]) {
    const main = cfg({ provider, baseURL: server.baseURL, auth: "none", model: "chat" });
    const ref = resolveModel(main, { provider, baseURL: server.baseURL + "/", model: "secondary" });
    assert.equal(ref.auth, "none");
    assert.equal(ref.apiKeyEnv, undefined);
    assert.equal(resolveModel(main, { provider, baseURL: server.baseURL, apiKeyEnv: "LOCAL_KEY", model: "secondary" }).apiKeyEnv, "LOCAL_KEY");
  }
  const config = cfg({ provider: "openai", baseURL: server.baseURL, auth: "none", model: "chat", embeddingModel: { provider: "openai", baseURL: server.baseURL, model: "embed" } });
  await embed({ model: createEmbeddingModel(config)!, value: "local memory" });
  assert.equal(server.requests[0].authorization, undefined);
});

test("authenticated local model uses exactly its configured secret", async t => {
  const server = await modelServer(t);
  process.env.KERN_TEST_LOCAL_KEY = "test-local-key";
  t.after(() => { delete process.env.KERN_TEST_LOCAL_KEY; });
  await generateText({ model: createModel(cfg({ provider: "openai-compatible", baseURL: server.baseURL, apiKeyEnv: "KERN_TEST_LOCAL_KEY", model: "local" })), prompt: "hi" });
  assert.equal(server.requests[0].authorization, "Bearer test-local-key");
});

test("summary defaults are native Anthropic, or the main model for custom servers", () => {
  const anthropic = cfg({ provider: "anthropic", model: "claude-main" });
  assert.equal(resolveSummaryModel(anthropic).model, "claude-haiku-5");
  assert.equal(resolveSummaryModel(anthropic).provider, "anthropic");
  assert.equal(resolveEmbeddingModel(anthropic), null);
  const local = cfg({ provider: "openai", baseURL: "http://localhost:1234/v1", model: "local-main" });
  assert.equal(resolveSummaryModel(local).model, "local-main");
  assert.equal(resolveEmbeddingModel(local), null);
});

test("embedding defaults only apply to preset endpoints and honor disable", () => {
  assert.equal(resolveEmbeddingModel(cfg({ provider: "openai" }))?.model, "text-embedding-3-small");
  assert.equal(resolveEmbeddingModel(cfg({ provider: "ollama" }))?.model, "nomic-embed-text");
  assert.equal(resolveEmbeddingModel(cfg({ embeddingModel: false })), null);
  assert.equal(resolveEmbeddingModel(cfg({ recall: false })), null);
  assert.throws(() => resolveEmbeddingModel(cfg({ provider: "anthropic", embeddingModel: "embed" })), /no embeddings API/);
});

test("dimensions are passed to the embedding endpoint", async t => {
  const server = await modelServer(t);
  const config = cfg({ embeddingModel: { provider: "openai-compatible", baseURL: server.baseURL, model: "embed", dimensions: 4 } });
  await embed({ model: createEmbeddingModel(config)!, value: "test" });
  assert.equal(server.requests[0].body.dimensions, 4);
});

test("fingerprint detects same-dimension model changes but ignores secrets", () => {
  const a = resolveModel(cfg({}), { provider: "openai", model: "embed-a" });
  assert.notEqual(embeddingFingerprint(a, 4), embeddingFingerprint({ ...a, model: "embed-b" }, 4));
  assert.notEqual(embeddingFingerprint(a, 4), embeddingFingerprint({ ...a, baseURL: "https://another.example/v1" }, 4));
  assert.equal(embeddingFingerprint(a, 4), embeddingFingerprint({ ...a, apiKeyEnv: "ROTATED_KEY" }, 4));
});

test("legacy URL env vars no longer change routing", t => {
  const saved = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "http://localhost:9999/v1";
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved; });
  assert.equal(resolveModel(cfg({ provider: "openai" })).baseURL, "https://api.openai.com/v1");
});

test("only input-length errors trigger truncation", () => {
  assert.equal(isEmbeddingInputTooLong(new Error("maximum context length is 8192 tokens")), true);
  for (const message of ["Invalid API key", "Model not found", "fetch failed", "Rate limit exceeded"]) assert.equal(isEmbeddingInputTooLong(new Error(message)), false);
});

test("Anthropic summary references call the native Messages API", async t => {
  const server = await modelServer(t, () => ({ body: { id: "message-test", type: "message", role: "assistant", model: "haiku", content: [{ type: "text", text: "summary" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
  process.env.KERN_TEST_ANTHROPIC_KEY = "test-key";
  t.after(() => { delete process.env.KERN_TEST_ANTHROPIC_KEY; });
  const config = cfg({ summaryModel: { provider: "anthropic", baseURL: server.baseURL, model: "haiku", apiKeyEnv: "KERN_TEST_ANTHROPIC_KEY" } });
  const result = await generateText({ model: createSummaryModel(config), prompt: "summarize" });
  assert.equal(result.text, "summary");
  assert.equal(server.requests[0].path, "/v1/messages");
});
