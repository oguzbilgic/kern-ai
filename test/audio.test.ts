import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { getAudioModelChain, AUDIO_FALLBACKS, AUDIO_EXT_TO_MIME } from "../src/tools/audio.js";
import { configDefaults, type KernConfig } from "../src/config.js";

function cfg(overrides: Partial<KernConfig>): KernConfig {
  return { ...configDefaults, ...overrides };
}

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

test("openrouter provider: audioModel → model → fallback, all via openrouter", () => {
  const chain = getAudioModelChain(
    cfg({ provider: "openrouter", model: "anthropic/claude-opus-5", audioModel: "google/gemini-3.7-flash" }),
  );
  assert.deepEqual(chain, [
    { modelId: "google/gemini-3.7-flash", viaOpenRouter: true },
    { modelId: "anthropic/claude-opus-5", viaOpenRouter: true },
  ]);
});

test("openrouter provider without audioModel appends fallback", () => {
  const chain = getAudioModelChain(cfg({ provider: "openrouter", model: "anthropic/claude-opus-5" }));
  assert.deepEqual(chain, [
    { modelId: "anthropic/claude-opus-5", viaOpenRouter: true },
    { modelId: AUDIO_FALLBACKS.openrouter, viaOpenRouter: true },
  ]);
});

test("anthropic provider with OPENROUTER_API_KEY gets cross-provider fallback", () => {
  process.env.OPENROUTER_API_KEY = "sk-test";
  const chain = getAudioModelChain(cfg({ provider: "anthropic", model: "claude-opus-4-8" }));
  assert.deepEqual(chain, [
    { modelId: "claude-opus-4-8", viaOpenRouter: false },
    { modelId: AUDIO_FALLBACKS.openrouter, viaOpenRouter: true },
  ]);
});

test("anthropic provider without OPENROUTER_API_KEY has no openrouter entry", () => {
  delete process.env.OPENROUTER_API_KEY;
  const chain = getAudioModelChain(cfg({ provider: "anthropic", model: "claude-opus-4-8" }));
  assert.deepEqual(chain, [{ modelId: "claude-opus-4-8", viaOpenRouter: false }]);
});

test("openai provider: own fallback via provider, then cross-provider openrouter", () => {
  process.env.OPENROUTER_API_KEY = "sk-test";
  const chain = getAudioModelChain(cfg({ provider: "openai", model: "gpt-5.5" }));
  assert.deepEqual(chain, [
    { modelId: "gpt-5.5", viaOpenRouter: false },
    { modelId: AUDIO_FALLBACKS.openai, viaOpenRouter: false },
    { modelId: AUDIO_FALLBACKS.openrouter, viaOpenRouter: true },
  ]);
});

test("ollama provider with key: model via ollama, then openrouter fallback", () => {
  process.env.OPENROUTER_API_KEY = "sk-test";
  const chain = getAudioModelChain(cfg({ provider: "ollama", model: "qwen3.6:latest" }));
  assert.deepEqual(chain, [
    { modelId: "qwen3.6:latest", viaOpenRouter: false },
    { modelId: AUDIO_FALLBACKS.openrouter, viaOpenRouter: true },
  ]);
});

test("dedupes audioModel identical to chat model", () => {
  const chain = getAudioModelChain(
    cfg({ provider: "openrouter", model: "google/gemini-3.7-flash", audioModel: "google/gemini-3.7-flash" }),
  );
  assert.deepEqual(chain, [{ modelId: "google/gemini-3.7-flash", viaOpenRouter: true }]);
});

test("mime map covers telegram voice and common formats, not video", () => {
  assert.equal(AUDIO_EXT_TO_MIME[".ogg"], "audio/ogg");
  assert.equal(AUDIO_EXT_TO_MIME[".opus"], "audio/opus");
  assert.equal(AUDIO_EXT_TO_MIME[".m4a"], "audio/mp4");
  assert.equal(AUDIO_EXT_TO_MIME[".mp4"], undefined);
});
