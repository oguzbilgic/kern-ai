import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SubAgentRegistry,
  formatCompletion,
  type SubAgentRecord,
  type SubAgentRunner,
} from "../src/plugins/subagents/registry.js";
import type { RunOptions } from "../src/plugins/subagents/worker.js";

const origin = { interface: "slack", channel: "#research", chatId: "C123", userId: "U1" };
const config = { model: "parent-model", subAgentModel: "" } as any;

function setup(runner: SubAgentRunner) {
  const agentDir = mkdtempSync(join(tmpdir(), "kern-subagents-"));
  const registry = new SubAgentRegistry(agentDir, config, runner);
  const announced: { record: SubAgentRecord; body: string }[] = [];
  registry.setAnnouncer((record, body) => announced.push({ record, body }));
  return { agentDir, registry, announced };
}

/** Resolves once `n` announces have been captured. */
async function settle(announced: unknown[], n = 1) {
  for (let i = 0; i < 100 && announced.length < n; i++) await new Promise((r) => setTimeout(r, 5));
}

test("subagents: completion is announced with the origin and a [subagent:<id> done] header", async () => {
  const runner: SubAgentRunner = async (opts: RunOptions) => {
    opts.onToolCall?.();
    return "the answer is 42";
  };
  const { agentDir, registry, announced } = setup(runner);
  const h = registry.spawn("find the answer", { origin });
  await h.promise;
  await settle(announced);

  assert.equal(announced.length, 1);
  const { record, body } = announced[0];
  assert.equal(record.id, h.id);
  assert.equal(record.status, "done");
  assert.deepEqual(record.origin, origin);
  assert.equal(record.toolCalls, 1);
  assert.match(body, new RegExp(`^\\[subagent:${h.id} done, \\ds\\]\\nthe answer is 42$`));

  // Origin is persisted so `subagents status` can show it after the fact.
  const recordPath = join(agentDir, ".kern", "subagents", h.id, "record.json");
  for (let i = 0; i < 50; i++) {
    try {
      const onDisk = JSON.parse(readFileSync(recordPath, "utf-8"));
      assert.deepEqual(onDisk.origin, origin);
      break;
    } catch {
      if (i === 49) throw new Error(`Timed out waiting for ${recordPath}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
});

test("subagents: failure and cancellation announce a header with the outcome", async () => {
  const failing: SubAgentRunner = async () => { throw new Error("model exploded"); };
  const f = setup(failing);
  const fh = f.registry.spawn("boom", { origin });
  await fh.promise.catch(() => {});
  await settle(f.announced);
  assert.equal(f.announced[0].record.status, "failed");
  assert.match(f.announced[0].body, /^\[subagent:sa_[0-9a-f]{8} failed, \ds\]\nmodel exploded$/);

  const slow: SubAgentRunner = (opts) =>
    new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("Cancelled by parent"))));
  const c = setup(slow);
  const ch = c.registry.spawn("wait forever", { origin });
  assert.equal(c.registry.cancel(ch.id), true);
  await ch.promise.catch(() => {});
  await settle(c.announced);
  assert.equal(c.announced[0].record.status, "cancelled");
  assert.equal(c.announced[0].body, formatCompletion(c.announced[0].record));
  assert.match(c.announced[0].body, /^\[subagent:sa_[0-9a-f]{8} cancelled, \ds\]$/);
});

test("subagents: spawn resolves the model and caps maxSteps; null origin is kept on the record", async () => {
  let seen: RunOptions | null = null;
  const runner: SubAgentRunner = async (opts) => { seen = opts; return "ok"; };
  const { registry, announced } = setup(runner);
  const h = registry.spawn("task", { origin: null, maxSteps: 500, model: "child-model" });
  await h.promise;
  await settle(announced);
  assert.equal(seen!.maxSteps, 50);
  assert.equal(seen!.config.model, "child-model");
  assert.equal(h.record.model, "child-model");
  assert.equal(announced[0].record.origin, null);
});

test("subagents: a configured cross-provider reference uses its own connection", async () => {
  let seen: RunOptions | null = null;
  const agentDir = mkdtempSync(join(tmpdir(), "kern-subagents-"));
  const { configDefaults } = await import("../src/config.js");
  const registry = new SubAgentRegistry(agentDir, { ...configDefaults, subAgentModel: { provider: "openai-compatible", baseURL: "http://localhost:1234/v1", auth: "none", model: "local-child" } }, async opts => { seen = opts; return "ok"; });
  await registry.spawn("task", { origin: null }).promise;
  assert.equal(seen!.config.model, "local-child");
  assert.equal(seen!.config.provider, "openai-compatible");
  assert.equal(seen!.config.baseURL, "http://localhost:1234/v1");
  assert.equal(seen!.config.auth, "none");
  assert.equal(seen!.config.apiKeyEnv, undefined);
});
