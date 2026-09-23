import { loadRegistryEntries, readAgentInfo, isProcessRunning } from "./registry.js";
import { getServiceStatus, getWebServiceStatus } from "./install.js";
import { loadGlobalConfig, getAgentWorkspace, getAgentUser, isSystemManaged } from "./global-config.js";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export async function showStatus(): Promise<void> {
  const entries = await loadRegistryEntries();
  const w = (s: string) => process.stdout.write(s + "\n");

  w("");
  w(`  ${bold("kern agents")}${isSystemManaged() ? dim(" (/etc/kern/config.json)") : ""}`);
  w("");

  if (entries.length === 0) {
    w(`  ${dim("No agents registered. Run")} kern init <name> ${dim("to create one.")}`);
    w("");
    return;
  }

  let hasUninstalled = false;
  for (const entry of entries) {
    const agentPath = getAgentWorkspace(entry);
    const user = getAgentUser(entry);
    const exists = existsSync(agentPath);
    const info = exists ? readAgentInfo(agentPath, user) : null;
    const name = info?.name || basename(agentPath);
    const running = info?.pid ? isProcessRunning(info.pid) : false;

    // Read config
    let model = "";
    let provider = "";
    let toolScope = "";
    let configPort = 0;
    const configPath = join(agentPath, ".kern", "config.json");
    if (exists && existsSync(configPath)) {
      try {
        const config = JSON.parse(await readFile(configPath, "utf-8"));
        model = config.model || "";
        provider = config.provider || "";
        toolScope = config.toolScope || "";
        configPort = config.port || 0;
      } catch {}
    }

    const installStatus = getServiceStatus(name, user);
    const active = installStatus === "active" || running;
    const dot = !exists ? red("●") : active ? green("●") : dim("●");
    const userBadge = user ? dim(` [${user}]`) : "";
    const nameStr = bold(name) + userBadge;
    const modelStr = provider && model ? dim(`${provider}/${model}`) : dim("no config");
    const port = info?.port || configPort;
    const portStr = port ? `:${port}` : "";
    const pidStr = info?.pid && (running || installStatus === "active") ? `pid ${info.pid}` : "";
    const details = [pidStr, portStr].filter(Boolean).join(", ");
    const statusStr = !exists
      ? red("not found")
      : active
        ? green("running") + (details ? dim(` (${details})`) : "")
        : dim("stopped");
    const mode = installStatus ? "systemd" : running ? "daemon" : "—";
    if (!installStatus) hasUninstalled = true;

    w(`  ${dot} ${nameStr}  ${modelStr}  ${statusStr}`);
    w(`    ${dim("path:")}  ${agentPath}`);
    w(`    ${dim("tools:")} ${toolScope || "—"}  ${dim("mode:")} ${mode}`);
    w("");
  }

  // Web status
  const config = await loadGlobalConfig();
  const webInstall = getWebServiceStatus();
  const pidFile = join(homedir(), ".kern", "web.pid");
  let webPid: number | null = null;
  let webRunning = false;
  if (existsSync(pidFile)) {
    try {
      webPid = parseInt(await readFile(pidFile, "utf-8"), 10);
      webRunning = !!webPid && isProcessRunning(webPid);
    } catch {}
  }
  if (!webRunning) webRunning = webInstall === "active";
  const webDot = webRunning ? green("●") : dim("●");
  const webStatus = webRunning
    ? green("running") + dim(` (:${config.web_port})`)
    : dim("stopped");
  const webMode = webInstall ? "systemd" : webRunning ? "daemon" : "—";

  // Proxy status
  const { getProxyServiceStatus } = await import("./install.js");
  const proxyInstall = getProxyServiceStatus();
  const proxyPidFile = join(homedir(), ".kern", "proxy.pid");
  let proxyPid: number | null = null;
  let proxyRunning = false;
  if (existsSync(proxyPidFile)) {
    try {
      proxyPid = parseInt(await readFile(proxyPidFile, "utf-8"), 10);
      proxyRunning = !!proxyPid && isProcessRunning(proxyPid);
    } catch {}
  }
  if (!proxyRunning) proxyRunning = proxyInstall === "active";
  const proxyDot = proxyRunning ? green("●") : dim("●");
  const proxyStatusStr = proxyRunning
    ? green("running") + dim(` (:${config.proxy_port})`)
    : dim("stopped");
  const proxyMode = proxyInstall ? "systemd" : proxyRunning ? "daemon" : "—";

  w(`  ${bold("kern services")}`);
  w("");
  w(`  ${webDot} ${bold("web")}    ${webStatus}`);
  w(`    ${dim("mode:")} ${webMode}`);
  w(`  ${proxyDot} ${bold("proxy")}  ${proxyStatusStr}`);
  w(`    ${dim("mode:")} ${proxyMode}`);
  w("");
}
