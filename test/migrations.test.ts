import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { migrateAgentFiles, MIGRATIONS, type Migration } from "../src/migrations/index.js";

const release = MIGRATIONS[0].targetVersion;
const legacyEnv = ["OPENAI_BASE_URL", "OLLAMA_BASE_URL", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "KERN_PROVIDER"];

async function agent(t: TestContext, config: object, env?: string) {
  const dir = await fs.mkdtemp(join(tmpdir(), "kern-migrate-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, ".kern"));
  await fs.writeFile(join(dir, ".kern", "config.json"), JSON.stringify(config));
  if (env !== undefined) await fs.writeFile(join(dir, ".kern", ".env"), env, { mode: 0o600 });
  const saved = Object.fromEntries(legacyEnv.map(key => [key, process.env[key]]));
  for (const key of legacyEnv) delete process.env[key];
  t.after(() => { for (const key of legacyEnv) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  } });
  return dir;
}

async function configAt(dir: string) {
  return JSON.parse(await fs.readFile(join(dir, ".kern", "config.json"), "utf-8"));
}

async function backupAt(dir: string) {
  const root = join(dir, ".kern", "backups");
  const entries = (await fs.readdir(root)).filter(name => name !== ".gitignore");
  assert.equal(entries.length, 1);
  return join(root, entries[0]);
}

test("legacy endpoints migrate with exact backups, no secret copying, and unknown fields preserved", async t => {
  const input = { provider: "openai", model: "local-chat", customPlugin: { enabled: true } };
  const env = '# keep this\nOPENAI_BASE_URL="http://localhost:1234/v1/"\nOPENAI_API_KEY=secret\nOTHER=keep\n';
  const dir = await agent(t, input, env);
  await migrateAgentFiles(dir);
  assert.deepEqual(await configAt(dir), { ...input, baseURL: "http://localhost:1234/v1", api: "chat", apiKeyEnv: "OPENAI_API_KEY", embeddingModel: "text-embedding-3-small", summaryModel: "gpt-6-luna", version: release });
  assert.equal(await fs.readFile(join(dir, ".kern", ".env"), "utf-8"), env);
  const backup = await backupAt(dir);
  assert.equal(await fs.readFile(join(backup, "config.json"), "utf-8"), JSON.stringify(input));
  assert.equal((await fs.stat(backup)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(backup, "config.json"))).mode & 0o777, 0o600);
  assert.ok(!(await fs.readFile(join(dir, ".kern", "config.json"), "utf-8")).includes("secret"));
  execFileSync("git", ["init", "--quiet", dir]);
  assert.equal(execFileSync("git", ["check-ignore", ".kern/backups/" + backup.split("/").at(-1) + "/config.json"], { cwd: dir, encoding: "utf-8" }).trim().endsWith("/config.json"), true);
});

test("local no-auth and Ollama endpoints preserve the old complete routes", async t => {
  const dir = await agent(t, { provider: "openai", model: "chat" }, "OPENAI_BASE_URL=http://localhost:1234/v1\n");
  await migrateAgentFiles(dir);
  assert.equal((await configAt(dir)).auth, "none");
  const ollama = await agent(t, { provider: "ollama", model: "chat" }, "OLLAMA_BASE_URL=http://server:11434/\n");
  await migrateAgentFiles(ollama);
  assert.equal((await configAt(ollama)).baseURL, "http://server:11434/v1");
  assert.equal((await configAt(ollama)).embeddingModel, "nomic-embed-text");
});

test("explicit settings and valid model shorthand survive the migration", async t => {
  const input = { provider: "openai", model: "chat", baseURL: "http://new:1234/v1", auth: "none", summaryModel: "hf.co/my/model", embeddingModel: false, somethingUnknown: 123 };
  const dir = await agent(t, input, "OPENAI_BASE_URL=http://old/v1\nOPENROUTER_API_KEY=secret\n");
  await migrateAgentFiles(dir);
  assert.deepEqual(await configAt(dir), { ...input, version: release });
});

test("legacy endpoint migration respects the provider supplied by Docker environment", async t => {
  const dir = await agent(t, { provider: "openrouter", model: "chat" }, "KERN_PROVIDER=openai\nOPENAI_BASE_URL=http://local:1234/v1\n");
  await migrateAgentFiles(dir);
  assert.equal((await configAt(dir)).baseURL, "http://local:1234/v1");
});

test("legacy cross-provider summary and embedding routes become explicit once", async t => {
  const dir = await agent(t, { provider: "anthropic", model: "claude" }, "OPENAI_API_KEY=legacy-router-key\n");
  await migrateAgentFiles(dir);
  const config = await configAt(dir);
  assert.deepEqual(config.summaryModel, { provider: "openrouter", model: "anthropic/claude-haiku-5", apiKeyEnv: "OPENAI_API_KEY" });
  assert.deepEqual(config.embeddingModel, { provider: "openrouter", model: "openai/text-embedding-3-small", apiKeyEnv: "OPENAI_API_KEY" });
  const local = await agent(t, { provider: "ollama", model: "local", summaryModel: "google/summary" }, "OPENROUTER_API_KEY=key\n");
  await migrateAgentFiles(local);
  assert.deepEqual((await configAt(local)).summaryModel, { provider: "openrouter", model: "google/summary" });
});

test("ordinary upgrades leave the migration stamp and files untouched", async t => {
  const dir = await agent(t, { version: release, model: "chat" });
  const path = join(dir, ".kern", "config.json");
  const before = await fs.stat(path);
  await migrateAgentFiles(dir, "99.0.0");
  assert.equal((await fs.stat(path)).mtimeMs, before.mtimeMs);
  assert.equal((await configAt(dir)).version, release);
  await assert.rejects(fs.stat(join(dir, ".kern", "backups")), { code: "ENOENT" });
});

test("migrations run in release order across skipped releases and respect prereleases", async t => {
  const dir = await agent(t, { version: "1.0.0" });
  const migrations: Migration[] = ["3.0.0", "2.0.0", "4.0.0"].map(targetVersion => ({
    targetVersion, description: targetVersion,
    migrate: files => ({ ...files, config: { ...files.config, history: [...((files.config.history as string[]) ?? []), targetVersion] } }),
  }));
  await migrateAgentFiles(dir, "3.0.0-next", migrations);
  assert.deepEqual((await configAt(dir)).history, ["2.0.0"]);
  assert.equal((await configAt(dir)).version, "2.0.0");
  await migrateAgentFiles(dir, "3.0.0", migrations);
  assert.deepEqual((await configAt(dir)).history, ["2.0.0", "3.0.0"]);
});

test("newer or invalid stamps fail without changing files", async t => {
  for (const version of ["99.0.0", "not-a-version", 7]) {
    const dir = await agent(t, { version });
    const before = await fs.readFile(join(dir, ".kern", "config.json"));
    await assert.rejects(migrateAgentFiles(dir));
    assert.deepEqual(await fs.readFile(join(dir, ".kern", "config.json")), before);
    await assert.rejects(fs.stat(join(dir, ".kern", "backups")), { code: "ENOENT" });
  }
});

test("a live foreign PID blocks migration, while our daemon PID is accepted", async t => {
  const dir = await agent(t, { model: "chat" });
  await fs.writeFile(join(dir, ".kern", "agent.pid"), String(process.ppid));
  await assert.rejects(migrateAgentFiles(dir), /Stop the running agent/);
  assert.equal((await configAt(dir)).version, undefined);
  await fs.writeFile(join(dir, ".kern", "agent.pid"), String(process.pid));
  await migrateAgentFiles(dir);
  assert.equal((await configAt(dir)).version, release);
});

test("bad JSON, invalid migration output, and migration exceptions leave originals intact", async t => {
  const dir = await agent(t, { model: "chat" });
  const path = join(dir, ".kern", "config.json");
  const migrations: Migration[] = [{ targetVersion: "1.0.0", description: "bad output", migrate: files => ({ ...files, config: { model: 42 } }) }];
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", migrations), /model/);
  assert.deepEqual(await configAt(dir), { model: "chat" });
  migrations[0].migrate = files => ({ ...files, config: { provider: "openai-compatible", model: "chat" } });
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", migrations), /requires baseURL/);
  assert.deepEqual(await configAt(dir), { model: "chat" });
  migrations[0].migrate = files => ({ ...files, config: { provider: "ollama", model: "chat", api: "responses" } });
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", migrations), /does not support api/);
  assert.deepEqual(await configAt(dir), { model: "chat" });
  migrations[0].migrate = () => { throw new Error("broken transform"); };
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", migrations), /broken transform/);
  assert.deepEqual(await configAt(dir), { model: "chat" });
  await fs.writeFile(path, "{broken");
  await assert.rejects(migrateAgentFiles(dir));
  assert.equal(await fs.readFile(path, "utf-8"), "{broken");
});

const envRename: Migration = {
  targetVersion: "1.0.0", description: "rename env key",
  migrate: files => ({ config: { ...files.config, apiKeyEnv: "NEW_KEY" }, env: (files.env ?? "").replace(/^OLD_KEY=/m, "NEW_KEY=") }),
};

test("multi-file migration verifies backups, replaces env then config, and preserves permissions", async t => {
  const dir = await agent(t, { model: "chat" }, "# comment\nOLD_KEY=secret\n");
  const before = await fs.readFile(join(dir, ".kern", "config.json"));
  await migrateAgentFiles(dir, "1.0.0", [envRename]);
  const backup = await backupAt(dir);
  assert.deepEqual(await fs.readFile(join(backup, "config.json")), before);
  assert.equal(await fs.readFile(join(backup, ".env"), "utf-8"), "# comment\nOLD_KEY=secret\n");
  assert.equal((await fs.stat(join(backup, ".env"))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(join(dir, ".kern", ".env"), "utf-8"), "# comment\nNEW_KEY=secret\n");
  assert.equal((await fs.stat(join(dir, ".kern", ".env"))).mode & 0o777, 0o600);
  assert.equal((await configAt(dir)).version, "1.0.0");
  assert.ok(!(await fs.readdir(join(dir, ".kern"))).some(name => name.includes(".tmp.")));
  assert.ok(!(await fs.readdir(backup)).some(name => name.includes(".tmp.")));
});

test("backup failure prevents all replacements", async t => {
  const dir = await agent(t, { model: "chat" }, "OLD_KEY=secret\n");
  await fs.writeFile(join(dir, ".kern", "backups"), "cannot create a directory here");
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", [envRename]));
  assert.deepEqual(await configAt(dir), { model: "chat" });
  assert.equal(await fs.readFile(join(dir, ".kern", ".env"), "utf-8"), "OLD_KEY=secret\n");
});

test("backup verification failure prevents all replacements", async t => {
  const dir = await agent(t, { model: "chat" }, "OLD_KEY=secret\n");
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", async (...args: any[]) => {
    const value = await (read as any)(...args);
    return String(args[0]).includes("/backups/") ? Buffer.from("corrupt") : value;
  });
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", [envRename]), /verification failed/);
  assert.deepEqual(await configAt(dir), { model: "chat" });
  assert.equal(await fs.readFile(join(dir, ".kern", ".env"), "utf-8"), "OLD_KEY=secret\n");
});

test("staging failure leaves originals intact and cleans temporary files", async t => {
  const dir = await agent(t, { model: "chat" }, "OLD_KEY=secret\n");
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (path: string, ...args: any[]) => {
    if (path.includes("config.json.tmp.")) throw new Error("cannot stage config");
    return (open as any)(path, ...args);
  });
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", [envRename]), /cannot stage config/);
  assert.deepEqual(await configAt(dir), { model: "chat" });
  assert.equal(await fs.readFile(join(dir, ".kern", ".env"), "utf-8"), "OLD_KEY=secret\n");
  assert.ok(!(await fs.readdir(join(dir, ".kern"))).some(name => name.includes(".tmp.")));
});

test("failure after env replacement rolls it back, leaving stamp unchanged", async t => {
  const dir = await agent(t, { model: "chat" }, "OLD_KEY=secret\n");
  const rename = fs.rename.bind(fs);
  let replacements = 0;
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (++replacements === 2) throw new Error("simulated config replacement failure");
    return rename(from, to);
  });
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", [envRename]), /Original files restored/);
  assert.deepEqual(await configAt(dir), { model: "chat" });
  assert.equal(await fs.readFile(join(dir, ".kern", ".env"), "utf-8"), "OLD_KEY=secret\n");
  assert.ok(!(await fs.readdir(join(dir, ".kern"))).some(name => name.includes(".tmp.")));
});

test("restart after partial replacement reruns an idempotent migration safely", async t => {
  const dir = await agent(t, { model: "chat" }, "NEW_KEY=secret\n");
  await migrateAgentFiles(dir, "1.0.0", [envRename]);
  assert.equal(await fs.readFile(join(dir, ".kern", ".env"), "utf-8"), "NEW_KEY=secret\n");
  assert.deepEqual(await configAt(dir), { model: "chat", apiKeyEnv: "NEW_KEY", version: "1.0.0" });
});

test("rollback failure identifies the backup and the file needing manual restore", async t => {
  const dir = await agent(t, { model: "chat" }, "OLD_KEY=secret\n");
  const rename = fs.rename.bind(fs);
  let replacements = 0;
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (++replacements >= 2) throw new Error("replacement failed");
    return rename(from, to);
  });
  await assert.rejects(migrateAgentFiles(dir, "1.0.0", [envRename]), /Backup: .* Restore \.env from this backup/);
  assert.equal((await configAt(dir)).version, undefined);
  assert.equal(await fs.readFile(join(await backupAt(dir), ".env"), "utf-8"), "OLD_KEY=secret\n");
});

test("startup checks the existing PID before migrating or updating agent files", async t => {
  const dir = await agent(t, { model: "chat" });
  await fs.writeFile(join(dir, ".kern", "agent.pid"), String(process.ppid));
  const config = await fs.readFile(join(dir, ".kern", "config.json"));
  await fs.writeFile(join(dir, "AGENTS.md"), "keep existing instructions");
  assert.throws(() => execFileSync(process.execPath,
    ["--import", "tsx", "src/index.ts", "run", dir],
    { cwd: join(import.meta.dirname, ".."), stdio: "pipe" }),
    (error: any) => error.status === 1 && error.stderr.toString().includes("already running"));
  assert.deepEqual(await fs.readFile(join(dir, ".kern", "config.json")), config);
  assert.equal(await fs.readFile(join(dir, "AGENTS.md"), "utf-8"), "keep existing instructions");
  await assert.rejects(fs.stat(join(dir, ".kern", "backups")), { code: "ENOENT" });
});

test("loading config is read-only and accepts the package version metadata", async t => {
  const dir = await agent(t, { version: release, model: "chat" });
  const before = await fs.readFile(join(dir, ".kern", "config.json"));
  assert.equal((await loadConfig(dir)).version, release);
  assert.deepEqual(await fs.readFile(join(dir, ".kern", "config.json")), before);
  await assert.rejects(fs.stat(join(dir, ".kern", "backups")), { code: "ENOENT" });
});
