import { test } from "node:test";
import assert from "node:assert/strict";
import { getAudioModelChain, AUDIO_FALLBACKS, AUDIO_EXT_TO_MIME } from "../src/tools/audio.js";
import { configDefaults, type KernConfig } from "../src/config.js";
const cfg = (overrides: Partial<KernConfig>): KernConfig => ({ ...configDefaults, ...overrides });

test("audio defaults remain on the main provider", () => {
  const chain = getAudioModelChain(cfg({ model: "anthropic/chat" }));
  assert.deepEqual(chain.map(ref => [ref.provider, ref.model]), [["openrouter", "anthropic/chat"], ["openrouter", AUDIO_FALLBACKS.openrouter]]);
});

test("explicit cross-provider audio override is authoritative", () => {
  const chain = getAudioModelChain(cfg({ provider: "anthropic", model: "claude", audioModel: { provider: "openrouter", model: "google/gemini-3.8-flash" } }));
  assert.deepEqual(chain.map(ref => [ref.provider, ref.model]), [["openrouter", "google/gemini-3.8-flash"]]);
});

test("an unrelated key never enables cloud fallback for local audio", t => {
  const saved = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  t.after(() => { if (saved === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = saved; });
  const chain = getAudioModelChain(cfg({ provider: "ollama", model: "local" }));
  assert.deepEqual(chain.map(ref => [ref.provider, ref.model]), [["ollama", "local"]]);
});

test("custom endpoints do not receive hosted audio fallback IDs", () => {
  assert.deepEqual(getAudioModelChain(cfg({ provider: "openai", baseURL: "http://localhost:1234/v1", model: "local" })).map(ref => ref.model), ["local"]);
});

test("dedupes provider fallback identical to chat model", () => {
  assert.equal(getAudioModelChain(cfg({ model: AUDIO_FALLBACKS.openrouter })).length, 1);
});

test("mime map covers Telegram voice and common audio formats", () => {
  assert.equal(AUDIO_EXT_TO_MIME[".ogg"], "audio/ogg");
  assert.equal(AUDIO_EXT_TO_MIME[".opus"], "audio/opus");
  assert.equal(AUDIO_EXT_TO_MIME[".m4a"], "audio/mp4");
  assert.equal(AUDIO_EXT_TO_MIME[".mp4"], undefined);
});

test("hosted OpenAI audio uses Chat Completions when text chat defaults to Responses", async t => {
  const { modelServer } = await import("./helpers/model-server.js");
  const { createAudioModel } = await import("../src/model.js");
  const { generateText } = await import("ai");
  const server = await modelServer(t, undefined, "https://api.openai.com/v1");
  process.env.KERN_TEST_OPENAI_KEY = "test-key";
  t.after(() => { delete process.env.KERN_TEST_OPENAI_KEY; });
  const chain = getAudioModelChain(cfg({ provider: "openai", apiKeyEnv: "KERN_TEST_OPENAI_KEY", model: "text-chat" }));
  const result = await generateText({ model: createAudioModel(chain[1]), messages: [{ role: "user", content: [{ type: "file", data: new Uint8Array([1, 2]), mediaType: "audio/wav" }] }] });
  assert.equal(result.text, "local response");
  assert.equal(server.requests[0].path, "/v1/chat/completions");
  assert.equal(server.requests[0].body.messages[0].content[0].type, "input_audio");
});
