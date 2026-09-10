import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderError } from "../src/runtime.js";

test("parseProviderError: unwraps JSON responseBody on 429 rate limit error", () => {
  const error = {
    message: "Provider returned error",
    statusCode: 429,
    responseBody: JSON.stringify({
      error: {
        message: "Rate limit exceeded for model google/gemini-3.8-flash: 15 RPM",
        code: 429,
      },
    }),
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "rate_limit");
  assert.equal(
    res.message,
    "Rate limit hit (429): Rate limit exceeded for model google/gemini-3.8-flash: 15 RPM"
  );
});

test("parseProviderError: handles rate limit when status code is 429 without response body", () => {
  const error = {
    message: "Provider returned error",
    statusCode: 429,
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "rate_limit");
  assert.equal(res.message, "Rate limit hit (429) — wait a moment and try again");
});

test("parseProviderError: unwraps 402 billing/credits exhaustion", () => {
  const error = {
    message: "Provider returned error",
    statusCode: 402,
    responseBody: JSON.stringify({
      error: {
        message: "Insufficient credits on account",
      },
    }),
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "billing");
  assert.equal(
    res.message,
    "API credits exhausted (402): Insufficient credits on account"
  );
});

test("parseProviderError: unwraps 401 auth failure with detail message", () => {
  const error = {
    message: "Provider returned error",
    statusCode: 401,
    responseBody: JSON.stringify({
      error: {
        message: "Invalid API Key provided",
      },
    }),
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "auth");
  assert.equal(
    res.message,
    "API authentication failed (401): Invalid API Key provided"
  );
});

test("parseProviderError: handles 502 HTML error page", () => {
  const error = {
    message: "Provider returned error",
    statusCode: 502,
    responseBody:
      "<html><head><title>502 Bad Gateway</title></head><body>Cloudflare 502</body></html>",
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "provider");
  assert.equal(
    res.message,
    "Provider returned 502 Bad Gateway — the upstream model may be temporarily unavailable"
  );
});

test("parseProviderError: handles 503 / 504 provider overloaded", () => {
  const error = {
    statusCode: 503,
    responseBody: JSON.stringify({
      message: "Model engine is currently overloaded",
    }),
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "provider");
  assert.equal(
    res.message,
    "Provider unavailable (503): Model engine is currently overloaded"
  );
});

test("parseProviderError: unwraps nested APICallError structure with cause", () => {
  const error = {
    name: "APICallError",
    message: "APICallError: Provider returned error",
    cause: {
      statusCode: 400,
      responseBody: JSON.stringify({
        error: {
          message: "Context length exceeded (requested 128000, max 64000)",
        },
      }),
    },
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "provider");
  assert.equal(
    res.message,
    "Provider error (400): Context length exceeded (requested 128000, max 64000)"
  );
});

test("parseProviderError: unwraps network DNS resolution failure", () => {
  const error = {
    message: "fetch failed",
    cause: {
      code: "EAI_AGAIN",
    },
  };

  const res = parseProviderError(null, error);
  assert.equal(res.category, "network");
  assert.equal(res.message, "DNS resolution failed — check network connection");
});
