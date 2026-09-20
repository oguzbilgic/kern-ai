import { execSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink, readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import {
  loadRegistry,
  loadRegistryEntries,
  findAgent,
  readAgentInfo,
  isProcessRunning,
  readPid,
  removePidFile,
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

const SERVICE_PREFIX = "kern-agent-";
const WEB_SERVICE = "kern-web";
const PROXY_SERVICE = "kern-proxy";
const SYSTEM_TEMPLATE_PATH = "/etc/systemd/system/kern@.service";
const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");

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

function hasLinger(): boolean {
  try {
    const user = execSync("whoami", { encoding: "utf-8" }).trim();
    const lingerDir = `/var/lib/systemd/linger`;
    return existsSync(join(lingerDir, user));
  } catch {
    return false;
  }
}

function serviceName(agentName: string): string {
  return `${SERVICE_PREFIX}${agentName}`;
}

function isInstalled(name: string): boolean {
  return existsSync(join(SYSTEMD_DIR, `${name}.service`));
}

function isActive(name: string, isSystem: boolean = false): boolean {
  try {
    const args = isSystem ? ["is-active", name] : ["--user", "is-active", name];
    const result = spawnSync("systemctl", args, { encoding: "utf-8" });
    return result.stdout.trim() === "active";
  } catch {
    return false;
  }
}

export function isServiceInstalled(agentName: string, user?: string | null): boolean {
  if (isSystemManaged()) {
    const instance = user || agentName;
    try {
      const result = spawnSync("systemctl", ["is-enabled", `kern@${instance}`], { encoding: "utf-8" });
      return result.status === 0 || existsSync(SYSTEM_TEMPLATE_PATH);
    } catch {
      return existsSync(SYSTEM_TEMPLATE_PATH);
    }
  }
  return isInstalled(serviceName(agentName));
}

export function serviceControl(action: "start" | "stop" | "restart", agentName: string, user?: string | null): boolean {
  if (isSystemManaged()) {
    const instance = user || agentName;
    const result = spawnSync("systemctl", [action, `kern@${instance}`], { stdio: "inherit" });
    return result.status === 0;
  }
  const svc = serviceName(agentName);
  return systemctl(action, svc);
}

export function getServiceStatus(agentName: string, user?: string | null): "active" | "installed" | null {
  if (isSystemManaged()) {
    if (!existsSync(SYSTEM_TEMPLATE_PATH)) return null;
    const instance = user || agentName;
    return isActive(`kern@${instance}`, true) ? "active" : "installed";
  }
  const svc = serviceName(agentName);
  if (!isInstalled(svc)) return null;
  return isActive(svc) ? "active" : "installed";
}

export function getWebServiceStatus(): "active" | "installed" | null {
  if (!isInstalled(WEB_SERVICE)) return null;
  return isActive(WEB_SERVICE) ? "active" : "installed";
}

export function getProxyServiceStatus(): "active" | "installed" | null {
  if (!isInstalled(PROXY_SERVICE)) return null;
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
User=%i
Group=%i
WorkingDirectory=/home/%i/workspace
ExecStart=${nodeBin} --no-deprecation ${kernEntry} run /home/%i/workspace
Restart=always
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
`;
}

function agentServiceUnit(agentName: string, agentPath: string): string {
  const kernEntry = join(import.meta.dirname, "index.js");
  const nodeBin = process.execPath;
  return `[Unit]
Description=kern agent: ${agentName}
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} --no-deprecation ${kernEntry} run ${agentPath}
Restart=always
RestartSec=5
WorkingDirectory=${agentPath}
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
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
WantedBy=default.target
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
WantedBy=default.target
`;
}

function systemctl(...args: string[]): boolean {
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "pipe" });
  return result.status === 0;
}

async function installAgent(agentName: string, agentPath: string): Promise<void> {
  const svc = serviceName(agentName);
  const unitPath = join(SYSTEMD_DIR, `${svc}.service`);

  // Already installed and running — skip
  if (existsSync(unitPath) && isActive(svc)) {
    console.log(`  ${green("●")} ${bold(agentName)} already installed and running`);
    return;
  }

  // Stop PID-based daemon if running (but not if it's the systemd-managed process)
  if (!existsSync(unitPath)) {
    const agent = findAgent(agentName);
    const pid = agent ? readPid(agent.path) : null;
    if (pid && isProcessRunning(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`  ${dim("stopped pid-based daemon")} ${dim(`(pid ${pid})`)}`);
        if (agent) await removePidFile(agent.path);
        await new Promise((r) => setTimeout(r, 1000));
      } catch {}
    }
  }

  // Write unit file
  await writeFile(unitPath, agentServiceUnit(agentName, agentPath));

  // Enable and start
  systemctl("daemon-reload");
  systemctl("enable", svc);
  systemctl("restart", svc);

  // Verify
  await new Promise((r) => setTimeout(r, 1500));
  if (isActive(svc)) {
    console.log(`  ${green("●")} ${bold(agentName)} installed and running`);
  } else {
    console.log(`  ${red("●")} ${bold(agentName)} installed but failed to start`);
    console.log(`    ${dim(`journalctl --user -u ${svc} -n 10`)}`);
  }
}

async function installWeb(): Promise<void> {
  const unitPath = join(SYSTEMD_DIR, `${WEB_SERVICE}.service`);

  if (existsSync(unitPath) && isActive(WEB_SERVICE)) {
    console.log(`  ${green("●")} ${bold("web")} already installed and running`);
    return;
  }

  if (!existsSync(unitPath)) {
    const pidFile = join(homedir(), ".kern", "web.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
        if (pid && isProcessRunning(pid)) {
          process.kill(pid, "SIGTERM");
          console.log(`  ${dim("stopped pid-based web daemon")} ${dim(`(pid ${pid})`)}`);
          await new Promise((r) => setTimeout(r, 1000));
          await unlink(pidFile).catch(() => {});
        }
      } catch {}
    }
  }

  await writeFile(unitPath, webServiceUnit());

  systemctl("daemon-reload");
  systemctl("enable", WEB_SERVICE);
  systemctl("restart", WEB_SERVICE);

  await new Promise((r) => setTimeout(r, 1500));
  if (isActive(WEB_SERVICE)) {
    console.log(`  ${green("●")} ${bold("web")} installed and running`);
  } else {
    console.log(`  ${red("●")} ${bold("web")} installed but failed to start`);
    console.log(`    ${dim(`journalctl --user -u ${WEB_SERVICE} -n 10`)}`);
  }
}

async function installProxy(): Promise<void> {
  const unitPath = join(SYSTEMD_DIR, `${PROXY_SERVICE}.service`);

  if (existsSync(unitPath) && isActive(PROXY_SERVICE)) {
    console.log(`  ${green("●")} ${bold("proxy")} already installed and running`);
    return;
  }

  if (!existsSync(unitPath)) {
    const pidFile = join(homedir(), ".kern", "proxy.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(await readFile(pidFile, "utf-8"), 10);
        if (pid && isProcessRunning(pid)) {
          process.kill(pid, "SIGTERM");
          console.log(`  ${dim("stopped pid-based proxy daemon")} ${dim(`(pid ${pid})`)}`);
          await new Promise((r) => setTimeout(r, 1000));
          await unlink(pidFile).catch(() => {});
        }
      } catch {}
    }
  }

  await writeFile(unitPath, proxyServiceUnit());

  systemctl("daemon-reload");
  systemctl("enable", PROXY_SERVICE);
  systemctl("restart", PROXY_SERVICE);

  await new Promise((r) => setTimeout(r, 1500));
  if (isActive(PROXY_SERVICE)) {
    console.log(`  ${green("●")} ${bold("proxy")} installed and running`);
  } else {
    console.log(`  ${red("●")} ${bold("proxy")} installed but failed to start`);
    console.log(`    ${dim(`journalctl --user -u ${PROXY_SERVICE} -n 10`)}`);
  }
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

      // Delete the legacy config so no ghost setup remains
      await unlink(cfgPath);
      console.log(`  ${green("✓")} Migrated and removed ghost config: ${cfgPath}`);
    } catch (err: any) {
      console.log(`  ⚠ Failed to migrate ${cfgPath}: ${err.message}`);
    }
  }

  if (mutated) {
    await saveGlobalConfig(globalConfig);
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

  // kern install is strictly a host-level administrative command
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

  w("");
  w(`  ${bold("installing systemd template unit (/etc/systemd/system/kern@.service)")}`);
  w("");

  await writeFile(SYSTEM_TEMPLATE_PATH, systemServiceTemplate());
  spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });

  const entries = await loadRegistryEntries();
  const targets = nameOrFlag
    ? entries.filter((e) => {
        const user = getAgentUser(e);
        const ws = getAgentWorkspace(e);
        const info = readAgentInfo(ws, user);
        return info?.name === nameOrFlag || user === nameOrFlag || ws === nameOrFlag;
      })
    : entries;

  for (const entry of targets) {
    const user = getAgentUser(entry);
    const ws = getAgentWorkspace(entry);
    const info = readAgentInfo(ws, user);
    const name = info?.name || basename(ws);
    const instance = user || name;

    spawnSync("systemctl", ["enable", `kern@${instance}`], { stdio: "inherit" });
    spawnSync("systemctl", ["restart", `kern@${instance}`], { stdio: "inherit" });

    if (isActive(`kern@${instance}`, true)) {
      console.log(`  ${green("●")} ${bold(name)} [${instance}] enabled and running`);
    } else {
      console.log(`  ${red("●")} ${bold(name)} [${instance}] enabled but failed to start`);
      console.log(`    ${dim(`journalctl -u kern@${instance} -n 10`)}`);
    }
  }
  w("");
}

async function uninstallOne(svc: string, label: string): Promise<void> {
  const unitPath = join(SYSTEMD_DIR, `${svc}.service`);

  if (!existsSync(unitPath)) {
    console.log(`  ${dim("●")} ${bold(label)} not installed`);
    return;
  }

  systemctl("stop", svc);
  systemctl("disable", svc);
  await unlink(unitPath).catch(() => {});

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

  if (name) {
    spawnSync("systemctl", ["stop", `kern@${name}`], { stdio: "inherit" });
    spawnSync("systemctl", ["disable", `kern@${name}`], { stdio: "inherit" });
    console.log(`  ${dim("●")} ${bold(name)} disabled and stopped`);
  } else {
    if (existsSync(SYSTEM_TEMPLATE_PATH)) {
      await unlink(SYSTEM_TEMPLATE_PATH).catch(() => {});
      spawnSync("systemctl", ["daemon-reload"], { stdio: "inherit" });
      console.log(`  ${dim("●")} Removed ${SYSTEM_TEMPLATE_PATH}`);
    }
  }
}
