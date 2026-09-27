import { spawn } from "child_process";
import { mkdir, readFile } from "fs/promises";
import { join } from "path";
import { openSync } from "fs";
import { readAgentInfo, readLivePid, writePidFile, removePidFile, isProcessRunning, waitForExit } from "./agent-dir.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function agentName(agentDir: string): string {
  return readAgentInfo(agentDir)?.name ?? agentDir;
}

/**
 * Start the agent in `agentDir` as a detached daemon.
 * PID goes to `<agentDir>/.kern/agent.pid`, output to `<agentDir>/.kern/logs/kern.log`.
 * Already running (live PID) prints and returns.
 */
export async function startAgent(agentDir: string): Promise<void> {
  const name = agentName(agentDir);

  const existingPid = await readLivePid(agentDir);
  if (existingPid) {
    console.log(`  ${green("●")} ${bold(name)} already running ${dim(`(pid ${existingPid})`)}`);
    return;
  }

  // Ensure log directory
  const logDir = join(agentDir, ".kern", "logs");
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, "kern.log");
  const logFd = openSync(logFile, "a");

  // Spawn with the same node binary that runs this CLI, never `node` from PATH
  const kernBin = join(import.meta.dirname, "index.js");
  const child = spawn(process.execPath, ["--no-deprecation", kernBin, "run", agentDir], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: agentDir,
  });

  child.unref();

  const pid = child.pid!;
  await writePidFile(agentDir, pid);

  // Wait and verify the process stays alive
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (isProcessRunning(pid)) {
    const info = readAgentInfo(agentDir);
    const portStr = info?.port ? `, :${info.port}` : "";
    console.log(`  ${green("●")} ${bold(name)} started ${dim(`(pid ${pid}${portStr})`)}`);
  } else {
    await removePidFile(agentDir);
    console.log(`  ${red("●")} ${bold(name)} failed to start`);
    // Show last few lines of log
    try {
      const log = await readFile(logFile, "utf-8");
      const lines = log.trim().split("\n").slice(-5);
      for (const line of lines) {
        console.log(`    ${dim(line)}`);
      }
    } catch {}
  }
}

/** How long `stopAgent` waits for a graceful exit before SIGKILL. */
const STOP_TIMEOUT_MS = 10_000;

/**
 * Stop the agent in `agentDir` via its PID file and wait until the process
 * has actually exited, so its port is free and its PID file is gone before
 * anything starts in its place. A stale PID is cleared.
 */
export async function stopAgent(agentDir: string): Promise<void> {
  const name = agentName(agentDir);
  const pid = await readLivePid(agentDir);

  if (!pid) {
    console.log(`  ${dim("●")} ${bold(name)} not running`);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (e: any) {
    console.error(`  Failed to stop ${name}: ${e.message}`);
    return;
  }

  if (await waitForExit(pid, STOP_TIMEOUT_MS)) {
    await removePidFile(agentDir, pid);
    console.log(`  ${red("●")} ${bold(name)} stopped ${dim(`(was pid ${pid})`)}`);
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await waitForExit(pid, 2_000);
  await removePidFile(agentDir, pid);
  console.log(`  ${red("●")} ${bold(name)} killed ${dim(`(pid ${pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s)`)}`);
}

/** Stop, wait for the old process to exit, then start. */
export async function restartAgent(agentDir: string): Promise<void> {
  await stopAgent(agentDir);
  await startAgent(agentDir);
}
