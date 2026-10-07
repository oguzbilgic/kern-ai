import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapEmbeddingModel, type embed, type LanguageModel } from "ai";
import { createHash } from "crypto";
import { PROVIDER_IDS, type KernConfig, type ModelConnection, type ModelRef, type ModelSpec } from "./config.js";
import { log } from "./log.js";

const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://github.com/oguzbilgic/kern-ai",
  "X-Title": "Kern Agent",
  "X-OpenRouter-Title": "Kern Agent",
  "X-OpenRouter-Categories": "cli-agent,personal-agent",
};

const CONNECTION_DEFAULTS: Record<string, ModelConnection> = {
  openrouter: { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", api: "chat" },
  anthropic: { provider: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY" },
  openai: { provider: "openai", baseURL: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", api: "responses" },
  ollama: { provider: "ollama", baseURL: "http://localhost:11434/v1", auth: "none", api: "chat" },
  "openai-compatible": { provider: "openai-compatible", auth: "none", api: "chat" },
};

export interface ResolvedModel extends ModelConnection {
  model: string;
  baseURL: string;
  dimensions?: number;
}

/** Explicit provider or URL changes never carry credentials from another connection. */
function resolveConnection(input: Partial<ModelConnection>, parent?: ModelConnection): ModelConnection {
  const provider = input.provider ?? parent?.provider ?? "openrouter";
  if (!PROVIDER_IDS.includes(provider as typeof PROVIDER_IDS[number])) throw new Error(`Unknown provider: ${provider}`);
  const changesURL = input.baseURL !== undefined && normalizeURL(input.baseURL) !== parent?.baseURL;
  const base = input.provider !== undefined || changesURL || !parent ? CONNECTION_DEFAULTS[provider] : parent;
  const connection = { ...base, ...input, provider };
  // A custom API root defaults to no authentication, never a hosted-provider key.
  if (changesURL && input.apiKeyEnv === undefined && input.auth === undefined) {
    delete connection.apiKeyEnv;
    connection.auth = "none";
  }
  if (input.apiKeyEnv !== undefined) delete connection.auth;
  if (input.auth === "none") delete connection.apiKeyEnv;
  if (!connection.baseURL) throw new Error(`${provider} requires baseURL (the complete API root, including /v1)`);
  connection.baseURL = normalizeURL(connection.baseURL);
  if (input.baseURL !== undefined && input.api === undefined && provider === "openai") connection.api = "chat";
  if (connection.api === "responses" && provider !== "openai" && provider !== "openai-compatible") {
    throw new Error(`${provider} does not support api: responses`);
  }
  return connection;
}

function normalizeURL(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Model IDs are opaque. Slashes and the presence of unrelated keys never affect routing. */
export function resolveModel(config: KernConfig, ref: ModelRef = config.model): ResolvedModel {
  const { provider, baseURL, apiKeyEnv, auth, api } = config;
  const main = resolveConnection({ provider, ...(baseURL !== undefined ? { baseURL } : {}), ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}), ...(auth !== undefined ? { auth } : {}), ...(api !== undefined ? { api } : {}) });
  const spec: ModelSpec = typeof ref === "string" ? { model: ref } : ref;
  const { model, dimensions, ...overrides } = spec;
  if (!model.trim()) throw new Error("A non-empty model ID is required");
  return { ...resolveConnection(overrides, main), model, ...(dimensions !== undefined ? { dimensions } : {}) } as ResolvedModel;
}

export function resolveSummaryModel(config: KernConfig): ResolvedModel {
  if (config.summaryModel) return resolveModel(config, config.summaryModel);
  const main = resolveModel(config);
  const defaults: Record<string, string> = {
    openai: "gpt-6-luna", anthropic: "claude-haiku-5", openrouter: "google/gemini-3.5-flash-lite",
  };
  // A custom endpoint may not host any preset model; reuse its chat model.
  const preset = main.baseURL === CONNECTION_DEFAULTS[main.provider].baseURL;
  return { ...main, model: preset ? defaults[main.provider] ?? main.model : main.model };
}

export function resolveEmbeddingModel(config: KernConfig): ResolvedModel | null {
  if (!config.recall || config.embeddingModel === false) return null;
  if (config.embeddingModel) {
    const ref = resolveModel(config, config.embeddingModel);
    if (ref.provider === "anthropic") throw new Error("Anthropic has no embeddings API; configure embeddingModel with another provider");
    return ref;
  }
  const main = resolveModel(config);
  const defaults: Record<string, string> = { openai: "text-embedding-3-small", openrouter: "openai/text-embedding-3-small", ollama: "nomic-embed-text" };
  if (!defaults[main.provider] || main.baseURL !== CONNECTION_DEFAULTS[main.provider].baseURL) {
    log.warn("model", "No embeddingModel configured for this connection — recall and semantic segments disabled");
    return null;
  }
  return { ...main, model: defaults[main.provider] };
}

function apiKey(ref: ResolvedModel): string | undefined {
  if (ref.auth === "none") return undefined;
  const key = ref.apiKeyEnv && process.env[ref.apiKeyEnv];
  if (!key) throw new Error(`${ref.provider}: ${ref.apiKeyEnv ?? "apiKeyEnv"} is not set`);
  return key;
}

function compatibleClient(ref: ResolvedModel) {
  return createOpenAICompatible({ name: "openai", baseURL: ref.baseURL, apiKey: apiKey(ref), headers: ref.provider === "openrouter" ? OPENROUTER_HEADERS : undefined });
}

export function createResolvedModel(ref: ResolvedModel, audio = false): LanguageModel {
  const key = apiKey(ref);
  if (ref.provider === "anthropic") {
    if (!key) throw new Error("Anthropic requires authentication");
    return createAnthropic({ baseURL: ref.baseURL, apiKey: key })(ref.model);
  }
  if (ref.provider === "openrouter" && (audio || ref.model.startsWith("anthropic/"))) {
    if (!key) throw new Error("OpenRouter requires authentication");
    return createOpenRouter({ baseURL: ref.baseURL, apiKey: key, headers: OPENROUTER_HEADERS }).chat(ref.model);
  }
  if (ref.api === "responses") {
    // Native OpenAI Responses supports unauthenticated compatible endpoints too.
    const fetchWithoutAuth: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      return fetch(input, { ...init, headers });
    };
    return createOpenAI({ baseURL: ref.baseURL, apiKey: key ?? "unused", ...(ref.auth === "none" ? { fetch: fetchWithoutAuth } : {}) }).responses(ref.model);
  }
  if (ref.provider === "openai" && ref.baseURL === CONNECTION_DEFAULTS.openai.baseURL && key) {
    return createOpenAI({ baseURL: ref.baseURL, apiKey: key }).chat(ref.model);
  }
  return compatibleClient(ref).chatModel(ref.model);
}

export function createModel(config: KernConfig, ref: ModelRef = config.model): LanguageModel {
  return createResolvedModel(resolveModel(config, ref));
}

export function createSummaryModel(config: KernConfig): LanguageModel {
  return createResolvedModel(resolveSummaryModel(config));
}

export function createEmbeddingModel(config: KernConfig): Parameters<typeof embed>[0]["model"] | null {
  const ref = resolveEmbeddingModel(config);
  if (!ref) return null;
  const model = compatibleClient(ref).embeddingModel(ref.model);
  if (ref.dimensions === undefined) return model;
  return wrapEmbeddingModel({
    model,
    middleware: {
      specificationVersion: "v3",
      transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, dimensions: ref.dimensions! } } }),
    },
  });
}

/** Keys/auth do not define a vector space. Endpoint, model, and dimensions do. */
export function embeddingFingerprint(ref: ResolvedModel, dimensions: number): string {
  return createHash("sha256").update(JSON.stringify({ provider: ref.provider, baseURL: ref.baseURL, model: ref.model, dimensions, requestedDimensions: ref.dimensions ?? null })).digest("hex");
}

/** Same-provider fallbacks only; an explicit override is authoritative. */
export function modelChain(config: KernConfig, override: ModelRef, defaults: Record<string, string>): ResolvedModel[] {
  if (override) return [resolveModel(config, override)];
  const main = resolveModel(config);
  const fallback = main.baseURL === CONNECTION_DEFAULTS[main.provider].baseURL ? defaults[main.provider] : undefined;
  return fallback && fallback !== main.model ? [main, { ...main, model: fallback }] : [main];
}

export function createAudioModel(ref: ResolvedModel): LanguageModel {
  // OpenAI audio input uses Chat Completions, even when text chat uses Responses.
  return createResolvedModel(ref.provider === "openai" ? { ...ref, api: "chat" } : ref, true);
}

export function logModelRoutes(config: KernConfig): void {
  const routes: [string, ResolvedModel | null][] = [
    ["chat", resolveModel(config)], ["summary", resolveSummaryModel(config)], ["embedding", resolveEmbeddingModel(config)],
    ["subagent", resolveModel(config, config.subAgentModel || config.model)],
    ["vision", resolveModel(config, config.mediaModel || config.model)], ["audio", resolveModel(config, config.audioModel || config.model)],
  ];
  for (const [role, ref] of routes) {
    log("model", ref ? `${role}: ${ref.provider} / ${ref.model} @ ${ref.baseURL} (auth: ${ref.auth === "none" ? "none" : ref.apiKeyEnv}, api: ${ref.api ?? "native"})` : `${role}: disabled`);
  }
}

export function isEmbeddingInputTooLong(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /maximum context length|context[_ ]length[_ ]exceeded|input.{0,30}(too long|length exceeded)|too many tokens|exceeds?.{0,30}(token|context|input).{0,15}(limit|length)|token limit/i.test(message);
}
