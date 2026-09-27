import { execFileSync, execSync } from "child_process";
import { basename, resolve, join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import { resolveAgentDir, readLivePid } from "./agent-dir.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** Write `~/.kern/backups/<name>-<date>.tar.gz` from the agent in `[path]`. */
export async function backupAgent(pathArg?: string): Promise<void> {
  const agentDir = resolveAgentDir(pathArg);
  const parentDir = resolve(agentDir, "..");
  const folderName = basename(agentDir);
  const date = new Date().toISOString().slice(0, 10);
  const tarName = `${folderName}-${date}.tar.gz`;

  const backupDir = join(homedir(), ".kern", "backups");
  await mkdir(backupDir, { recursive: true });
  const tarPath = join(backupDir, tarName);

  console.log("");
  console.log(`  ${bold("kern backup")} ${folderName}`);
  console.log(`  ${dim(agentDir)} → ${dim(tarPath)}`);

  try {
    execFileSync(
      "tar", ["czf", tarPath, "--exclude=.kern/logs", "-C", parentDir, "--", `${folderName}/`],
      { stdio: "pipe" },
    );
    console.log(`  ${green("✓")} ${tarPath}`);
  } catch (e: any) {
    console.error(`  ${red("✗")} backup failed: ${e.message}`);
    process.exit(1);
  }

  console.log("");
  process.exit(0);
}

/** Extract a backup into `./<folder>/`, confirming before overwriting. Registers nothing. */
export async function restoreAgent(tarFile?: string): Promise<void> {
  if (!tarFile) {
    console.error("Usage: kern restore <file.tar.gz>");
    process.exit(1);
  }

  if (!existsSync(tarFile)) {
    console.error(`File not found: ${tarFile}`);
    process.exit(1);
  }

  // Peek inside tar to get folder name
  let folderName = "";
  try {
    const listing = execSync(`tar tzf "${tarFile}" | head -1`, { encoding: "utf-8" }).trim();
    folderName = listing.split("/")[0];
  } catch {
    console.error("Could not read archive.");
    process.exit(1);
  }

  if (!folderName) {
    console.error("Could not determine agent name from archive.");
    process.exit(1);
  }

  const targetDir = resolve(folderName);

  console.log("");
  console.log(`  ${bold("kern restore")} ${folderName}`);
  console.log(`  ${dim(tarFile)} → ${targetDir}`);

  if (existsSync(targetDir)) {
    const { confirm } = await import("@inquirer/prompts");
    const yes = await confirm({
      message: `${targetDir} already exists. Overwrite?`,
      default: false,
    });
    if (!yes) {
      console.log("  Aborted.");
      process.exit(0);
    }

    // Stop if running, waiting for it to exit before overwriting its files
    if (await readLivePid(targetDir)) {
      const { stopAgent } = await import("./daemon.js");
      await stopAgent(targetDir);
    }
  }

  // Extract
  try {
    execSync(`tar xzf "${tarFile}" -C "${resolve(".")}"`, { stdio: "pipe" });
    console.log(`  ${green("✓")} extracted`);
  } catch (e: any) {
    console.error(`  ${red("✗")} extract failed: ${e.message}`);
    process.exit(1);
  }

  console.log("");
  console.log(`  Run: ${dim(`kern start ${folderName}/`)}`);
  console.log("");
  process.exit(0);
}
