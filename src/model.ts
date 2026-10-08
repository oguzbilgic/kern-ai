import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, wrapEmbeddingModel, type embed, type LanguageModel } from "ai";
import { createHash } from "crypto";
import type { KernConfig, ModelConnection, ModelRef, ModelSpec } from "./config.js";
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

const CONNECTION_FIELDS = ["provider", "baseURL", "apiKeyEnv", "auth", "api"] as const;

export function connectionSettings(input: Partial<ModelConnection>): Partial<ModelConnection> {
  return Object.fromEntries(CONNECTION_FIELDS.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
}

function connectionIdentity(input: Partial<ModelConnection>) {
  const provider = input.provider ?? "openrouter";
  return { provider, baseURL: normalizeURL(input.baseURL ?? CONNECTION_DEFAULTS[provider]?.baseURL ?? "") };
}

/** Setup updates preserve omitted settings on the same connection. */
export function configureConnection<T extends Partial<ModelConnection>>(current: T, updates: Partial<ModelConnection>): T & ModelConnection {
  const input = connectionSettings(updates);
  const previous = connectionIdentity(current);
  const provider = input.provider ?? previous.provider;
  const replacing = provider !== previous.provider || (input.baseURL !== undefined && normalizeURL(input.baseURL) !== previous.baseURL);
  const settings = replacing ? {} : connectionSettings(current);
  if (input.apiKeyEnv !== undefined) delete settings.auth;
  if (input.auth !== undefined) delete settings.apiKeyEnv;
  const rest = { ...current };
  for (const key of CONNECTION_FIELDS) delete rest[key];
  return pruneConnection({ ...rest, ...settings, ...input, provider });
}

function sameConnection(a: Partial<ModelConnection>, b: Partial<ModelConnection>): boolean {
  try { return JSON.stringify(connectionSettings(resolveConnection(a))) === JSON.stringify(connectionSettings(resolveConnection(b))); }
  catch { return false; }
}

/** Store only what the resolver cannot infer, so converted and freshly configured agents look alike. */
export function pruneConnection<T extends object>(config: T): T {
  const result = { ...config } as T & Partial<ModelConnection>;
  for (const key of ["api", "auth", "apiKeyEnv", "baseURL"] as const) {
    const { [key]: _, ...without } = result;
    if (key in result && sameConnection(without, result)) delete result[key];
  }
  return result;
}

/** Explicit provider or URL changes never carry credentials from another connection. */
function resolveConnection(input: Partial<ModelConnection>, parent?: ModelConnection): ModelConnection {
  input = connectionSettings(input);
  const provider = input.provider ?? parent?.provider ?? "openrouter";
  if (!Object.hasOwn(CONNECTION_DEFAULTS, provider)) throw new Error(`Unknown provider: ${provider}`);
  const defaults = CONNECTION_DEFAULTS[provider];
  const baseURL = input.baseURL === undefined ? undefined : normalizeURL(input.baseURL);
  const changesURL = baseURL !== undefined && baseURL !== connectionIdentity(parent ?? defaults).baseURL;
  const resetsConnection = input.provider !== undefined || changesURL || !parent;
  const base = resetsConnection ? defaults : parent;
  const connection = { ...base, ...input, provider };
  // A custom API root defaults to no authentication, never a hosted-provider key.
  const customURL = baseURL !== undefined && baseURL !== defaults.baseURL;
  if ((changesURL || (resetsConnection && customURL)) && input.apiKeyEnv === undefined && input.auth === undefined) {
    delete connection.apiKeyEnv;
    connection.auth = "none";
  }
  if (input.apiKeyEnv !== undefined) delete connection.auth;
  if (input.auth === "none") delete connection.apiKeyEnv;
  if (!connection.baseURL) throw new Error(`${provider} requires baseURL (the complete API root, including /v1)`);
  connection.baseURL = normalizeURL(connection.baseURL);
  if (resetsConnection && customURL && input.api === undefined && provider === "openai") connection.api = "chat";
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
  const main = resolveConnection(config);
  const spec: ModelSpec = typeof ref === "string" ? { model: ref } : ref;
  const { model, dimensions, ...overrides } = spec;
  if (!model.trim()) throw new Error("A non-empty model ID is required");
  return { ...resolveConnection(overrides, main), model, ...(dimensions !== undefined ? { dimensions } : {}) } as ResolvedModel;
}

export function resolveSummaryModel(config: KernConfig): ResolvedModel {
  if (config.summaryModel) return resolveModel(config, config.summaryModel);
  const main = resolveModel(config);
  const defaults: Record<string, string> = {
    openai: "gpt-6-luna", anthropic: "claude-haiku-5-5", openrouter: "google/gemini-3.5-flash-lite",
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

/** Validate all model routes without contacting providers or reading secrets. */
export function validateModelRoutes(config: KernConfig): void {
  resolveModel(config);
  resolveSummaryModel(config);
  resolveEmbeddingModel(config);
  for (const key of ["subAgentModel", "mediaModel", "audioModel"] as const) {
    if (config[key]) resolveModel(config, config[key]);
  }
}

function apiKey(ref: ResolvedModel): string | undefined {
  if (ref.auth === "none") return undefined;
  const key = ref.apiKeyEnv && process.env[ref.apiKeyEnv];
  if (!key) throw new Error(`${ref.provider}: ${ref.apiKeyEnv ?? "apiKeyEnv"} is not set`);
  return key;
}

/** The official client infers capabilities from model IDs and validates provider options against OpenAI's schema, so it serves api.openai.com only. */
function isHostedOpenAI(ref: ResolvedModel): boolean {
  return ref.provider === "openai" && ref.baseURL === CONNECTION_DEFAULTS.openai.baseURL;
}

function officialClient(ref: ResolvedModel) {
  return createOpenAI({ baseURL: ref.baseURL, apiKey: apiKey(ref) });
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
    // The compatible client has no Responses API; the official one serves it for any endpoint.
    const fetchWithoutAuth: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete("authorization");
      return fetch(input, { ...init, headers });
    };
    return createOpenAI({ baseURL: ref.baseURL, apiKey: key ?? "unused", ...(ref.auth === "none" ? { fetch: fetchWithoutAuth } : {}) }).responses(ref.model);
  }
  if (isHostedOpenAI(ref)) return officialClient(ref).chat(ref.model);
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
  const model = (isHostedOpenAI(ref) ? officialClient(ref) : compatibleClient(ref)).embeddingModel(ref.model);
  if (ref.dimensions === undefined) return model;
  return wrapEmbeddingModel({
    model,
    middleware: {
      specificationVersion: "v3",
      transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, openai: { ...params.providerOptions?.openai, dimensions: ref.dimensions! } } }),
    },
  });
}

/** Model and dimensions define a vector space; moving the same model to another host or key does not. */
export function embeddingFingerprint(ref: ResolvedModel, dimensions: number): string {
  return createHash("sha256").update(JSON.stringify({ model: ref.model, dimensions, requestedDimensions: ref.dimensions ?? null })).digest("hex");
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

/** Servers word length rejections differently; a 4xx rejection of the request body is the reliable signal. Auth, routing, rate-limit, and transport errors are not. */
export function isEmbeddingInputTooLong(err: unknown): boolean {
  return APICallError.isInstance(err) && [400, 413, 422].includes(err.statusCode ?? 0);
}
