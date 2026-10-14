import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { fetchModels, mergeEnvText, scaffoldAgent, runInit } from "../src/init.js";
import { configDefaults } from "../src/config.js";
import { createModel, resolveModel } from "../src/model.js";
import { generateText } from "ai";
import { modelServer } from "./helpers/model-server.js";
import { PACKAGE_VERSION } from "../src/package-version.js";
import { migrateAgentFiles } from "../src/migrations/index.js";

test("discovers arbitrary local IDs from the configured endpoint without authentication", async t => {
  const server = await modelServer(t);
  const models = await fetchModels({ provider: "openai-compatible", baseURL: server.baseURL, auth: "none" });
  assert.deepEqual(models?.map(model => model.value), ["org/local-chat", "org/local-embed"]);
  assert.equal(server.requests[0].path, "/v1/models");
  assert.equal(server.requests[0].authorization, undefined);
});

test("env updates preserve unrelated keys, comments, and multiline values", () => {
  const previous = '# comment\nOPENAI_BASE_URL=http://localhost:1234/v1\nKERN_AUTH_TOKEN=keep\nCERT="first\nsecond"\nexport LOCAL_KEY=old\nLOCAL_KEY=duplicate\n';
  const result = mergeEnvText(previous, { LOCAL_KEY: "new#key", ANOTHER_KEY: "quoted'key" });
  assert.ok(result.includes('# comment\nOPENAI_BASE_URL=http://localhost:1234/v1\nKERN_AUTH_TOKEN=keep\nCERT="first\nsecond"\n'));
  assert.equal(parse(result).LOCAL_KEY, "new#key");
  assert.equal(parse(result).ANOTHER_KEY, "quoted'key");
  assert.equal(parse(result).CERT, "first\nsecond");
  assert.equal((result.match(/^LOCAL_KEY=/gm) || []).length, 1);
});

test("scaffolding an existing agent preserves other config and credentials", async t => {
  const dir = await mkdtemp(join(tmpdir(), "kern-scaffold-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".kern"));
  await writeFile(join(dir, ".kern", "config.json"), JSON.stringify({ port: 4123, autoRecall: true, mediaModel: "vision" }));
  await writeFile(join(dir, ".kern", ".env"), "# keep\nKERN_AUTH_TOKEN=token\nOPENROUTER_API_KEY=other\n");
  await scaffoldAgent({ name: "local", dir, provider: "openai-compatible", model: "local-chat", connection: { baseURL: "http://localhost:1234/v1", auth: "none" }, embeddingModel: "local-embed", apiKey: "", envVar: "LOCAL_MODEL_API_KEY", telegramToken: "", slackBotToken: "", slackAppToken: "", skipStart: true });
  const config = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf8"));
  assert.equal(config.port, 4123);
  assert.equal(config.autoRecall, true);
  assert.equal(config.embeddingModel, "local-embed");
  assert.equal(config.version, PACKAGE_VERSION);
  const env = await readFile(join(dir, ".kern", ".env"), "utf8");
  assert.ok(env.startsWith("# keep\n"));
  assert.equal(parse(env).KERN_AUTH_TOKEN, "token");
  assert.equal(parse(env).OPENROUTER_API_KEY, "other");
});

test("fresh setup stamps the package version and ignores backups without running legacy migrations", async t => {
  const dir = await mkdtemp(join(tmpdir(), "kern-fresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await scaffoldAgent({ name: "fresh", dir, provider: "anthropic", model: "claude", apiKey: "", envVar: "ANTHROPIC_API_KEY", telegramToken: "", slackBotToken: "", slackAppToken: "", skipStart: true });
  const path = join(dir, ".kern", "config.json");
  const before = await readFile(path);
  assert.equal(JSON.parse(before.toString()).version, PACKAGE_VERSION);
  assert.equal(JSON.parse(before.toString()).summaryModel, undefined);
  assert.deepEqual(Object.keys(JSON.parse(before.toString())).slice(0, 4), ["version", "name", "model", "provider"]);
  assert.ok((await readFile(join(dir, ".gitignore"), "utf-8")).includes(".kern/backups/"));
  await migrateAgentFiles(dir);
  assert.deepEqual(await readFile(path), before);
  await assert.rejects(stat(join(dir, ".kern", "backups")), { code: "ENOENT" });
});

async function setupDirectory(t: import("node:test").TestContext, config?: object) {
  const dir = await mkdtemp(join(tmpdir(), "kern-setup-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, ".kern"));
  await mkdir(join(dir, ".git"));
  // The CLI's startAgent returns immediately for this PID; tests launch no daemon.
  await writeFile(join(dir, ".kern", "agent.pid"), String(process.pid));
  if (config) await writeFile(join(dir, ".kern", "config.json"), JSON.stringify({ version: PACKAGE_VERSION, ...config }));
  return dir;
}

test("CLI honors an existing credential variable without a command-line secret", async t => {
  const server = await modelServer(t);
  const dir = await setupDirectory(t);
  process.env.KERN_SETUP_TEST_KEY = "local-test-secret";
  t.after(() => { delete process.env.KERN_SETUP_TEST_KEY; });
  await runInit(dir, { provider: "openai-compatible", "base-url": server.baseURL, model: "chat", "embedding-model": "off", "api-key-env": "KERN_SETUP_TEST_KEY" });
  const config = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8"));
  assert.equal(config.apiKeyEnv, "KERN_SETUP_TEST_KEY");
  assert.equal(config.auth, undefined);
  assert.ok(!(await readFile(join(dir, ".kern", ".env"), "utf-8")).includes("local-test-secret"));
  await generateText({ model: createModel({ ...configDefaults, ...config }), prompt: "hi" });
  assert.equal(server.requests[0].authorization, "Bearer local-test-secret");
});

test("CLI key rotation preserves omitted provider, model, endpoint, and API settings", async t => {
  const dir = await setupDirectory(t, { provider: "openai", model: "local-chat", baseURL: "http://local.test/v1", api: "chat", auth: "none", embeddingModel: false, port: 4123 });
  await runInit(dir, { "api-key": "new-test-key" });
  const config = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8"));
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "local-chat");
  assert.equal(config.baseURL, "http://local.test/v1");
  assert.equal(config.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(config.auth, undefined);
  assert.equal(resolveModel(config).api, "chat");
  assert.equal(config.port, 4123);
  assert.equal(parse(await readFile(join(dir, ".kern", ".env"), "utf-8")).OPENAI_API_KEY, "new-test-key");
});

test("CLI updates preserve the default provider's saved connection when provider is omitted", async t => {
  const dir = await setupDirectory(t, { model: "local-chat", baseURL: "http://gateway.test/v1", apiKeyEnv: "GATEWAY_KEY", api: "chat", embeddingModel: false });
  await runInit(dir, { "api-key": "rotated-key" });
  const config = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8"));
  assert.equal(config.provider, "openrouter");
  assert.equal(config.model, "local-chat");
  assert.equal(config.baseURL, "http://gateway.test/v1");
  assert.equal(config.apiKeyEnv, "GATEWAY_KEY");
  assert.equal(resolveModel(config).api, "chat");
  assert.equal(parse(await readFile(join(dir, ".kern", ".env"), "utf-8")).GATEWAY_KEY, "rotated-key");
});

test("CLI repeating an implicit preset URL retains the saved credential variable and API", async t => {
  const dir = await setupDirectory(t, { provider: "openai", model: "chat", apiKeyEnv: "CUSTOM_OPENAI_KEY", api: "chat", embeddingModel: false });
  await runInit(dir, { "base-url": " https://api.openai.com/v1/ " });
  const config = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8"));
  assert.equal(config.apiKeyEnv, "CUSTOM_OPENAI_KEY");
  assert.equal(config.api, "chat");
  const resolved = resolveModel({ ...configDefaults, ...config });
  assert.equal(resolved.baseURL, "https://api.openai.com/v1");
  assert.equal(resolved.apiKeyEnv, "CUSTOM_OPENAI_KEY");
  assert.equal(resolved.auth, undefined);
});

test("replacing a connection clears credentials and API settings from the previous route", async t => {
  for (const connection of [{ provider: "anthropic" }, { provider: "openai", baseURL: "http://another.test/v1" }]) {
    const dir = await setupDirectory(t, { provider: "openai", model: "chat", baseURL: "http://local.test/v1", apiKeyEnv: "LOCAL_KEY", api: "responses", embeddingModel: false });
    await scaffoldAgent({ name: "replacement", dir, provider: connection.provider, connection, model: "chat", apiKey: "", envVar: "NEW_KEY", telegramToken: "", slackBotToken: "", slackAppToken: "", skipStart: true });
    const config = JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8"));
    assert.equal(config.apiKeyEnv, undefined);
    assert.equal(config.api, undefined);
    const resolved = resolveModel({ ...configDefaults, ...config });
    if (connection.provider === "anthropic") {
      assert.equal(resolved.baseURL, "https://api.anthropic.com/v1");
      assert.equal(resolved.apiKeyEnv, "ANTHROPIC_API_KEY");
    } else {
      assert.equal(resolved.baseURL, "http://another.test/v1");
      assert.equal(resolved.auth, "none");
      assert.equal(resolved.apiKeyEnv, undefined);
    }
  }
});

test("hosted embedding references from prompt output validate before JSON serialization", async t => {
  const dir = await setupDirectory(t);
  await scaffoldAgent({ name: "hosted", dir, provider: "anthropic", model: "claude", apiKey: "", envVar: "ANTHROPIC_API_KEY", embeddingModel: { provider: "openai", model: "embed", baseURL: undefined, auth: undefined, api: undefined, apiKeyEnv: "OPENAI_API_KEY" }, telegramToken: "", slackBotToken: "", slackAppToken: "", skipStart: true });
  assert.equal(JSON.parse(await readFile(join(dir, ".kern", "config.json"), "utf-8")).embeddingModel.provider, "openai");
});

test("unsupported embedding routes leave saved configuration and the live PID unchanged", async t => {
  const dir = await setupDirectory(t, { provider: "openai", model: "chat", embeddingModel: "embed" });
  const configPath = join(dir, ".kern", "config.json");
  const before = await readFile(configPath);
  await assert.rejects(scaffoldAgent({ name: "invalid", dir, provider: "anthropic", model: "claude", apiKey: "", envVar: "ANTHROPIC_API_KEY", telegramToken: "", slackBotToken: "", slackAppToken: "", skipStart: true }), /Anthropic has no embeddings API/);
  assert.deepEqual(await readFile(configPath), before);
  assert.equal(await readFile(join(dir, ".kern", "agent.pid"), "utf-8"), String(process.pid));
});
