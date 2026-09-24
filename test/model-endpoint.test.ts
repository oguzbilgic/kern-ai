import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateText, streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { createModel } from "../src/model.js";
import { configDefaults, type KernConfig } from "../src/config.js";

const GOOGLE = "https://generativelanguage.googleapis.com/v1beta/openai/";
const SIGNATURE = "test-thought-signature";

const cfg = (overrides: Partial<KernConfig> = {}): KernConfig => ({
  ...configDefaults,
  provider: "openai",
  model: "gemini-3.8-flash",
  ...overrides,
});

const sse = (chunks: unknown[]) =>
  new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/** A tool-call delta shaped like Google's: no `index`, signature in extra_content. */
const googleToolCallChunk = {
  id: "1",
  object: "chat.completion.chunk",
  created: 1,
  model: "gemini-3.8-flash",
  choices: [
    {
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [
          {
            extra_content: { google: { thought_signature: SIGNATURE } },
            function: { name: "weather", arguments: '{"city":"Paris"}' },
            id: "call_1",
            type: "function",
          },
        ],
      },
    },
  ],
};

const finish = (reason: string) => ({
  id: "1",
  object: "chat.completion.chunk",
  created: 1,
  model: "gemini-3.8-flash",
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
});

let savedBase: string | undefined;
let savedKey: string | undefined;
let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  savedBase = process.env.OPENAI_BASE_URL;
  savedKey = process.env.OPENAI_API_KEY;
  savedFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = savedBase;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

test("google endpoint: an index-less tool call runs and its signature goes back", async () => {
  process.env.OPENAI_BASE_URL = GOOGLE;
  const requests: any[] = [];
  const responses = [
    sse([googleToolCallChunk, finish("tool_calls")]),
    sse([
      { id: "1", object: "chat.completion.chunk", created: 1, model: "gemini-3.8-flash", choices: [{ index: 0, delta: { content: "20C in Paris." } }] },
      finish("stop"),
    ]),
  ];
  globalThis.fetch = (async (_url: any, init: any) => {
    requests.push(JSON.parse(init.body));
    return responses.shift()!;
  }) as typeof globalThis.fetch;

  const called: string[] = [];
  const result = streamText({
    model: createModel(cfg()),
    tools: {
      weather: tool({
        description: "Weather for a city.",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          called.push(city);
          return `${city}: 20C`;
        },
      }),
    },
    stopWhen: stepCountIs(3),
    prompt: "weather in Paris?",
  });
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
  }

  assert.deepEqual(called, ["Paris"], "the tool must run despite the missing index");
  assert.equal(requests.length, 2, "the tool result must produce a second request");
  const assistant = requests[1].messages.find((m: any) => m.role === "assistant" && m.tool_calls);
  assert.equal(
    assistant?.tool_calls[0].extra_content?.google?.thought_signature,
    SIGNATURE,
    "Google rejects the follow-up unless the signature comes back",
  );
  assert.equal(requests[0].stream_options?.include_usage, true, "usage must still be requested");
  assert.equal((await result.usage).totalTokens, 7);
});

test("other custom endpoints keep the OpenAI request shape for reasoning models", async () => {
  process.env.OPENAI_BASE_URL = "https://my-gateway.example.com/v1";
  let body: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        id: "1", object: "chat.completion", created: 1, model: "gpt-5.4",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;

  await generateText({ model: createModel(cfg({ model: "gpt-5.4" })), system: "Be brief.", prompt: "hi", maxOutputTokens: 321 });

  assert.equal(body.messages[0].role, "developer", "reasoning models take a developer message");
  assert.equal(body.max_completion_tokens, 321, "reasoning models need max_completion_tokens, not max_tokens");
});

test("no base URL leaves the OpenAI provider alone", () => {
  delete process.env.OPENAI_BASE_URL;
  const model = createModel(cfg({ model: "gpt-5.5" }));
  assert.match(model.provider, /^openai\./);
  assert.equal(model.modelId, "gpt-5.5");
});
