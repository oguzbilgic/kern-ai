#!/usr/bin/env -S node --no-deprecation

import { resolve, basename } from "path";
import { existsSync } from "fs";
import { startApp } from "./app.js";
import { runInit } from "./init.js";
import { showStatus } from "./status.js";
import { startAgent, stopAgent } from "./daemon.js";
import { findAgent, loadRegistry, readAgentInfo } from "./registry.js";
import { readFile } from "fs/promises";
import { join } from "path";

const args = process.argv.slice(2);
const cmd = args[0];

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

async function showHelp() {
  let version = "unknown";
  try {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf-8"));
    version = pkg.version;
  } catch {}

  const w = (s: string) => process.stdout.write(s + "\n");
  w("");
  w(`  ${bold("kern")} ${dim("v" + version)}`);
  w(`  ${dim("One agent. One folder. One continuous conversation.")}`);
  w("");
  w(`  ${yellow("Commands")}`);
  w(`    ${cyan("kern init")} ${dim("<name>")}            create or configure an agent`);
  w(`    ${cyan("kern start")} ${dim("[name|path]")}      start agents`);
  w(`    ${cyan("kern stop")} ${dim("[name]")}            stop agents`);
  w(`    ${cyan("kern restart")} ${dim("[name]")}         restart agents`);
  w(`    ${cyan("kern list")}                   show all agents`);
  w(`    ${cyan("kern remove")} ${dim("<name>")}          unregister an agent`);
  w(`    ${cyan("kern pair")} ${dim("<agent> <code>")}    approve a pairing code`);
  w(`    ${cyan("kern backup")} ${dim("<name>")}          backup agent to .tar.gz`);
  w(`    ${cyan("kern import")} ${dim("opencode <name>")}         import session from OpenCode`);
  w(`    ${cyan("kern import")} ${dim("openclaw-lcm <lcm.db>")}   import session from OpenClaw LCM`);
  w(`    ${cyan("kern scripts")} ${dim("recover-session <recall.db>")}  rebuild a session from recall.db`);
  w(`    ${cyan("kern restore")} ${dim("<file>")}         restore agent from backup`);
  w(`    ${cyan("kern logs")} ${dim("[name] [-f] [-n 50] [--level warn]")}  show agent logs`);
  w(`    ${cyan("kern install")} ${dim("[name|--web|--proxy]")} install systemd services`);
  w(`    ${cyan("kern uninstall")} ${dim("[name]")}        remove systemd services`);
  w(`    ${cyan("kern tui")} ${dim("[name]")}             interactive chat`);
  w(`    ${cyan("kern web")} ${dim("<run|start|stop|status>")}     static web UI server`);
  w(`    ${cyan("kern proxy")} ${dim("<start|stop|status|token>")} authenticated proxy server`);
  w("");
}

async function resolveAgentDir(nameOrPath?: string): Promise<string> {
  if (nameOrPath) {
    // Check registry
    const agent = findAgent(nameOrPath);
    if (agent) return agent.path;

    // Check path
    const dir = resolve(nameOrPath);
    if (existsSync(dir) && (existsSync(join(dir, ".kern")) || existsSync(join(dir, "AGENTS.md")))) {
      return dir;
    }

    console.error(`Agent not found: ${nameOrPath}`);
    process.exit(1);
  }

  // No arg — auto-select
  const paths = await loadRegistry();
  if (paths.length === 0) {
    console.error("No agents registered. Run 'kern init <name>' first.");
    process.exit(1);
  }
  if (paths.length === 1) {
    return paths[0];
  }

  // Multiple agents — prompt to select
  const { select } = await import("@inquirer/prompts");
  const choices = paths.map((p) => {
    const info = readAgentInfo(p);
    return { name: info?.name || p, value: p };
  });
  return select({ message: "Select agent", choices });
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    await showHelp();
    process.exit(0);
  }

  if (cmd === "init") {
    // Parse flags for non-interactive mode
    const flags: Record<string, string> = {};
    let initTarget = args[1];
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[args[i].slice(2)] = args[i + 1];
        i++;
      } else if (!args[i].startsWith("--")) {
        initTarget = args[i];
      }
    }
    await runInit(initTarget, Object.keys(flags).length > 0 ? flags : undefined);
    return;
  }

  if (cmd === "list" || cmd === "ls" || cmd === "status") {
    await showStatus();
    process.exit(0);
  }

  if (cmd === "start") {
    if (args[1]) {
      const { isServiceInstalled, serviceControl } = await import("./install.js");
      if (isServiceInstalled(args[1])) {
        const ok = serviceControl("start", args[1]);
        if (!ok) {
          console.error(`Failed to start service-managed agent: ${args[1]}`);
          process.exit(1);
        }
        process.exit(0);
      }
    }
    await startAgent(args[1]);
    process.exit(0);
  }

  if (cmd === "stop") {
    if (args[1]) {
      const { isServiceInstalled, serviceControl } = await import("./install.js");
      if (isServiceInstalled(args[1])) {
        const ok = serviceControl("stop", args[1]);
        if (!ok) {
          console.error(`Failed to stop service-managed agent: ${args[1]}`);
          process.exit(1);
        }
        process.exit(0);
      }
    }
    await stopAgent(args[1]);
    process.exit(0);
  }

  if (cmd === "restart") {
    if (args[1]) {
      const { isServiceInstalled, serviceControl } = await import("./install.js");
      if (isServiceInstalled(args[1])) {
        const ok = serviceControl("restart", args[1]);
        if (!ok) {
          console.error(`Failed to restart service-managed agent: ${args[1]}`);
          process.exit(1);
        }
        process.exit(0);
      }
    }
    await stopAgent(args[1]);
    await new Promise((r) => setTimeout(r, 500));
    await startAgent(args[1]);
    process.exit(0);
  }

  if (cmd === "install") {
    const { install } = await import("./install.js");
    await install(args[1]);
    process.exit(0);
  }

  if (cmd === "uninstall") {
    const { uninstall } = await import("./install.js");
    await uninstall(args[1]);
    process.exit(0);
  }

  if (cmd === "remove" || cmd === "rm") {
    const name = args[1];
    if (!name) {
      console.error("Usage: kern remove <name>");
      process.exit(1);
    }
    const { removeAgent, findAgent, isProcessRunning } = await import("./registry.js");
    const { stopAgent } = await import("./daemon.js");
    const agent = findAgent(name);
    if (!agent) {
      console.error(`Agent not found: ${name}`);
      process.exit(1);
    }
    // Uninstall systemd service if installed
    const { isServiceInstalled, uninstall } = await import("./install.js");
    if (isServiceInstalled(name)) {
      await uninstall(name);
    }
    if (agent.pid && isProcessRunning(agent.pid)) {
      await stopAgent(name);
    }
    await removeAgent(name);
    console.log(`  Removed ${name}`);
    process.exit(0);
  }

  if (cmd === "logs") {
    // Parse flags: -f (follow), -n <count>, --level <level>
    let follow: boolean | null = null;  // null = auto (follow unless -n)
    let lines = 50;
    let level: string | null = null;
    let nameArg: string | undefined;
    const logArgs = args.slice(1);
    for (let i = 0; i < logArgs.length; i++) {
      if (logArgs[i] === "-f") { follow = true; }
      else if (logArgs[i] === "-n" && logArgs[i + 1]) { lines = parseInt(logArgs[++i], 10) || 50; }
      else if (logArgs[i] === "--level" && logArgs[i + 1]) { level = logArgs[++i]; }
      else if (!logArgs[i].startsWith("-")) { nameArg = logArgs[i]; }
    }

    const agentDir = await resolveAgentDir(nameArg);
    const logFile = join(agentDir, ".kern", "logs", "kern.log");
    if (!existsSync(logFile)) {
      console.error("No logs yet. Start the agent first.");
      process.exit(1);
    }

    // Level filtering: map level to minimum set of labels to show
    const LEVEL_FILTERS: Record<string, string[]> = {
      debug: [],           // show all (no filtering)
      info: [],            // show all (info has no label)
      warn: ["WRN", "ERR"],
      error: ["ERR"],
    };
    const filterLabels = level ? LEVEL_FILTERS[level] : null;

    // Default: follow unless -n was specified
    const shouldFollow = follow !== null ? follow : !logArgs.some(a => a === "-n");

    if (shouldFollow) {
      const { spawn } = await import("child_process");
      if (!filterLabels || filterLabels.length === 0) {
        const tail = spawn("tail", ["-f", `-n`, String(lines), logFile], { stdio: "inherit" });
        process.on("SIGINT", () => { tail.kill(); process.exit(0); });
      } else {
        // tail + grep
        const pattern = filterLabels.join("\\|");
        const tail = spawn("sh", ["-c", `tail -f -n +1 "${logFile}" | grep --line-buffered "${pattern}"`], { stdio: "inherit" });
        process.on("SIGINT", () => { tail.kill(); process.exit(0); });
      }
    } else {
      // Read last N lines, optionally filter
      const content = await readFile(logFile, "utf-8");
      let allLines = content.trimEnd().split("\n");
      if (filterLabels && filterLabels.length > 0) {
        allLines = allLines.filter(l => filterLabels.some(label => l.includes(label)));
      }
      const output = allLines.slice(-lines);
      for (const line of output) {
        process.stdout.write(line + "\n");
      }
    }
    return;
  }

  if (cmd === "import") {
    const source = args[1]; // "opencode" | "openclaw-lcm"
    if (source === "opencode") {
      const { importOpenCode } = await import("./import-opencode.js");
      await importOpenCode(args.slice(2));
    } else if (source === "openclaw-lcm") {
      const { importOpenClawLcm } = await import("./import-openclaw-lcm.js");
      await importOpenClawLcm(args.slice(2));
    } else {
      console.error("Usage:");
      console.error("  kern import opencode [--project <path>] [--session <title|latest>]");
      console.error("  kern import openclaw-lcm <lcm.db> [--conversation <id>] [--list]");
      process.exit(1);
    }
    return;
  }

  if (cmd === "scripts") {
    const name = args[1]; // "recover-session"
    if (name === "recover-session") {
      const { recoverSession } = await import("./scripts/recover-session.js");
      await recoverSession(args.slice(2));
    } else {
      console.error("Usage:");
      console.error("  kern scripts recover-session <recall.db> [--list] [--session <id>]");
      process.exit(1);
    }
    return;
  }

  if (cmd === "pair") {
    const agentName = args[1];
    const code = args[2];
    if (!agentName || !code) {
      console.error("Usage: kern pair <agent> <code>");
      process.exit(1);
    }
    const { findAgent } = await import("./registry.js");
    const { PairingManager } = await import("./pairing.js");
    const agent = findAgent(agentName);
    if (!agent) {
      console.error(`Agent not found: ${agentName}`);
      process.exit(1);
    }
    const pairing = new PairingManager(agent.path);
    await pairing.load();
    const result = await pairing.pair(code);
    if (result) {
      console.log(`  Paired user ${result.userId} (${result.interface}) to ${agentName}`);
    } else {
      console.error(`  Invalid or expired code: ${code}`);
    }
    process.exit(0);
  }

  if (cmd === "backup") {
    const { backupAgent } = await import("./backup.js");
    await backupAgent(args[1]);
    return;
  }

  if (cmd === "restore") {
    const { restoreAgent } = await import("./backup.js");
    await restoreAgent(args[1]);
    return;
  }

  if (cmd === "tui") {
    const { connectTui } = await import("./tui.js");
    const { findAgent, loadRegistry, readAgentInfo, isProcessRunning } = await import("./registry.js");
    const { startAgent } = await import("./daemon.js");

    let agentName = args[1];

    // Auto-select if no arg
    if (!agentName) {
      const paths = await loadRegistry();
      if (paths.length === 0) {
        console.error("No agents registered. Run 'kern init <name>' first.");
        process.exit(1);
      } else if (paths.length === 1) {
        const info = readAgentInfo(paths[0]);
        agentName = info?.name || paths[0];
      } else {
        const { select } = await import("@inquirer/prompts");
        const choices = paths.map((p) => {
          const info = readAgentInfo(p);
          return { name: info?.name || p, value: info?.name || p };
        });
        agentName = await select({ message: "Select agent", choices });
      }
    }

    // Check if running, auto-start if not
    let agent = findAgent(agentName);
    if (!agent) {
      console.error(`Agent not found: ${agentName}`);
      process.exit(1);
    }

    if (!agent.pid || !isProcessRunning(agent.pid)) {
      await startAgent(agentName);
      // Reload to get the port
      agent = findAgent(agentName);
    }

    if (!agent?.port) {
      console.error(`Cannot determine port for ${agentName}. Is it running?`);
      process.exit(1);
    }

    await connectTui(agent.port, agentName, agent.token || undefined);
    return;
  }

  if (cmd === "run") {
    const initIfNeeded = args.includes("--init-if-needed");
    const dirArg = args.filter((a: string) => a !== "--init-if-needed")[1];
    const agentDir = initIfNeeded ? resolve(dirArg || ".") : await resolveAgentDir(dirArg);

    if (initIfNeeded && !existsSync(join(agentDir, ".kern", "config.json"))) {
      const { scaffoldAgent, API_KEY_ENV } = await import("./init.js");
      const name = process.env.KERN_NAME || basename(agentDir);
      const provider = process.env.KERN_PROVIDER || "openrouter";
      const envVar = API_KEY_ENV[provider] || "OPENROUTER_API_KEY";
      await scaffoldAgent({
        name, dir: agentDir, provider, envVar, skipStart: true,
        model: process.env.KERN_MODEL || "anthropic/claude-opus-4.8",
        apiKey: process.env[envVar] || "",
        telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
        slackBotToken: process.env.SLACK_BOT_TOKEN || "",
        slackAppToken: process.env.SLACK_APP_TOKEN || "",
      });
    }

    await startApp(agentDir);
    return;
  }

  if (cmd === "web") {
    const subcmd = args[1];
    const { webStart, webStop, webStatus } = await import("./web-daemon.js");
    if (subcmd === "start" || subcmd === "stop" || subcmd === "restart") {
      const { getWebServiceStatus } = await import("./install.js");
      if (getWebServiceStatus() !== null) {
        const { spawnSync } = await import("child_process");
        spawnSync("systemctl", ["--user", subcmd, "kern-web"], { stdio: "pipe" });
        return;
      }
      if (subcmd === "start") await webStart();
      else if (subcmd === "stop") await webStop();
      else { await webStop(); await new Promise(r => setTimeout(r, 500)); await webStart(); }
    } else if (subcmd === "status") {
      await webStatus();
    } else if (subcmd === "run") {
      // Run web server in foreground (for Docker)
      await import("./web.js");
    } else {
      console.error("Usage: kern web <run|start|stop|status>");
      process.exit(1);
    }
    return;
  }

  if (cmd === "proxy") {
    const subcmd = args[1];
    const { proxyStart, proxyStop, proxyStatus, proxyToken } = await import("./proxy-daemon.js");
    if (subcmd === "start" || subcmd === "stop" || subcmd === "restart") {
      const { getProxyServiceStatus } = await import("./install.js");
      if (getProxyServiceStatus() !== null) {
        const { spawnSync } = await import("child_process");
        spawnSync("systemctl", ["--user", subcmd, "kern-proxy"], { stdio: "pipe" });
        return;
      }
      if (subcmd === "start") await proxyStart();
      else if (subcmd === "stop") await proxyStop();
      else { await proxyStop(); await new Promise(r => setTimeout(r, 500)); await proxyStart(); }
    } else if (subcmd === "status") {
      await proxyStatus();
    } else if (subcmd === "token") {
      await proxyToken();
    } else {
      console.error("Usage: kern proxy <start|stop|status|token>");
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  await showHelp();
  process.exit(1);
}

main().catch((error) => {
  console.error("Fatal:", error.message);
  process.exit(1);
});
