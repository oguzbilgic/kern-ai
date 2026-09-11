import { tool } from "ai";
import { z } from "zod";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

let _apiKey: string | null = null;

export function setOpenRouterKey(key: string | null) {
  _apiKey = key;
}

export function getOpenRouterKey(): string | null {
  return _apiKey || process.env.OPENROUTER_API_KEY || null;
}

export const openrouterTool = tool({
  description:
    "Inspect OpenRouter API key limits, credit usage, available models, pricing, and generation metadata.",
  inputSchema: z.object({
    action: z
      .enum(["key", "models", "generation"])
      .describe(
        "key: get current API key information, rate limits, credit balance, and daily/monthly usage. models: search or list available models with pricing, context length, and architecture. generation: get metadata, token usage, and cost for a specific generation ID.",
      ),
    query: z
      .string()
      .optional()
      .describe("Search query for 'models' action (e.g. 'claude', 'gemini', 'qwen', 'deepseek')"),
    category: z
      .string()
      .optional()
      .describe("Filter models by category (e.g. 'programming', 'technology', 'science')"),
    limit: z
      .number()
      .optional()
      .describe("Maximum number of models to return (default 20, max 100)"),
    generationId: z
      .string()
      .optional()
      .describe("Generation ID for 'generation' action (e.g. 'gen-xxxxxx')"),
  }),
  execute: async ({ action, query, category, limit = 20, generationId }) => {
    const key = getOpenRouterKey();
    if (!key) {
      return {
        error: "OpenRouter API key is not available. Ensure OPENROUTER_API_KEY is configured in your environment.",
      };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-OpenRouter-Title": "kern",
    };

    try {
      switch (action) {
        case "key": {
          const res = await fetch(`${OPENROUTER_API_BASE}/key`, {
            method: "GET",
            headers,
          });
          if (!res.ok) {
            const errText = await res.text();
            return { error: `OpenRouter API error (${res.status}): ${errText}` };
          }
          const body = (await res.json()) as any;
          const data = body.data || {};
          return {
            label: data.label,
            usage: data.usage,
            usageDaily: data.usage_daily,
            usageWeekly: data.usage_weekly,
            usageMonthly: data.usage_monthly,
            byokUsage: data.byok_usage,
            limit: data.limit,
            limitRemaining: data.limit_remaining,
            limitReset: data.limit_reset,
            isFreeTier: data.is_free_tier,
            rateLimit: data.rate_limit,
          };
        }

        case "models": {
          const url = new URL(`${OPENROUTER_API_BASE}/models`);
          if (query) url.searchParams.set("q", query);
          if (category) url.searchParams.set("category", category);

          const res = await fetch(url.toString(), {
            method: "GET",
            headers,
          });
          if (!res.ok) {
            const errText = await res.text();
            return { error: `OpenRouter API error (${res.status}): ${errText}` };
          }
          const body = (await res.json()) as any;
          const allModels: any[] = body.data || [];
          const clampedLimit = Math.min(Math.max(1, limit), 100);
          const sliced = allModels.slice(0, clampedLimit);

          return {
            total: allModels.length,
            count: sliced.length,
            models: sliced.map((m) => ({
              id: m.id,
              name: m.name,
              contextLength: m.context_length,
              pricing: {
                promptPerMillion: m.pricing?.prompt ? Number(m.pricing.prompt) * 1_000_000 : 0,
                completionPerMillion: m.pricing?.completion ? Number(m.pricing.completion) * 1_000_000 : 0,
              },
              modalities: m.architecture?.input_modalities,
              topProvider: m.top_provider?.is_moderated ? "moderated" : "unmoderated",
            })),
          };
        }

        case "generation": {
          if (!generationId) {
            return { error: "generationId is required for 'generation' action" };
          }
          const url = new URL(`${OPENROUTER_API_BASE}/generation`);
          url.searchParams.set("id", generationId);

          const res = await fetch(url.toString(), {
            method: "GET",
            headers,
          });
          if (!res.ok) {
            const errText = await res.text();
            return { error: `OpenRouter API error (${res.status}): ${errText}` };
          }
          const body = (await res.json()) as any;
          const data = body.data || {};
          return {
            id: data.id,
            model: data.model,
            providerName: data.provider_name,
            totalCost: data.total_cost,
            tokensPrompt: data.tokens_prompt,
            tokensCompletion: data.tokens_completion,
            nativeTokensCached: data.native_tokens_cached,
            nativeTokensReasoning: data.native_tokens_reasoning,
            generationTime: data.generation_time,
            latency: data.latency,
            finishReason: data.finish_reason,
            createdAt: data.created_at,
          };
        }

        default:
          return { error: `Unknown action '${action}'` };
      }
    } catch (err: any) {
      return { error: `OpenRouter API request failed: ${err.message}` };
    }
  },
});
