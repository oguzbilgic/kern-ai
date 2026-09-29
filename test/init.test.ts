import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scaffoldAgent } from "../src/init.js";

test("scaffoldAgent writes config without a name or preassigned port", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kern-init-"));
  try {
    mkdirSync(join(dir, ".git"));
    await scaffoldAgent({
      dir,
      provider: "ollama",
      model: "test-model",
      apiKey: "",
      envVar: "OLLAMA_BASE_URL",
      telegramToken: "",
      slackBotToken: "",
      slackAppToken: "",
      skipStart: true,
    });

    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".kern", "config.json"), "utf-8")), {
      model: "test-model",
      provider: "ollama",
      toolScope: "full",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
