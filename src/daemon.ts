import { spawn, SpawnOptions, execFileSync } from "child_process";
import { basename } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { openSync } from "fs";
import {
  findAgent,
  loadRegistry,
  loadRegistryEntries,
  registerAgent,
  readAgentInfo,
  readPid,
  writePidFile,
  removePidFile,
  isProcessRunning,
} from "./registry.js";
import { isServiceInstalled, serviceControl } from "./install.js";
import { isRoot, isSystemManaged, getAgentWorkspace, getAgentUser } from "./global-config.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * Regular expression matching safe Unix usernames.
 */
export const USERNAME_REGEX = /^[a-z_][a-z0-9_-]*[$]?$/i;

/**
 * Resolve UID, GID, and HOME directory for a Unix username.
 */
export function resolveUserInfo(username: string): { uid: number; gid: number; home: string } | null {
  if (!USERNAME_REGEX.test(username)) {
    return null;
  }
  try {
    const uidStr = execFileSync("id", ["-u", username], { encoding: "utf-8" }).trim();
    const gidStr = execFileSync("id", ["-g", username], { encoding: "utf-8" }).trim();
    const uid = parseInt(uidStr, 10);
    const gid = parseInt(gidStr, 10);
    // Read home from getent passwd
    const passwdLine = execFileSync("getent", ["passwd", username], { encoding: "utf-8" }).trim();
    const parts = passwdLine.split(":");
    const home = parts[5] || `/home/${username}`;
    return { uid, gid, home };
  } catch {
    return null;
  }
}

/**
 * Drop privileges from root to the specified target Unix user.
 * Calls initgroups, setgid, and setuid in order and sets HOME/USER env vars.
 */
export function dropPrivileges(targetUser: string): void {
  if (!isRoot()) return;
  const userInfo = resolveUserInfo(targetUser);
  if (!userInfo) {
    throw new Error(`Cannot drop privileges: failed to resolve user '${targetUser}'`);
  }
  const proc = process as NodeJS.Process & {
    initgroups?: (user: string, extraGroup: number) => void;
    setgid?: (gid: number) => void;
    setuid?: (uid: number) => void;
  };
  if (typeof proc.initgroups === "function") {
    proc.initgroups(targetUser, userInfo.gid);
  }
  if (typeof proc.setgid === "function") {
    proc.setgid(userInfo.gid);
  }
  if (typeof proc.setuid === "function") {
    proc.setuid(userInfo.uid);
  }
  process.env.HOME = userInfo.home;
  process.env.USER = targetUser;
  process.env.LOGNAME = targetUser;
}

async function startOne(name: string, path: string, targetUser?: string | null): Promise<void> {
  // Check if already running via PID file
  const existingPid = readPid(path);
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`  ${green("●")} ${bold(name)} already running ${dim(`(pid ${existingPid})`)}`);
    return;
  }

  if (!existsSync(path)) {
    console.log(`  ${red("●")} ${bold(name)} path not found: ${path}`);
    return;
  }

  // Ensure log directory
  const logDir = join(path, ".kern", "logs");
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, "kern.log");
  const logFd = openSync(logFile, "a");

  // Find the kern entry point
  const kernBin = join(import.meta.dirname, "index.js");
  const nodeBin = process.execPath;

  const spawnOpts: SpawnOptions = {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: path,
  };

  let bin = nodeBin;
  let argv = ["--no-deprecation", kernBin, "run", path];

  // Privilege dropping if running as root with a declared user.
  // Node's spawn({ uid, gid }) only calls setuid/setgid and leaves root's
  // supplementary groups attached to the child, so we exec through setpriv
  // (util-linux) which runs initgroups(3) before switching IDs and then
  // exec()s directly (no intermediate fork, so the pid we record is the agent).
  if (isRoot() && targetUser) {
    const userInfo = resolveUserInfo(targetUser);
    if (!userInfo) {
      console.log(`  ${red("●")} ${bold(name)} failed to resolve user '${targetUser}'`);
      return;
    }
    bin = "setpriv";
    argv = [
      `--reuid=${userInfo.uid}`,
      `--regid=${userInfo.gid}`,
      "--init-groups",
      "--",
      nodeBin,
      ...argv,
    ];
    spawnOpts.env = {
      ...process.env,
      HOME: userInfo.home,
      USER: targetUser,
      LOGNAME: targetUser,
    };
  }

  // Fork detached process using kern run
  const child = spawn(bin, argv, spawnOpts);

  child.unref();

  const pid = child.pid!;
  await registerAgent(path);
  await writePidFile(path, pid);

  // Wait and verify the process stays alive
  await new Promise((resolve) => setTimeout(resolve, 2000));

  if (isProcessRunning(pid)) {
    const info = readAgentInfo(path, targetUser || null);
    const portStr = info?.port ? `, :${info.port}` : "";
    const userStr = targetUser ? ` [${targetUser}]` : "";
    console.log(`  ${green("●")} ${bold(name)}${userStr} started ${dim(`(pid ${pid}${portStr})`)}`);
    if (!isServiceInstalled(name, targetUser)) {
      try {
        const { execSync } = await import("child_process");
        execSync("which systemctl", { stdio: "ignore" });
        console.log(`  ${dim(`tip: 'kern install ${name}' enables auto-restart and boot persistence`)}`);
      } catch {}
    }
  } else {
    await removePidFile(path);
    console.log(`  ${red("●")} ${bold(name)} failed to start`);
    // Show last few lines of log
    try {
      const { readFile } = await import("fs/promises");
      const log = await readFile(logFile, "utf-8");
      const lines = log.trim().split("\n").slice(-5);
      for (const line of lines) {
        console.log(`    ${dim(line)}`);
      }
    } catch {}
  }
}

export async function startAgent(nameOrPath?: string): Promise<void> {
  if (nameOrPath) {
    // Try registry first
    let agent = findAgent(nameOrPath);

    if (!agent) {
      // Check if it's a directory path
      const { resolve } = await import("path");
      const dir = resolve(nameOrPath);
      if (existsSync(dir) && (existsSync(join(dir, ".kern")) || existsSync(join(dir, "AGENTS.md")))) {
        if (isSystemManaged()) {
          // Managed hosts: never spawn unregistered workspaces (would run as root without a privilege drop)
          console.error(`Agent workspace is not registered in /etc/kern/config.json: ${dir}`);
          console.error("Register it first with: sudo kern init <name>");
          process.exit(1);
          return;
        }
        const name = basename(dir);
        await registerAgent(dir);
        agent = { name, path: dir, user: null, port: 0, token: null, pid: null };
      }
    }

    if (!agent) {
      console.error(`Agent not found: ${nameOrPath}`);
      console.error("Use an agent name from 'kern status' or a path to an agent directory.");
      process.exit(1);
      return;
    }
    console.log("");
    await startOne(agent.name, agent.path, agent.user);
    console.log("");
  } else {
    // Start all registered agents
    const entries = await loadRegistryEntries();
    if (entries.length === 0) {
      console.error("No agents registered. Run 'kern init <name>' first.");
      process.exit(1);
      return;
    }
    console.log("");
    console.log(`  ${bold("starting all agents")}`);
    console.log("");
    for (const entry of entries) {
      const agentPath = getAgentWorkspace(entry);
      const user = getAgentUser(entry);
      const info = readAgentInfo(agentPath, user);
      const name = info?.name || basename(agentPath);
      if (isServiceInstalled(name, user)) {
        serviceControl("start", name, user);
      } else {
        await startOne(name, agentPath, user);
      }
    }
    console.log("");
  }
}

async function stopOne(name: string, agentPath: string): Promise<void> {
  const pid = readPid(agentPath);

  if (!pid) {
    console.log(`  ${dim("●")} ${bold(name)} not running`);
    return;
  }

  if (!isProcessRunning(pid)) {
    console.log(`  ${dim("●")} ${bold(name)} not running ${dim("(stale pid cleared)")}`);
    await removePidFile(agentPath);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    await removePidFile(agentPath);
    console.log(`  ${red("●")} ${bold(name)} stopped ${dim(`(was pid ${pid})`)}`);
  } catch (e: any) {
    console.error(`  Failed to stop ${name}: ${e.message}`);
  }
}

export async function stopAgent(name?: string): Promise<void> {
  if (name) {
    const agent = findAgent(name);
    if (!agent) {
      console.error(`Agent not found: ${name}`);
      process.exit(1);
      return;
    }
    if (isServiceInstalled(agent.name, agent.user)) {
      serviceControl("stop", agent.name, agent.user);
      return;
    }
    console.log("");
    await stopOne(agent.name, agent.path);
    console.log("");
  } else {
    const entries = await loadRegistryEntries();
    if (entries.length === 0) {
      console.error("No agents registered.");
      process.exit(1);
      return;
    }
    console.log("");
    console.log(`  ${bold("stopping all agents")}`);
    console.log("");
    for (const entry of entries) {
      const agentPath = getAgentWorkspace(entry);
      const user = getAgentUser(entry);
      const info = readAgentInfo(agentPath, user);
      const agentName = info?.name || basename(agentPath);
      if (isServiceInstalled(agentName, user)) {
        serviceControl("stop", agentName, user);
      } else {
        await stopOne(agentName, agentPath);
      }
    }
    console.log("");
  }
}
