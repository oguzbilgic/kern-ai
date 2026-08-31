import { test } from "node:test";
import assert from "node:assert";
import { summaryViaOpenRouter } from "../src/model.js";
import type { KernConfig } from "../src/config.js";

function cfg(overrides: Partial<KernConfig>): KernConfig {
  return { provider: "ollama", model: "gemma4:26b", summaryModel: "" , ...overrides } as KernConfig;
}

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
