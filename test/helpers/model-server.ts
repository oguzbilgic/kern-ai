import type { TestContext } from "node:test";

export interface ModelRequest { path: string; body: any; authorization?: string; }

/** Exercises real SDK serialization/parsing against an in-memory HTTP endpoint. */
export async function modelServer(t: TestContext, reply?: (request: ModelRequest) => { status?: number; body: unknown }, baseURL = "http://local.test/v1") {
  const requests: ModelRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseURL + "/")) throw new Error(`Unexpected endpoint: ${url}`);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const raw = init?.body ? String(init.body) : input instanceof Request ? await input.text() : "";
    const request = { path: new URL(url).pathname, body: raw ? JSON.parse(raw) : undefined, authorization: headers.get("authorization") ?? undefined };
    requests.push(request);
    const custom = reply?.(request);
    const body = custom?.body ?? (request.path.endsWith("/models")
      ? { data: [{ id: "org/local-chat" }, { id: "org/local-embed" }] }
      : request.path.endsWith("/embeddings")
        ? { object: "list", model: request.body.model, data: (Array.isArray(request.body.input) ? request.body.input : [request.body.input]).map((_: unknown, index: number) => ({ object: "embedding", index, embedding: [0.1, 0.2, 0.3, 0.4] })), usage: { prompt_tokens: 1, total_tokens: 1 } }
        : { id: "chat-test", object: "chat.completion", created: 1, model: request.body.model, choices: [{ index: 0, message: { role: "assistant", content: "local response" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    return new Response(JSON.stringify(body), { status: custom?.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { baseURL, requests };
}
