import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config.js";

async function agentDir(config: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kern-config-"));
  await mkdir(join(dir, ".kern"));
  await writeFile(join(dir, ".kern", "config.json"), JSON.stringify(config), "utf-8");
  return dir;
}

test("loadConfig: embeddingModel survives validation", async () => {
  const config = await loadConfig(await agentDir({ provider: "openai", embeddingModel: "gemini-embedding-001" }));
  assert.equal(config.embeddingModel, "gemini-embedding-001");
});

test("loadConfig: wrong-typed embeddingModel falls back to the default", async () => {
  const config = await loadConfig(await agentDir({ provider: "openai", embeddingModel: 3072 }));
  assert.equal(config.embeddingModel, "");
});
