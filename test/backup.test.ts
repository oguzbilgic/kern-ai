import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { backupAgent } from "../src/backup.js";

test("backup uses the literal directory basename for the filename and archive root", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kern-backup-"));
  const folder = "-alice's team $LABEL";
  const dir = join(root, folder);
  const home = join(root, "home");
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  const exit = t.mock.method(process, "exit", () => { throw new Error("process.exit"); });
  t.mock.method(console, "log", () => {});
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    mkdirSync(join(dir, ".kern", "logs"), { recursive: true });
    writeFileSync(join(dir, ".kern", "config.json"), JSON.stringify({ name: "old-label" }));
    writeFileSync(join(dir, ".kern", "logs", "kern.log"), "excluded");

    await assert.rejects(backupAgent(dir), /process\.exit/);
    assert.deepEqual(exit.mock.calls.map((call) => call.arguments), [[0]]);
    const backupDir = join(home, ".kern", "backups");
    const archives = readdirSync(backupDir);
    assert.equal(archives.length, 1);
    assert.ok(archives[0].startsWith(`${folder}-`));
    assert.match(archives[0], /-\d{4}-\d{2}-\d{2}\.tar\.gz$/);
    const listing = execFileSync("tar", ["tzf", join(backupDir, archives[0])], { encoding: "utf-8" });
    assert.ok(listing.split("\n").includes(`${folder}/.kern/config.json`));
    assert.ok(!listing.includes("kern.log"));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    rmSync(root, { recursive: true, force: true });
  }
});
