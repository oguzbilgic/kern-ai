import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compare, gt, lte, valid } from "semver";
import { parseConfig } from "../config.js";
import { resolveModel, resolveSummaryModel, resolveEmbeddingModel } from "../model.js";
import { readLivePid } from "../agent-dir.js";
import { PACKAGE_VERSION } from "../package-version.js";
import { log } from "../log.js";
import { modelConnections } from "./model-connections.js";

export interface MigrationFiles {
  config: Record<string, unknown>;
  env: string | null;
}

export interface Migration {
  targetVersion: string;
  description: string;
  /** Pure file transformation: no writes. Must also accept partially migrated files. */
  migrate(files: MigrationFiles): MigrationFiles;
}

export const MIGRATIONS: readonly Migration[] = [modelConnections];

interface FileChange {
  name: string;
  before: Buffer | null;
  after: Buffer | null;
  mode?: number;
}

async function readOptional(path: string): Promise<Buffer | null> {
  try { return await fs.readFile(path); }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeSnapshot(path: string, contents: Buffer, mode: number): Promise<void> {
  const file = await fs.open(path, "wx", mode);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally { await file.close(); }
  if (!(await fs.readFile(path)).equals(contents)) throw new Error(`Snapshot verification failed: ${path}`);
}

/** Version advances only on a successful migration, to its package release. */
export async function migrateAgentFiles(
  agentDir: string,
  packageVersion = PACKAGE_VERSION,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  const kernDir = join(agentDir, ".kern");
  const configPath = join(kernDir, "config.json");
  const rawConfig = await readOptional(configPath);
  if (rawConfig === null) return;
  const config = JSON.parse(rawConfig.toString("utf-8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.json must contain an object");
  if (!valid(packageVersion)) throw new Error(`Invalid package version: ${packageVersion}`);
  const current = config.version === undefined ? "0.0.0" : config.version;
  if (typeof current !== "string" || !valid(current)) throw new Error("config.json version must be a package semver");
  if (gt(current, packageVersion)) throw new Error(`Config was migrated by Kern ${current}; use that version or newer (running ${packageVersion}).`);
  const ordered = [...migrations].sort((a, b) => compare(a.targetVersion, b.targetVersion));
  if (new Set(ordered.map(m => m.targetVersion)).size !== ordered.length) throw new Error("Duplicate migration versions");
  const pending = ordered.filter(m => gt(m.targetVersion, current) && lte(m.targetVersion, packageVersion));
  if (!pending.length) return;

  // Reuse the existing live-PID guard. Daemon startup may have recorded our PID.
  const pid = await readLivePid(agentDir);
  if (pid && pid !== process.pid) throw new Error(`Stop the running agent (pid ${pid}) before migrating: kern stop ${agentDir}`);

  const envPath = join(kernDir, ".env");
  const rawEnv = await readOptional(envPath);
  let result: MigrationFiles = { config, env: rawEnv?.toString("utf-8") ?? null };
  for (const migration of pending) {
    result = migration.migrate(result);
    result.config = { ...result.config, version: migration.targetVersion };
  }
  const validated = parseConfig(result.config);
  // Resolve without network calls or credential checks, including unsupported
  // APIs and incomplete endpoints that structural validation cannot detect.
  resolveModel(validated);
  resolveSummaryModel(validated);
  resolveEmbeddingModel(validated);
  for (const key of ["subAgentModel", "mediaModel", "audioModel"] as const) {
    if (validated[key]) resolveModel(validated, validated[key]);
  }
  if (result.env !== null && typeof result.env !== "string") throw new Error("Migration .env must be text or null");

  // Config commits last: its stamp is the completion marker for the whole run.
  const changes: FileChange[] = [
    ...(result.env !== (rawEnv?.toString("utf-8") ?? null)
      ? [{ name: ".env", before: rawEnv, after: result.env === null ? null : Buffer.from(result.env) }] : []),
    { name: "config.json", before: rawConfig, after: Buffer.from(JSON.stringify(result.config, null, 2) + "\n") },
  ];
  const backupsDir = join(kernDir, "backups");
  await fs.mkdir(backupsDir, { recursive: true, mode: 0o700 });
  // Protect backups even in existing agents whose root .gitignore predates them.
  await fs.writeFile(join(backupsDir, ".gitignore"), "*\n", { mode: 0o600 });
  const backupDir = await fs.mkdtemp(join(backupsDir, `${config.version ?? "legacy"}-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  await fs.chmod(backupDir, 0o700);
  const staged: string[] = [];
  const committed: typeof changes = [];
  try {
    for (const change of changes) {
      if (change.before !== null) await writeSnapshot(join(backupDir, change.name), change.before, 0o600);
    }
    // A manifest records files that were absent, for an exact manual restore.
    await writeSnapshot(join(backupDir, "manifest.json"), Buffer.from(JSON.stringify({
      from: config.version ?? null, to: result.config.version,
      files: changes.map(c => ({ name: c.name, existed: c.before !== null })),
    }, null, 2) + "\n"), 0o600);
    for (const change of changes) {
      const path = join(kernDir, change.name);
      const currentContents = await readOptional(path);
      if (change.before === null ? currentContents !== null : !currentContents?.equals(change.before)) {
        throw new Error(`${change.name} changed during migration; retry after the other writer finishes`);
      }
      change.mode = change.before === null ? 0o600 : (await fs.stat(path)).mode & 0o777;
      if (change.after !== null) {
        const temp = join(backupDir, `${change.name}.tmp.${process.pid}.${randomUUID()}`);
        staged.push(temp);
        await writeSnapshot(temp, change.after, change.mode);
      } else staged.push("");
    }
    for (let i = 0; i < changes.length; i++) {
      const path = join(kernDir, changes[i].name);
      if (changes[i].after === null) await fs.unlink(path);
      else await fs.rename(staged[i], path);
      committed.push(changes[i]);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const change of committed.reverse()) {
      const path = join(kernDir, change.name);
      try {
        if (change.before === null) await fs.rm(path, { force: true });
        else {
          const temp = join(backupDir, `${change.name}.tmp.${process.pid}.${randomUUID()}`);
          staged.push(temp);
          await writeSnapshot(temp, change.before, change.mode!);
          await fs.rename(temp, path);
        }
      } catch { failures.push(change.name); }
    }
    throw new Error(`Migration failed: ${(error as Error).message}. Backup: ${backupDir}.${failures.length ? ` Restore ${failures.join(", ")} from this backup before restarting.` : " Original files restored; fix the error and retry."}`, { cause: error });
  } finally {
    await Promise.all(staged.filter(Boolean).map(path => fs.rm(path, { force: true }).catch(() => {})));
  }
  for (const migration of pending) log("migration", `${migration.targetVersion}: ${migration.description}`);
  log("migration", `backup: ${backupDir}`);
}
