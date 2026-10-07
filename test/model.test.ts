import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError, embed, generateText } from "ai";
import { configureConnection, resolveModel, resolveSummaryModel, resolveEmbeddingModel, createModel, createEmbeddingModel, createSummaryModel, embeddingFingerprint, isEmbeddingInputTooLong } from "../src/model.js";
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

test("explicit hosted preset URLs retain default credentials and API selection", async t => {
  for (const [provider, baseURL, apiKeyEnv, api] of [
    ["openai", "https://api.openai.com/v1", "OPENAI_API_KEY", "responses"],
    ["openrouter", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", "chat"],
    ["anthropic", "https://api.anthropic.com/v1", "ANTHROPIC_API_KEY", undefined],
  ] as const) {
    const resolved = resolveModel(cfg({ provider, baseURL: ` ${baseURL}/ ` }));
    assert.equal(resolved.baseURL, baseURL);
    assert.equal(resolved.auth, undefined);
    assert.equal(resolved.apiKeyEnv, apiKeyEnv);
    assert.equal(resolved.api, api);
  }
  const server = await modelServer(t, undefined, "https://api.openai.com/v1");
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "hosted-test-key";
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; });
  await embed({ model: createEmbeddingModel(cfg({ provider: "openai", baseURL: server.baseURL }))!, value: "memory" });
  assert.equal(server.requests[0].authorization, "Bearer hosted-test-key");
});

test("a secondary reference repeating the endpoint inherits the parent's Responses API", async t => {
  const server = await modelServer(t, request => {
    assert.equal(request.path, "/v1/responses");
    return { body: { id: "resp-test", created_at: 1, model: request.body.model, output: [{ type: "message", id: "msg-test", role: "assistant", content: [{ type: "output_text", text: "response-only", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
  });
  const main = cfg({ provider: "openai", baseURL: server.baseURL, api: "responses", auth: "none", model: "chat" });
  const ref = { model: "summary", baseURL: ` ${server.baseURL}/ ` };
  const result = await generateText({ model: createModel(main, ref), prompt: "summarize", maxRetries: 0 });
  assert.equal(result.text, "response-only");
  assert.equal(server.requests[0].authorization, undefined);
  // An explicit provider still resets to its own custom-endpoint defaults.
  assert.equal(resolveModel(main, { ...ref, provider: "openai" }).api, "chat");
});

test("endpoint changes reset the old API while equivalent setup URLs retain it", () => {
  const current = { provider: "openai", model: "chat", baseURL: "http://old.test/v1", api: "responses" as const, apiKeyEnv: "OLD_KEY" };
  const unchanged = configureConnection(current, { provider: "openai", baseURL: " http://old.test/v1/ " });
  assert.equal(resolveModel(cfg(unchanged)).api, "responses");
  assert.equal(unchanged.apiKeyEnv, "OLD_KEY");
  const replacement = configureConnection(current, { provider: "openai", baseURL: "http://new.test/v1" });
  const resolved = resolveModel(cfg(replacement));
  assert.equal(resolved.api, "chat");
  assert.equal(resolved.auth, "none");
  assert.equal(resolved.apiKeyEnv, undefined);
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

test("fingerprint detects same-dimension model changes but ignores hosts and secrets", () => {
  const a = resolveModel(cfg({}), { provider: "openai", model: "embed-a" });
  assert.notEqual(embeddingFingerprint(a, 4), embeddingFingerprint({ ...a, model: "embed-b" }, 4));
  assert.equal(embeddingFingerprint(a, 4), embeddingFingerprint({ ...a, baseURL: "https://another.example/v1" }, 4));
  assert.equal(embeddingFingerprint(a, 4), embeddingFingerprint({ ...a, apiKeyEnv: "ROTATED_KEY" }, 4));
});

test("legacy URL env vars no longer change routing", t => {
  const saved = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "http://localhost:9999/v1";
  t.after(() => { if (saved === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved; });
  assert.equal(resolveModel(cfg({ provider: "openai" })).baseURL, "https://api.openai.com/v1");
});

test("any 4xx body rejection triggers truncation; auth, routing, and transport errors do not", () => {
  const rejection = (statusCode: number, message: string) => new APICallError({ message, url: "http://local.test/v1/embeddings", requestBodyValues: {}, statusCode });
  assert.equal(isEmbeddingInputTooLong(rejection(400, "input is too large to process")), true);
  assert.equal(isEmbeddingInputTooLong(rejection(413, "Payload Too Large")), true);
  for (const [status, message] of [[401, "Invalid API key"], [404, "Model not found"], [429, "Rate limit exceeded"], [500, "Internal error"]] as const) assert.equal(isEmbeddingInputTooLong(rejection(status, message)), false);
  assert.equal(isEmbeddingInputTooLong(new Error("fetch failed")), false);
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
