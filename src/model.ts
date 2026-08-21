import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { embed } from "ai";
import type { KernConfig } from "./config.js";

/** Normalized OPENAI_BASE_URL — trimmed, trailing slashes stripped, undefined if unset/empty. */
function openaiBaseURL(): string | undefined {
  const raw = process.env.OPENAI_BASE_URL?.trim().replace(/\/+$/, "");
  return raw || undefined;
}

const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/oguzbilgic/kern-ai",
  "X-Title": "Kern Agent",
  "X-OpenRouter-Title": "Kern Agent",
  "X-OpenRouter-Categories": "cli-agent,personal-agent",
};

/**
 * Create an OpenAI-compatible client for a given provider.
 * Used by embedding and summary model factories.
 */
function createOpenAIClient(provider: string) {
  switch (provider) {
    case "openai":
      return createOpenAI({ baseURL: openaiBaseURL() });
    case "ollama": {
      const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
      return createOpenAI({
        baseURL: `${base}/v1`,
        apiKey: "ollama",
      });
    }
    default: {
      // openrouter, anthropic, or anything else — fall back to OpenRouter
      const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      return createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        headers: OPENROUTER_HEADERS,
      });
    }
  }
}

/**
 * Create an embedding model for recall and segments.
 * Returns null if no suitable provider/key is available.
 *
 * Defaults by provider:
 * - openai: text-embedding-3-small
 * - anthropic: openai/text-embedding-3-small (Anthropic has no embeddings API; routed via OpenRouter)
 * - openrouter: openai/text-embedding-3-small
 * - ollama: nomic-embed-text (local, no API key)
 */
export function createEmbeddingModel(config: KernConfig): Parameters<typeof embed>[0]["model"] | null {
  const client = createOpenAIClient(config.provider);
  if (!client) return null;

  switch (config.provider) {
    case "openai":
      return client.embeddingModel("text-embedding-3-small");
    case "anthropic":
      return client.embeddingModel("openai/text-embedding-3-small");
    case "openrouter":
      return client.embeddingModel("openai/text-embedding-3-small");
    case "ollama":
      return client.embeddingModel("nomic-embed-text");
    default:
      return client.embeddingModel("openai/text-embedding-3-small");
  }
}

/**
 * Create a cheap chat model for segment summarization.
 * Returns null if no suitable provider/key is available.
 *
 * Summary calls always go through an OpenAI-compatible client. Routing:
 * - openai → OpenAI
 * - ollama → local Ollama (OpenAI-compat endpoint)
 * - anthropic / openrouter / anything else → OpenRouter
 *
 * That means for `provider: "anthropic"` the summary route is OpenRouter,
 * not the native Anthropic SDK — so `summaryModel` on Anthropic agents
 * needs an OpenRouter-style ID (e.g. `anthropic/claude-haiku-4.5`).
 *
 * Model selection:
 * - If `config.summaryModel` is set, use it.
 * - Otherwise, use a provider-specific default:
 *   - openai: gpt-4.1-mini
 *   - anthropic: anthropic/claude-haiku-4.5 (via OpenRouter)
 *   - openrouter: openai/gpt-4.1-mini
 *   - ollama: reuses the agent's chat model (avoids forcing users to pull
 *     a separate model just for summaries)
 *
 * Useful for separating a thinking chat model from a non-thinking summary
 * model — thinking models burn the output budget on reasoning tokens and
 * return empty summaries.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSummaryModel(config: KernConfig): any {
  const client = createOpenAIClient(config.provider);
  if (!client) return null;

  if (config.summaryModel) return client.chat(config.summaryModel);

  switch (config.provider) {
    case "openai":
      return client.chat("gpt-4.1-mini");
    case "anthropic":
      return client.chat("anthropic/claude-haiku-4.5");
    case "openrouter":
      return client.chat("openai/gpt-4.1-mini");
    case "ollama":
      return client.chat(config.model);
    default:
      return client.chat("openai/gpt-4.1-mini");
  }
}

/**
 * A single entry in the audio model fallback chain.
 * `viaOpenRouter` routes the call through the OpenRouter-native provider
 * regardless of the agent's own provider — used both for openrouter agents
 * (the generic OpenAI-compatible shim only maps `audio/wav` and `audio/mpeg`
 * file parts to `input_audio` and rejects ogg/opus, the Telegram voice
 * format) and as a cross-provider fallback for agents whose provider has no
 * audio-capable models at all (anthropic, ollama).
 */
export interface AudioModelRef {
  modelId: string;
  viaOpenRouter: boolean;
}

/**
 * Create a model instance for audio input (transcription / analysis).
 * See {@link AudioModelRef} for why routing is explicit per entry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAudioModel(config: KernConfig, ref: AudioModelRef): any {
  if (ref.viaOpenRouter) {
    const openrouter = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
      headers: OPENROUTER_HEADERS,
    });
    return openrouter.chat(ref.modelId);
  }
  return createModel({ ...config, model: ref.modelId });
}

/**
 * Create an AI SDK model instance from kern config.
 * Shared across runtime (chat) and notes (summary generation).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createModel(config: KernConfig): any {
  switch (config.provider) {
    case "anthropic": {
      const anthropic = createAnthropic();
      return anthropic(config.model);
    }
    case "openrouter": {
      // Use OpenRouter-native provider for Anthropic models (prompt caching support),
      // generic OpenAI-compatible provider for everything else (more reliable streaming)
      if (config.model.startsWith("anthropic/")) {
        const openrouter = createOpenRouter({
          apiKey: process.env.OPENROUTER_API_KEY,
          headers: OPENROUTER_HEADERS,
        });
        return openrouter.chat(config.model);
      }
      const openai = createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        headers: OPENROUTER_HEADERS,
      });
      // Force chat completions API — default openai() uses Responses API
      // for newer models (gpt-5.x, o3, etc.) which OpenRouter doesn't support
      return openai.chat(config.model);
    }
    case "openai": {
      const baseURL = openaiBaseURL();
      const openai = createOpenAI({ baseURL });
      // Custom OpenAI-compatible endpoints (Azure, LiteLLM, local proxies)
      // typically only support the Chat Completions API, not the Responses API
      // that the default openai() factory picks for newer models
      if (baseURL) return openai.chat(config.model);
      return openai(config.model);
    }
    case "ollama": {
      const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/+$/, "");
      const ollama = createOpenAI({
        baseURL: `${base}/v1`,
        apiKey: "ollama", // required by SDK but ignored by Ollama
      });
      return ollama.chat(config.model);
    }
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
