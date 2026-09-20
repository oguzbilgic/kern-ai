import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink, readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import {
  loadRegistryEntries,
  findAgent,
  readAgentInfo,
  isProcessRunning,
} from "./registry.js";
import {
  isSystemManaged,
  isRoot,
  getAgentWorkspace,
  getAgentUser,
  promoteToSystemManaged,
  loadGlobalConfig,
  saveGlobalConfig,
  type AgentEntry,
} from "./global-config.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const WEB_SERVICE = "kern-web";
const PROXY_SERVICE = "kern-proxy";
const SYSTEM_UNIT_DIR = "/etc/systemd/system";
const SYSTEM_TEMPLATE_PATH = `${SYSTEM_UNIT_DIR}/kern@.service`;

function hasSystemd(): boolean {
  try {
    // Check both systemctl binary presence and active PID 1 systemd boot state
    execSync("which systemctl", { stdio: "ignore" });
    return existsSync("/run/systemd/system");
  } catch {
    return false;
  }
}

function findGlobalKernBinary(): string | null {
  try {
    const res = spawnSync("which", ["kern"], { encoding: "utf-8" });
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  } catch {}
  return null;
}

function unitPath(name: string): string {
  return join(SYSTEM_UNIT_DIR, `${name}.service`);
}

function isActive(name: string): boolean {
  try {
    const result = spawnSync("systemctl", ["is-active", name], { encoding: "utf-8" });
    return result.stdout.trim() === "active";
  } catch {
    return false;
  }
}

export function isServiceInstalled(agentName: string, user?: string | null): boolean {
  // Agent units exist only on system-managed hosts (kern@<user> template). There is
  // no user-level systemd integration.
  if (!isSystemManaged() || !existsSync(SYSTEM_TEMPLATE_PATH)) return false;
  const instance = user || agentName;
  const result = spawnSync("systemctl", ["is-enabled", `kern@${instance}`], { encoding: "utf-8" });
  return result.status === 0;
}

export function serviceControl(action: "start" | "stop" | "restart", agentName: string, user?: string | null): boolean {
  const instance = user || agentName;
  const result = spawnSync("systemctl", [action, `kern@${instance}`], { stdio: "inherit" });
  return result.status === 0;
}

export function getServiceStatus(agentName: string, user?: string | null): "active" | "installed" | null {
  if (!isServiceInstalled(agentName, user)) return null;
  const instance = user || agentName;
  return isActive(`kern@${instance}`) ? "active" : "installed";
}

export function getWebServiceStatus(): "active" | "installed" | null {
  if (!existsSync(unitPath(WEB_SERVICE))) return null;
  return isActive(WEB_SERVICE) ? "active" : "installed";
}

export function getProxyServiceStatus(): "active" | "installed" | null {
  if (!existsSync(unitPath(PROXY_SERVICE))) return null;
  return isActive(PROXY_SERVICE) ? "active" : "installed";
}

function systemServiceTemplate(): string {
  const nodeBin = process.execPath;
  const kernEntry = join(import.meta.dirname, "index.js");
  return `[Unit]
Description=kern agent: %i
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} --no-deprecation ${kernEntry} run %i
Restart=always
RestartSec=5
Environment=NODE_ENV=production
ProtectSystem=full

[Install]
WantedBy=multi-user.target
`;
}

function webServiceUnit(): string {
  const webEntry = join(import.meta.dirname, "web.js");
  const nodeBin = process.execPath;
  return `[Unit]
Description=kern web UI
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} --no-deprecation ${webEntry}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
}

function proxyServiceUnit(): string {
  const proxyEntry = join(import.meta.dirname, "proxy.js");
  const nodeBin = process.execPath;
  return `[Unit]
Description=kern proxy server
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} --no-deprecation ${proxyEntry}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Install a host-level auxiliary service (web UI or proxy) as a system unit.
 * Runs as root: the proxy needs to read per-agent tokens from agent-owned workspaces,
 * and both need /etc/kern/config.json for discovery.
 */
async function installAux(svc: string, label: string, unit: string, pidFileName: string): Promise<void> {
  const path = unitPath(svc);

  if (existsSync(path) && isActive(svc)) {
    console.log(`  ${green("●")} ${bold(label)} already installed and running`);
    return;
  }

  // Stop a PID-based daemon left over from `kern web start` / `kern proxy start`
  if (!existsSync(path)) {
    const pidFile = join(homedir(), ".kern", pidFileName);
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
        if (pid && isProcessRunning(pid)) {
          process.kill(pid, "SIGTERM");
          console.log(`  ${dim(`stopped pid-based ${label} daemon`)} ${dim(`(pid ${pid})`)}`);
          await new Promise((r) => setTimeout(r, 1000));
          await unlink(pidFile).catch(() => {});
        }
      } catch {}
    }
  }

  await writeFile(path, unit);

  spawnSync("systemctl", ["daemon-reload"], { stdio: "pipe" });
  spawnSync("systemctl", ["enable", svc], { stdio: "pipe" });
  spawnSync("systemctl", ["restart", svc], { stdio: "pipe" });

  await new Promise((r) => setTimeout(r, 1500));
  if (isActive(svc)) {
    console.log(`  ${green("●")} ${bold(label)} installed and running`);
  } else {
    console.log(`  ${red("●")} ${bold(label)} installed but failed to start`);
    console.log(`    ${dim(`journalctl -u ${svc} -n 10`)}`);
  }
}

async function installWeb(): Promise<void> {
  await installAux(WEB_SERVICE, "web", webServiceUnit(), "web.pid");
}

async function installProxy(): Promise<void> {
  await installAux(PROXY_SERVICE, "proxy", proxyServiceUnit(), "proxy.pid");
}

/**
 * Migrate legacy user-level configs to /etc/kern/config.json and clean up ghost registries.
 */
async function migrateAndCleanLegacyUserConfigs(): Promise<void> {
  const candidateDirs: string[] = ["/root/.kern"];
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && sudoUser !== "root") {
    candidateDirs.push(`/home/${sudoUser}/.kern`);
  }

  const globalConfig = await loadGlobalConfig();
  let mutated = false;
  const migratedPaths: string[] = [];

  for (const dir of candidateDirs) {
    const cfgPath = join(dir, "config.json");
    if (!existsSync(cfgPath)) continue;

    try {
      const raw = await readFile(cfgPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.agents) && parsed.agents.length > 0) {
        for (const entry of parsed.agents) {
          const ws = getAgentWorkspace(entry);
          const declaredUser = getAgentUser(entry);
          // If no declared user, infer from workspace path or sudoUser
          let targetUser = declaredUser;
          if (!targetUser) {
            const match = ws.match(/^\/home\/([^/]+)/);
            targetUser = match ? match[1] : (sudoUser || "root");
          }

          const exists = globalConfig.agents.some((e) => getAgentWorkspace(e) === ws);
          if (!exists) {
            globalConfig.agents.push({ user: targetUser, workspace: ws });
            mutated = true;
          }
        }
      }
      migratedPaths.push(cfgPath);
    } catch (err: any) {
      console.log(`  ⚠ Failed to migrate ${cfgPath}: ${err.message}`);
    }
  }

  // Persist the merged fleet config first; only then remove legacy sources.
  // If the write fails, legacy configs are left intact so nothing is lost.
  if (mutated) {
    await saveGlobalConfig(globalConfig);
  }

  for (const cfgPath of migratedPaths) {
    try {
      await unlink(cfgPath);
      console.log(`  ${green("✓")} Migrated and removed ghost config: ${cfgPath}`);
    } catch (err: any) {
      console.log(`  ⚠ Failed to remove ${cfgPath}: ${err.message}`);
    }
  }
}

export async function install(nameOrFlag?: string): Promise<void> {
  const w = (s: string) => process.stdout.write(s + "\n");

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 22) {
    console.error(`\x1b[31mError:\x1b[0m kern requires Node.js >= 22 (running v${process.versions.node}).`);
    console.error(`Please upgrade Node.js before configuring systemd services.`);
    process.exit(1);
  }

  if (process.platform !== "linux") {
    console.error(`\x1b[31mError:\x1b[0m 'kern install' configures system-level systemd units and is only supported on Linux.`);
    console.error(`On macOS or development machines, run 'kern start' or 'kern run' instead.`);
    process.exit(1);
  }

  if (!hasSystemd()) {
    console.error(`\x1b[31mError:\x1b[0m systemd is not available or not running as PID 1 on this system.`);
    console.error(`Use 'kern start' (detached daemon) or 'kern run' (foreground process) instead.`);
    process.exit(1);
  }

  // kern install is strictly a host-level administrative command — including
  // the auxiliary --web / --proxy services, which are installed as system units.
  if (!isRoot()) {
    console.error(`\x1b[31mError:\x1b[0m 'kern install' configures host-level systemd persistence and requires root.`);
    console.error(`Run: sudo kern install${nameOrFlag ? ` ${nameOrFlag}` : ""}`);
    process.exit(1);
  }

  // Verify kern is globally installed in PATH so systemd and unprivileged users can execute it
  const globalBin = findGlobalKernBinary();
  if (!globalBin) {
    console.error(`\x1b[31mError:\x1b[0m 'kern' was not found in system PATH.`);
    console.error(`Systemd services run as dedicated agent users who need access to the global CLI.`);
    console.error(`Install kern globally first:`);
    console.error(`  sudo npm install -g kern-ai`);
    process.exit(1);
  }

  // Auto-promote host to /etc/kern/config.json if not already promoted
  const wasManaged = isSystemManaged();
  if (!wasManaged) {
    await promoteToSystemManaged();
    w("");
    w(`  ${green("✓")} ${bold("Promoted host to multi-agent fleet")} (/etc/kern/config.json)`);
  }

  // Scan for legacy user-level configs to migrate and clean up ghosts
  await migrateAndCleanLegacyUserConfigs();

  // Auxiliary services are installed only after the host is promoted, so the
  // unit reads the fleet registry in /etc/kern/config.json rather than root's ~/.kern.
  if (nameOrFlag === "--web") {
    w("");
    await installWeb();
    w("");
    return;
  }

  if (nameOrFlag === "--proxy") {
    w("");
    await installProxy();
    w("");
    return;
  }

  const entries = await loadRegistryEntries();
  const targets = nameOrFlag
    ? entries.filter((e) => {
        const user = getAgentUser(e);
        const ws = getAgentWorkspace(e);
        const info = readAgentInfo(ws, user);
        return info?.name === nameOrFlag || user === nameOrFlag || ws === nameOrFlag;
      })
    : entries;

  if (nameOrFlag && targets.length === 0) {
    console.error(`\x1b[31mError:\x1b[0m Agent '${nameOrFlag}' not found in /etc/kern/config.json.`);
    console.error(`Run 'kern list' to see registered agents, or 'sudo kern init ${nameOrFlag}' to create it.`);
    process.exit(1);
  }

  w("");
  w(`  ${bold("installing systemd template unit (/etc/systemd/system/kern@.service)")}`);
  w("");

  await writeFile(SYSTEM_TEMPLATE_PATH, systemServiceTemplate());
  spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });

  for (const entry of targets) {
    const user = getAgentUser(entry);
    const ws = getAgentWorkspace(entry);
    const info = readAgentInfo(ws, user);
    const name = info?.name || basename(ws);

    // The template runs User=%i; a bare path entry has no declared Unix user, so
    // enabling it would make systemd try to run as a user named after the agent.
    if (!user) {
      console.log(`  ${yellow("●")} ${bold(name)} skipped — no user declared for ${ws}`);
      console.log(`    ${dim(`add { "user": "<unix-user>", "workspace": "${ws}" } to /etc/kern/config.json`)}`);
      continue;
    }
    const instance = user;

    spawnSync("systemctl", ["enable", `kern@${instance}`], { stdio: "inherit" });
    spawnSync("systemctl", ["restart", `kern@${instance}`], { stdio: "inherit" });

    if (isActive(`kern@${instance}`)) {
      console.log(`  ${green("●")} ${bold(name)} [${instance}] enabled and running`);
    } else {
      console.log(`  ${red("●")} ${bold(name)} [${instance}] enabled but failed to start`);
      console.log(`    ${dim(`journalctl -u kern@${instance} -n 10`)}`);
    }
  }
  w("");
}

async function uninstallAux(svc: string, label: string): Promise<void> {
  const path = unitPath(svc);
  if (!existsSync(path)) {
    console.log(`  ${dim("●")} ${bold(label)} not installed`);
    return;
  }
  spawnSync("systemctl", ["stop", svc], { stdio: "pipe" });
  spawnSync("systemctl", ["disable", svc], { stdio: "pipe" });
  await unlink(path).catch(() => {});
  spawnSync("systemctl", ["daemon-reload"], { stdio: "pipe" });
  console.log(`  ${dim("●")} ${bold(label)} uninstalled`);
}

export async function uninstall(name?: string): Promise<void> {
  const w = (s: string) => process.stdout.write(s + "\n");

  if (!hasSystemd()) {
    console.error("systemd not available.");
    process.exit(1);
  }

  if (!isRoot()) {
    console.error(`\x1b[31mError:\x1b[0m 'kern uninstall' manages system services and requires root.`);
    console.error(`Run: sudo kern uninstall${name ? ` ${name}` : ""}`);
    process.exit(1);
  }

  if (name === "--web") {
    await uninstallAux(WEB_SERVICE, "web");
    return;
  }
  if (name === "--proxy") {
    await uninstallAux(PROXY_SERVICE, "proxy");
    return;
  }

  if (name) {
    const agent = findAgent(name);
    const instance = agent?.user || name;
    spawnSync("systemctl", ["stop", `kern@${instance}`], { stdio: "inherit" });
    spawnSync("systemctl", ["disable", `kern@${instance}`], { stdio: "inherit" });
    console.log(`  ${dim("●")} ${bold(name)} [${instance}] disabled and stopped`);
  } else {
    w(`  ${bold("stopping and disabling all kern agent services")}`);
    w("");

    const entries = await loadRegistryEntries();
    for (const entry of entries) {
      const user = getAgentUser(entry);
      const ws = getAgentWorkspace(entry);
      const info = readAgentInfo(ws, user);
      const agentName = info?.name || basename(ws);
      const instance = user || agentName;

      spawnSync("systemctl", ["stop", `kern@${instance}`], { stdio: "inherit" });
      spawnSync("systemctl", ["disable", `kern@${instance}`], { stdio: "inherit" });
      console.log(`  ${dim("●")} ${bold(agentName)} [${instance}] disabled and stopped`);
    }

    if (existsSync(SYSTEM_TEMPLATE_PATH)) {
      await unlink(SYSTEM_TEMPLATE_PATH).catch(() => {});
      spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
      console.log(`  ${dim("●")} Removed ${SYSTEM_TEMPLATE_PATH}`);
    }

    await uninstallAux(WEB_SERVICE, "web");
    await uninstallAux(PROXY_SERVICE, "proxy");
  }
}
