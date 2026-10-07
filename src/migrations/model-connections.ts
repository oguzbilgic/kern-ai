import { parse } from "dotenv";
import type { Migration } from "./index.js";

/** One-time conversion; legacy environment variables are never read by routing. */
export const modelConnections: Migration = {
  targetVersion: "0.43.0-next",
  description: "Move legacy model endpoints into explicit connections",
  migrate({ config, env }) {
    const next = { ...config };
    const secrets = { ...process.env, ...parse(env ?? "") };
    const provider = secrets.KERN_PROVIDER || next.provider || "openrouter";
    const openRouterKey = secrets.OPENROUTER_API_KEY || secrets.OPENAI_API_KEY;
    const openRouter = (model: string) => ({ provider: "openrouter", model,
      ...(!secrets.OPENROUTER_API_KEY && secrets.OPENAI_API_KEY ? { apiKeyEnv: "OPENAI_API_KEY" } : {}) });

    // Explicit new connection fields always win. Keep .env intact so an
    // interrupted run can derive the same result on retry.
    if (next.baseURL === undefined && provider === "openai" && secrets.OPENAI_BASE_URL?.trim()) {
      next.baseURL = secrets.OPENAI_BASE_URL.trim().replace(/\/+$/, "");
      next.api ??= "chat";
      if (next.apiKeyEnv === undefined && next.auth === undefined) {
        if (secrets.OPENAI_API_KEY) next.apiKeyEnv = "OPENAI_API_KEY";
        else next.auth = "none";
      }
      next.embeddingModel ??= "text-embedding-3-small";
      next.summaryModel ||= "gpt-6-luna";
    }
    if (provider === "ollama") {
      if (next.baseURL === undefined && secrets.OLLAMA_BASE_URL?.trim()) {
        next.baseURL = `${secrets.OLLAMA_BASE_URL.trim().replace(/\/+$/, "")}/v1`;
      }
      next.embeddingModel ??= "nomic-embed-text";
    }

    // Preserve routes that the old factories chose implicitly, then retire
    // the inference from the runtime. String shorthand stays valid elsewhere.
    if (provider === "anthropic") {
      if (typeof next.summaryModel === "string" && next.summaryModel) next.summaryModel = openRouter(next.summaryModel);
      else if (next.summaryModel === undefined || next.summaryModel === "") next.summaryModel = openRouter("anthropic/claude-haiku-5");
      if (next.embeddingModel === undefined && openRouterKey) next.embeddingModel = openRouter("openai/text-embedding-3-small");
    } else if ((provider === "openai" || provider === "ollama") && secrets.OPENROUTER_API_KEY &&
      typeof next.summaryModel === "string" && next.summaryModel.includes("/") &&
      !next.summaryModel.startsWith("hf.co/") && !next.summaryModel.startsWith("huggingface.co/")) {
      next.summaryModel = openRouter(next.summaryModel);
    }
    return { config: next, env };
  },
};
