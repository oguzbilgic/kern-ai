import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { configDefaults, loadConfig } from "../src/config.js";

test("loadConfig ignores legacy name and KERN_NAME without migrating the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kern-config-"));
  const previousName = process.env.KERN_NAME;
  const previousModel = process.env.KERN_MODEL;
  try {
    mkdirSync(join(dir, ".kern"));
    const configPath = join(dir, ".kern", "config.json");
    const raw = JSON.stringify({ name: "old-label", model: "saved-model" });
    writeFileSync(configPath, raw);
    process.env.KERN_NAME = "env-label";
    process.env.KERN_MODEL = "env-model";

    const config = await loadConfig(dir);
    assert.equal("name" in configDefaults, false);
    assert.equal("name" in config, false);
    assert.equal(config.model, "env-model");
    assert.equal(readFileSync(configPath, "utf-8"), raw);
  } finally {
    if (previousName === undefined) delete process.env.KERN_NAME;
    else process.env.KERN_NAME = previousName;
    if (previousModel === undefined) delete process.env.KERN_MODEL;
    else process.env.KERN_MODEL = previousModel;
    rmSync(dir, { recursive: true, force: true });
  }
});
