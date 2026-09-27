import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";
import { isAgentDir, readAgentInfo, readLivePid } from "./agent-dir.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Ask the running agent for its uptime via the unauthenticated /health endpoint. */
async function fetchUptime(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const body: any = await res.json();
    return typeof body.uptime === "number" ? formatUptime(body.uptime) : null;
  } catch {
    return null;
  }
}

/**
 * One-time courtesy for users upgrading from the registry: if the old
 * ~/.kern/config.json still lists agents, print them as a hint.
 */
async function legacyRegistryHint(): Promise<string[]> {
  const file = join(homedir(), ".kern", "config.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    return Array.isArray(parsed.agents) ? parsed.agents.filter((p: unknown) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Print a single status card for the agent in `[path]` (default `.`). */
export async function showStatus(pathArg?: string): Promise<void> {
  const w = (s: string) => process.stdout.write(s + "\n");
  const agentDir = resolve(pathArg ?? ".");

  if (!isAgentDir(agentDir)) {
    w("");
    w(`  ${dim("No agent in")} ${agentDir} ${dim("(no .kern/ directory).")}`);
    w(`  ${dim("Run")} kern init ${dim("here, or")} kern status <path> ${dim("for an agent elsewhere.")}`);
    const legacy = await legacyRegistryHint();
    if (legacy.length > 0) {
      w("");
      w(`  ${yellow("agents are now directories; previously registered:")}`);
      for (const p of legacy) w(`    ${p}`);
      w(`  ${dim("~/.kern/config.json is no longer read. You can delete it.")}`);
    }
    w("");
    return;
  }

  const info = readAgentInfo(agentDir)!;
  const pid = await readLivePid(agentDir);
  const running = pid !== null;

  let model = "";
  let provider = "";
  let toolScope = "";
  try {
    const config = JSON.parse(await readFile(join(agentDir, ".kern", "config.json"), "utf-8"));
    model = config.model || "";
    provider = config.provider || "";
    toolScope = config.toolScope || "";
  } catch {}

  const uptime = running && info.port ? await fetchUptime(info.port) : null;

  const dot = running ? green("●") : dim("●");
  const modelStr = provider && model ? dim(`${provider}/${model}`) : dim("no config");
  const statusStr = running ? green("running") : dim("stopped");

  w("");
  w(`  ${dot} ${bold(info.name)}  ${modelStr}  ${statusStr}`);
  w(`    ${dim("path:")}   ${agentDir}`);
  w(`    ${dim("port:")}   ${info.port ? `:${info.port}` : "—"}  ${dim("pid:")} ${pid ?? "—"}  ${dim("uptime:")} ${uptime ?? "—"}`);
  w(`    ${dim("tools:")}  ${toolScope || "—"}  ${dim("mode:")} ${running ? "daemon" : "—"}`);
  w("");
}
