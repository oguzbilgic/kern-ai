#!/usr/bin/env -S node --no-deprecation

import { resolve, basename } from "path";
import { existsSync } from "fs";
import { startApp } from "./app.js";
import { runInit } from "./init.js";
import { showStatus } from "./status.js";
import { startAgent, stopAgent, restartAgent } from "./daemon.js";
import { AgentDirError, resolveAgentDir, readAgentInfo, readLivePid } from "./agent-dir.js";
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
  w(`    ${dim("An agent is a directory containing .kern/. [path] defaults to the current directory.")}`);
  w("");
  w(`    ${cyan("kern init")} ${dim("[path]")}             create or configure an agent`);
  w(`    ${cyan("kern start")} ${dim("[path]")}            start the agent in the background`);
  w(`    ${cyan("kern stop")} ${dim("[path]")}             stop the agent`);
  w(`    ${cyan("kern restart")} ${dim("[path]")}          restart the agent`);
  w(`    ${cyan("kern run")} ${dim("[path]")}              run the agent in the foreground`);
  w(`    ${cyan("kern status")} ${dim("[path]")}           show the agent status (alias: list, ls)`);
  w(`    ${cyan("kern logs")} ${dim("[path] [-f] [-n 50] [--level warn]")}  show agent logs`);
  w(`    ${cyan("kern tui")} ${dim("[path]")}              interactive chat`);
  w(`    ${cyan("kern pair")} ${dim("[path] <code>")}      approve a pairing code`);
  w(`    ${cyan("kern backup")} ${dim("[path]")}           backup agent to .tar.gz`);
  w(`    ${cyan("kern restore")} ${dim("<file>")}          restore agent from backup`);
  w(`    ${cyan("kern web")} ${dim("<run|start|status|stop> [--port 8080] [--host 0.0.0.0]")}  static web UI server`);
  w(`    ${cyan("kern import")} ${dim("opencode <name>")}         import session from OpenCode`);
  w(`    ${cyan("kern import")} ${dim("openclaw-lcm <lcm.db>")}   import session from OpenClaw LCM`);
  w(`    ${cyan("kern scripts")} ${dim("recover-session <recall.db>")}  rebuild a session from recall.db`);
  w(`    ${cyan("kern scripts")} ${dim("segment-health <recall.db>")}   analyze summary tree: overlaps, gaps, injected waste`);
  w(`    ${cyan("kern scripts")} ${dim("segment-prune <recall.db>")}    prune overlapping segments to one tiling per level (dry-run by default)`);
  w(`    ${cyan("kern scripts")} ${dim("recall-health <recall.db>")}     analyze embedding coverage, vector health, batch blockers`);
  w(`    ${cyan("kern scripts")} ${dim("recall-repair <recall.db>")}     repair missing vectors and backfill orphaned chunks (dry-run by default)`);
  w("");
  w(`  ${dim("Multiple agents: one directory each, e.g.")} kern start ~/alice ${dim("and")} kern start ~/bob`);
  w("");
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
    await showStatus(args[1]);
    process.exit(0);
  }

  if (cmd === "start") {
    console.log("");
    await startAgent(resolveAgentDir(args[1]));
    console.log("");
    process.exit(0);
  }

  if (cmd === "stop") {
    console.log("");
    await stopAgent(resolveAgentDir(args[1]));
    console.log("");
    process.exit(0);
  }

  if (cmd === "restart") {
    console.log("");
    await restartAgent(resolveAgentDir(args[1]));
    console.log("");
    process.exit(0);
  }

  if (cmd === "install" || cmd === "uninstall") {
    console.error("systemd services are not available in this version.");
    process.exit(1);
  }

  if (cmd === "remove" || cmd === "rm") {
    console.error("Agents are directories; delete the folder to remove one.");
    process.exit(1);
  }

  if (cmd === "proxy") {
    console.error("kern proxy is not available in this version.");
    process.exit(1);
  }

  if (cmd === "logs") {
    // Parse flags: -f (follow), -n <count>, --level <level>
    let follow: boolean | null = null;  // null = auto (follow unless -n)
    let lines = 50;
    let level: string | null = null;
    let pathArg: string | undefined;
    const logArgs = args.slice(1);
    for (let i = 0; i < logArgs.length; i++) {
      if (logArgs[i] === "-f") { follow = true; }
      else if (logArgs[i] === "-n" && logArgs[i + 1]) { lines = parseInt(logArgs[++i], 10) || 50; }
      else if (logArgs[i] === "--level" && logArgs[i + 1]) { level = logArgs[++i]; }
      else if (!logArgs[i].startsWith("-")) { pathArg = logArgs[i]; }
    }

    const agentDir = resolveAgentDir(pathArg);
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
      const { importOpenCode } = await import("./scripts/import-opencode.js");
      await importOpenCode(args.slice(2));
    } else if (source === "openclaw-lcm") {
      const { importOpenClawLcm } = await import("./scripts/import-openclaw-lcm.js");
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
    } else if (name === "segment-health") {
      const { segmentHealth } = await import("./scripts/segment-health.js");
      await segmentHealth(args.slice(2));
    } else if (name === "segment-prune") {
      const { segmentPrune } = await import("./scripts/segment-prune.js");
      await segmentPrune(args.slice(2));
    } else if (name === "recall-health") {
      const { recallHealth } = await import("./scripts/recall-health.js");
      await recallHealth(args.slice(2));
    } else if (name === "recall-repair") {
      const { recallRepair } = await import("./scripts/recall-repair.js");
      await recallRepair(args.slice(2));
    } else {
      console.error("Usage:");
      console.error("  kern scripts recover-session <recall.db> [--list] [--session <id>]");
      console.error("  kern scripts segment-health <recall.db> [--session <id>] [--budget <tokens>] [--limit <n>] [--json]");
      console.error("  kern scripts segment-prune <recall.db> [--session <id>] [--budget <tokens>] [--apply] [--no-backup] [--limit <n>] [--json]");
      console.error("  kern scripts recall-health <recall.db> [--session <id>] [--limit <n>] [--json] [--list]");
      console.error("  kern scripts recall-repair <recall.db> [--session <id>] [--apply] [--no-backup] [--json] [--list]");
      process.exit(1);
    }
    return;
  }

  if (cmd === "pair") {
    // kern pair <code>          → agent in the current directory
    // kern pair <path> <code>   → agent in <path>
    const pathArg = args.length >= 3 ? args[1] : undefined;
    const code = args.length >= 3 ? args[2] : args[1];
    if (!code) {
      console.error("Usage: kern pair [path] <code>");
      process.exit(1);
    }
    const agentDir = resolveAgentDir(pathArg);
    const info = readAgentInfo(agentDir)!;
    const { PairingManager } = await import("./pairing.js");
    const pairing = new PairingManager(agentDir);
    await pairing.load();
    const result = await pairing.pair(code);
    if (result) {
      console.log(`  Paired user ${result.userId} (${result.interface}) to ${info.name}`);
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
    const agentDir = resolveAgentDir(args[1]);

    // Auto-start if not running
    if (!(await readLivePid(agentDir))) {
      console.log("");
      await startAgent(agentDir);
      console.log("");
    }

    const agent = readAgentInfo(agentDir)!;
    if (!agent.port) {
      console.error(`Cannot determine port for ${agent.name}. Is it running?`);
      process.exit(1);
    }

    await connectTui(agent.port, agent.name, agentDir, agent.token || undefined);
    return;
  }

  if (cmd === "run") {
    const initIfNeeded = args.includes("--init-if-needed");
    const dirArg = args.filter((a: string) => a !== "--init-if-needed")[1];
    const agentDir = initIfNeeded ? resolve(dirArg || ".") : resolveAgentDir(dirArg);

    if (initIfNeeded && !existsSync(join(agentDir, ".kern", "config.json"))) {
      const { scaffoldAgent, API_KEY_ENV, DEFAULT_PROVIDER_MODELS } = await import("./init.js");
      const name = process.env.KERN_NAME || basename(agentDir);
      const provider = process.env.KERN_PROVIDER || "openrouter";
      const envVar = API_KEY_ENV[provider] || "OPENROUTER_API_KEY";
      await scaffoldAgent({
        name, dir: agentDir, provider, envVar, skipStart: true,
        model: process.env.KERN_MODEL || DEFAULT_PROVIDER_MODELS[provider] || "google/gemini-3.8-flash",
        apiKey: process.env[envVar] || "",
        telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
        slackBotToken: process.env.SLACK_BOT_TOKEN || "",
        slackAppToken: process.env.SLACK_APP_TOKEN || "",
        matrixHomeserver: process.env.MATRIX_HOMESERVER || "",
        matrixUserId: process.env.MATRIX_USER_ID || "",
        matrixAccessToken: process.env.MATRIX_ACCESS_TOKEN || "",
        discordToken: process.env.DISCORD_TOKEN || "",
        nostrNsec: process.env.NOSTR_NSEC || "",
        nostrRelays: process.env.NOSTR_RELAYS || "",
        ircUrl: process.env.IRC_URL || "",
      });
    }

    await startApp(agentDir);
    return;
  }

  if (cmd === "web") {
    const subcmd = args[1];
    const { webStart, webStop, webStatus, parseWebFlags } = await import("./web-daemon.js");
    if (subcmd === "start" || subcmd === "run" || subcmd === "restart") {
      let flags;
      try {
        flags = parseWebFlags(args.slice(2));
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        console.error("Usage: kern web <run|start|status|stop> [--port 8080] [--host 0.0.0.0]");
        process.exit(1);
      }
      if (subcmd === "run") {
        // Foreground (for Docker). web.js reads --port/--host from this process's argv.
        await import("./web.js");
      } else if (subcmd === "start") {
        await webStart(flags);
      } else {
        await webStop();
        await new Promise((r) => setTimeout(r, 500));
        await webStart(flags);
      }
    } else if (subcmd === "stop") {
      await webStop();
    } else if (subcmd === "status") {
      await webStatus();
    } else {
      console.error("Usage: kern web <run|start|status|stop> [--port 8080] [--host 0.0.0.0]");
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  await showHelp();
  process.exit(1);
}

main().catch((error) => {
  if (error instanceof AgentDirError) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error("Fatal:", error.message);
  }
  process.exit(1);
});
