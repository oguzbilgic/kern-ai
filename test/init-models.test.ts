import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { fetchModels, mergeEnvText, scaffoldAgent } from "../src/init.js";
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
  assert.ok((await readFile(join(dir, ".gitignore"), "utf-8")).includes(".kern/backups/"));
  await migrateAgentFiles(dir);
  assert.deepEqual(await readFile(path), before);
  await assert.rejects(stat(join(dir, ".kern", "backups")), { code: "ENOENT" });
});
