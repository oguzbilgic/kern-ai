import { spawn } from "child_process";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync, openSync } from "fs";
import { homedir } from "os";
import { isProcessRunning } from "./agent-dir.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const KERN_DIR = join(homedir(), ".kern");
const STATE_FILE = join(KERN_DIR, "web.json");
const LEGACY_PID_FILE = join(KERN_DIR, "web.pid");
const LOG_FILE = join(KERN_DIR, "web.log");

export const DEFAULT_WEB_PORT = 8080;
export const DEFAULT_WEB_HOST = "0.0.0.0";

export interface WebFlags {
  port: number;
  host: string;
}

/**
 * Parse `--port P` / `--host H` from an argv slice. Anything else is ignored.
 * Defaults: port 8080, host 0.0.0.0. Throws on a port that is not 1-65535.
 */
export function parseWebFlags(argv: string[]): WebFlags {
  let port = DEFAULT_WEB_PORT;
  let host = DEFAULT_WEB_HOST;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`invalid --port ${raw ?? ""}: expected 1-65535`);
      }
      port = n;
    } else if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      const n = Number(raw);
      if (!raw || !Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`invalid --port ${raw}: expected 1-65535`);
      }
      port = n;
    } else if (arg === "--host") {
      const raw = argv[++i];
      if (!raw || raw.startsWith("--")) throw new Error("--host requires a value");
      host = raw;
    } else if (arg.startsWith("--host=")) {
      const raw = arg.slice("--host=".length);
      if (!raw) throw new Error("--host requires a value");
      host = raw;
    }
  }
  return { port, host };
}

interface WebState {
  pid: number;
  port: number;
  host: string;
}

async function readState(): Promise<WebState | null> {
  if (existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(await readFile(STATE_FILE, "utf-8"));
      if (typeof parsed.pid === "number") {
        return { pid: parsed.pid, port: parsed.port ?? DEFAULT_WEB_PORT, host: parsed.host ?? DEFAULT_WEB_HOST };
      }
    } catch {}
  }
  // One-time fallback so `kern web stop` still finds a daemon started before web.json existed
  if (existsSync(LEGACY_PID_FILE)) {
    try {
      const pid = parseInt(await readFile(LEGACY_PID_FILE, "utf-8"), 10);
      if (!isNaN(pid)) return { pid, port: DEFAULT_WEB_PORT, host: DEFAULT_WEB_HOST };
    } catch {}
  }
  return null;
}

async function clearState(): Promise<void> {
  try { await unlink(STATE_FILE); } catch {}
  try { await unlink(LEGACY_PID_FILE); } catch {}
}

export async function webStart(flags: WebFlags): Promise<void> {
  const state = await readState();
  if (state && isProcessRunning(state.pid)) {
    console.log(`\n  ${green("●")} ${bold("web")} already running ${dim(`(pid ${state.pid}, ${state.host}:${state.port})`)}`);
    console.log(`  → http://localhost:${state.port}\n`);
    return;
  }

  await mkdir(KERN_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const webEntry = join(import.meta.dirname, "web.js");

  const child = spawn(
    process.execPath,
    ["--no-deprecation", webEntry, "--port", String(flags.port), "--host", flags.host],
    { detached: true, stdio: ["ignore", logFd, logFd] },
  );

  child.unref();
  const pid = child.pid!;
  const newState: WebState = { pid, port: flags.port, host: flags.host };
  await writeFile(STATE_FILE, JSON.stringify(newState, null, 2) + "\n");
  try { await unlink(LEGACY_PID_FILE); } catch {}

  await new Promise((r) => setTimeout(r, 1000));

  if (isProcessRunning(pid)) {
    console.log(`\n  ${green("●")} ${bold("web")} started ${dim(`(pid ${pid}, ${flags.host}:${flags.port})`)}`);
    console.log(`  → http://localhost:${flags.port}\n`);
  } else {
    await clearState();
    console.log(`\n  ${red("●")} ${bold("web")} failed to start\n`);
    try {
      const log = await readFile(LOG_FILE, "utf-8");
      const lines = log.trim().split("\n").slice(-5);
      for (const line of lines) {
        console.log(`    ${dim(line)}`);
      }
    } catch {}
  }
}

export async function webStop(): Promise<void> {
  const state = await readState();
  if (!state || !isProcessRunning(state.pid)) {
    console.log(`\n  ${dim("●")} ${bold("web")} not running\n`);
    await clearState();
    return;
  }

  try {
    process.kill(state.pid, "SIGTERM");
    await clearState();
    console.log(`\n  ${red("●")} ${bold("web")} stopped ${dim(`(was pid ${state.pid})`)}\n`);
  } catch (e: any) {
    console.error(`  Failed to stop web: ${e.message}`);
  }
}

export async function webStatus(): Promise<void> {
  const state = await readState();
  const running = !!state && isProcessRunning(state.pid);

  if (running && state) {
    console.log(`\n  ${green("●")} ${bold("web")} running ${dim(`(pid ${state.pid}, ${state.host}:${state.port})`)}`);
    console.log(`    ${dim("mode:")} daemon\n`);
  } else {
    console.log(`\n  ${dim("●")} ${bold("web")} stopped`);
    console.log(`    ${dim("mode:")} —\n`);
    if (state) await clearState();
  }
}
