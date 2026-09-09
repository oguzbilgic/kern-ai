import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createEmbeddingModel, summaryViaOpenRouter } from "../src/model.js";
import { configDefaults, type KernConfig } from "../src/config.js";

function cfg(overrides: Partial<KernConfig>): KernConfig {
  return { ...configDefaults, provider: "ollama", model: "gemma4:26b", ...overrides };
}

let savedKey: string | undefined;
let savedOpenAIKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  savedOpenAIKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAIKey;
});

test("summaryViaOpenRouter: ollama + namespaced ID + key → true", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.equal(summaryViaOpenRouter(cfg({ summaryModel: "openai/gpt-4.1-mini" })), true);
});

test("summaryViaOpenRouter: openai provider + namespaced ID + key → true", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.equal(
    summaryViaOpenRouter(cfg({ provider: "openai", summaryModel: "google/gemini-3.1-flash-lite" })),
    true,
  );
});

test("summaryViaOpenRouter: no summaryModel → false", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.equal(summaryViaOpenRouter(cfg({})), false);
});

test("summaryViaOpenRouter: local (non-namespaced) ID stays local", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.equal(summaryViaOpenRouter(cfg({ summaryModel: "gemma3:4b" })), false);
});

test("summaryViaOpenRouter: hf.co namespaced Ollama ID stays local", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.equal(summaryViaOpenRouter(cfg({ summaryModel: "hf.co/user/some-model" })), false);
  assert.equal(summaryViaOpenRouter(cfg({ summaryModel: "huggingface.co/user/some-model" })), false);
});

test("summaryViaOpenRouter: no OPENROUTER_API_KEY → false", () => {
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(summaryViaOpenRouter(cfg({ summaryModel: "openai/gpt-4.1-mini" })), false);
});

test("summaryViaOpenRouter: openrouter/anthropic providers unaffected", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  assert.equal(
    summaryViaOpenRouter(cfg({ provider: "openrouter", summaryModel: "openai/gpt-4.1-mini" })),
    false,
  );
  assert.equal(
    summaryViaOpenRouter(cfg({ provider: "anthropic", summaryModel: "anthropic/claude-haiku-4.5" })),
    false,
  );
});

test("createEmbeddingModel: embeddingModel overrides the provider default", () => {
  const model = createEmbeddingModel(cfg({ provider: "openai", embeddingModel: "gemini-embedding-001" })) as any;
  assert.equal(model.modelId, "gemini-embedding-001");
});

test("createEmbeddingModel: unset embeddingModel keeps the provider default", () => {
  const openai = createEmbeddingModel(cfg({ provider: "openai" })) as any;
  assert.equal(openai.modelId, "text-embedding-3-small");
  const ollama = createEmbeddingModel(cfg({})) as any;
  assert.equal(ollama.modelId, "nomic-embed-text");
});

test("createEmbeddingModel: override reaches the OpenRouter-backed providers too", () => {
  process.env.OPENROUTER_API_KEY = "test-key";
  const model = createEmbeddingModel(
    cfg({ provider: "anthropic", embeddingModel: "openai/text-embedding-3-large" }),
  ) as any;
  assert.equal(model.modelId, "openai/text-embedding-3-large");
});

test("createEmbeddingModel: still null when the provider has no key", () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(createEmbeddingModel(cfg({ provider: "openrouter", embeddingModel: "openai/text-embedding-3-large" })), null);
});
