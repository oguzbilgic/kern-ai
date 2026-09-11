import test from "node:test";
import assert from "node:assert/strict";
import { openrouterTool, setOpenRouterKey } from "../src/plugins/openrouter/tools.js";

const origFetch = globalThis.fetch;

test("openrouterTool: returns error when api key is not set", async () => {
  setOpenRouterKey(null);
  delete process.env.OPENROUTER_API_KEY;
  const result = await (openrouterTool as any).execute({ action: "key" });
  assert.ok(result.error);
  assert.match(result.error, /OpenRouter API key is not available/);
});

test("openrouterTool: handles 'key' action", async () => {
  setOpenRouterKey("sk-or-test-key");
  const mockData = {
    label: "sk-or-test...123",
    usage: 12.5,
    usage_daily: 2.1,
    usage_weekly: 5.4,
    usage_monthly: 12.5,
    byok_usage: 0,
    limit: 100,
    limit_remaining: 87.5,
    limit_reset: "monthly",
    is_free_tier: false,
    rate_limit: { requests: 1000, interval: "1h" },
  };

  let fetchedUrl = "";
  let fetchedOptions: any = null;
  globalThis.fetch = (async (url: any, opts: any) => {
    fetchedUrl = url.toString();
    fetchedOptions = opts;
    return {
      ok: true,
      async json() {
        return { data: mockData };
      },
    } as any;
  }) as any;

  try {
    const result = await (openrouterTool as any).execute({ action: "key" });
    assert.equal(fetchedUrl, "https://openrouter.ai/api/v1/key");
    assert.equal(fetchedOptions.headers.Authorization, "Bearer sk-or-test-key");
    assert.deepEqual(result, {
      label: "sk-or-test...123",
      usage: 12.5,
      usageDaily: 2.1,
      usageWeekly: 5.4,
      usageMonthly: 12.5,
      byokUsage: 0,
      limit: 100,
      limitRemaining: 87.5,
      limitReset: "monthly",
      isFreeTier: false,
      rateLimit: { requests: 1000, interval: "1h" },
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("openrouterTool: handles 'models' action", async () => {
  setOpenRouterKey("sk-or-test-key");
  const mockModels = [
    {
      id: "anthropic/claude-3.5-sonnet",
      name: "Claude 3.5 Sonnet",
      context_length: 200000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      architecture: { input_modalities: ["text", "image"] },
      top_provider: { is_moderated: true },
    },
    {
      id: "deepseek/deepseek-chat",
      name: "DeepSeek V3",
      context_length: 64000,
      pricing: { prompt: "0.00000014", completion: "0.00000028" },
      architecture: { input_modalities: ["text"] },
      top_provider: { is_moderated: false },
    },
  ];

  let fetchedUrl = "";
  globalThis.fetch = (async (url: any) => {
    fetchedUrl = url.toString();
    return {
      ok: true,
      async json() {
        return { data: mockModels };
      },
    } as any;
  }) as any;

  try {
    const result = await (openrouterTool as any).execute({
      action: "models",
      query: "claude",
      limit: 10,
    });

    assert.equal(fetchedUrl, "https://openrouter.ai/api/v1/models?q=claude");
    assert.equal(result.total, 2);
    assert.equal(result.count, 2);
    assert.equal(result.models[0].pricing.promptPerMillion, 3);
    assert.equal(result.models[0].pricing.completionPerMillion, 15);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("openrouterTool: handles 'generation' action", async () => {
  setOpenRouterKey("sk-or-test-key");
  const mockGen = {
    id: "gen-12345",
    model: "anthropic/claude-3.5-sonnet",
    provider_name: "Anthropic",
    total_cost: 0.0025,
    tokens_prompt: 500,
    tokens_completion: 120,
    native_tokens_cached: 400,
    native_tokens_reasoning: 0,
    generation_time: 1400,
    latency: 1450,
    finish_reason: "stop",
    created_at: "2026-09-10T20:00:00Z",
  };

  let fetchedUrl = "";
  globalThis.fetch = (async (url: any) => {
    fetchedUrl = url.toString();
    return {
      ok: true,
      async json() {
        return { data: mockGen };
      },
    } as any;
  }) as any;

  try {
    const result = await (openrouterTool as any).execute({
      action: "generation",
      generationId: "gen-12345",
    });

    assert.equal(fetchedUrl, "https://openrouter.ai/api/v1/generation?id=gen-12345");
    assert.equal(result.id, "gen-12345");
    assert.equal(result.totalCost, 0.0025);
    assert.equal(result.tokensPrompt, 500);
  } finally {
    globalThis.fetch = origFetch;
  }
});
