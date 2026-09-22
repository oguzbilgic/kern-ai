import { tool } from "ai";
import { z } from "zod";
import { shellExec, formatShellResult } from "../../tools/shell.js";
import type { PluginContext } from "../types.js";
import { JobRegistry, formatDuration, formatHeader } from "./registry.js";

let _registry: JobRegistry | null = null;
let _ctx: PluginContext | null = null;

export function setRegistry(registry: JobRegistry | null, ctx: PluginContext | null) {
  _registry = registry;
  _ctx = ctx;
}

/** Jobs that finish within this window are reported synchronously, no completion turn. */
export const BACKGROUND_GRACE_MS = 2000;

export const bashTool = tool({
  description: [
    "Run a shell command. Use this for system commands, git operations, SSH, installing packages, etc.",
    "Commands run in the agent's working directory.",
    "",
    "Pass background: true for anything that may take more than a minute or two",
    "(builds, test suites, migrations, external CLIs). The command is started",
    "detached and this call returns immediately with a job ID and log path. When",
    "it finishes, its exit code and output tail arrive as a new message in the",
    "conversation that started it — you don't need to poll or use the message",
    "tool. If a background command finishes within a couple of seconds, its",
    "output is returned directly instead.",
  ].join("\n"),
  inputSchema: z.object({
    command: z.string().describe("The shell command to execute"),
    timeout: z
      .number()
      .optional()
      .describe("Timeout in milliseconds (default: 120000 for foreground; no limit for background)"),
    background: z
      .boolean()
      .optional()
      .describe("Run detached and return immediately; completion arrives as a new message"),
  }),
  execute: async ({ command, timeout, background }) => {
    if (!background) {
      const t = timeout ?? 120000;
      const result = await shellExec(command, { timeout: t });
      return formatShellResult(result, t);
    }

    if (!_registry) return "Error: background jobs not available.";

    const handle = _registry.start(command, {
      origin: _ctx?.origin() ?? null,
      timeout,
      graceMs: BACKGROUND_GRACE_MS,
    });

    const finished = await Promise.race([
      handle.done.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), BACKGROUND_GRACE_MS)),
    ]);

    const tail = _registry.tail(handle.id) ?? "";

    if (finished) {
      // Quick command — behave like a foreground call. Not announced.
      const r = handle.record;
      const parts = [tail.trim() || "(no output)"];
      if (r.status === "killed") parts.push(`Error: killed${r.signal ? ` (${r.signal})` : ""}`);
      else if (r.exitCode !== 0) parts.push(`Error: exit code ${r.exitCode}`);
      parts.push(`(finished in ${formatDuration(r)}; ran as ${r.id})`);
      return parts.join("\n");
    }

    return [
      `Started background job ${handle.id} (pid ${handle.record.pid ?? "?"}).`,
      `Log: ${handle.record.logPath}`,
      tail.trim() ? `Output so far:\n${tail.trim().slice(-2000)}` : "No output yet.",
      ``,
      `Its exit code and output tail will arrive as a new message when it finishes,`,
      `in the conversation that asked for it. Keep working or tell the user it's`,
      `running; use jobs({ action: "tail" | "status" | "kill", id }) to inspect.`,
    ].join("\n");
  },
});

export const jobsTool = tool({
  description: [
    "Inspect and manage background jobs started with bash({ background: true }).",
    "",
    "Actions:",
    "  list    — all jobs with status",
    "  status  — details of one job (requires id)",
    "  tail    — last output of a job (requires id; optional chars)",
    "  kill    — terminate a running job (requires id)",
  ].join("\n"),
  inputSchema: z.object({
    action: z.enum(["list", "status", "tail", "kill"]).describe("What to do"),
    id: z.string().optional().describe("Job ID (required for status, tail, kill)"),
    chars: z.number().optional().describe("For tail: how many trailing characters (default 4000)"),
  }),
  execute: async ({ action, id, chars }) => {
    if (!_registry) return "Error: background jobs not available.";

    if (action === "list") {
      const all = _registry.list();
      if (all.length === 0) return "No jobs.";
      return all
        .map((r) => {
          const preview = r.command.replace(/\s+/g, " ").slice(0, 60);
          const outcome = r.status === "running" ? "running" : formatHeader(r).replace(/^\[job:\S+ /, "").replace(/\]$/, "");
          return `${r.id}  ${outcome.padEnd(16)}  ${formatDuration(r).padStart(6)}  ${preview}${r.command.length > 60 ? "..." : ""}`;
        })
        .join("\n");
    }

    if (!id) return "Error: id required for this action.";

    if (action === "kill") {
      const ok = _registry.kill(id);
      if (!ok) return `Cannot kill ${id} — not found or not running.`;
      return `Sent SIGTERM to ${id}. Its completion will arrive as a new message.`;
    }

    if (action === "tail") {
      const tail = _registry.tail(id, chars ?? 4000);
      if (tail === null) return `Job ${id} not found in this process.`;
      return tail.trim() || "(no output yet)";
    }

    let record = _registry.get(id)?.record;
    if (!record) record = (await _registry.loadFromDisk(id)) ?? undefined;
    if (!record) return `Job ${id} not found.`;

    const lines = [
      `id:       ${record.id}`,
      `status:   ${record.status}`,
      `command:  ${record.command}`,
      `cwd:      ${record.cwd}`,
      `pid:      ${record.pid ?? "?"}`,
      `started:  ${record.startedAt}`,
    ];
    if (record.finishedAt) lines.push(`finished: ${record.finishedAt}`);
    if (record.status !== "running") lines.push(`exit:     ${record.exitCode ?? "?"}${record.signal ? ` (${record.signal})` : ""}`);
    lines.push(`log:      ${record.logPath}`);
    if (record.origin) lines.push(`origin:   ${record.origin.interface}, ${record.origin.channel}, user ${record.origin.userId}`);
    return lines.join("\n");
  },
});
