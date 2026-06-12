import { tool } from "ai";
import { z } from "zod";
import type { SubAgentRegistry } from "./registry.js";

let _registry: SubAgentRegistry | null = null;

export function setRegistry(registry: SubAgentRegistry) {
  _registry = registry;
}

export const spawnTool = tool({
  description: [
    "Spawn a sub-agent to work on a focused task in parallel.",
    "",
    "Sub-agents run with their own LLM loop and a read-only toolset",
    "(read, glob, grep, webfetch, websearch, pdf, image). They cannot run",
    "shell commands, edit files, or spawn further sub-agents.",
    "",
    "This call returns IMMEDIATELY with a sub-agent ID. The child runs in the",
    "background. When it finishes, its result arrives as a new turn from",
    "`via subagent, subagent:<id>`. You can spawn multiple children in parallel",
    "and synthesize their results as they arrive.",
    "",
    "Use spawn for: research fan-out, parallel documentation lookups, evaluating",
    "multiple candidates, any read-only task you can delegate while you keep",
    "working on something else.",
    "",
    "Do NOT use spawn for trivial one-off reads — just use the read tool directly.",
    "Sub-agents are for tasks that need their own reasoning loop.",
  ].join("\n"),
  inputSchema: z.object({
    prompt: z.string().describe(
      "The task for the sub-agent. Give a clear, self-contained instruction — " +
      "the sub-agent starts with no context about your current work."
    ),
    maxSteps: z.number().optional().describe(
      "Maximum reasoning steps for this child (default: 20, max: 50)."
    ),
    model: z.string().optional().describe(
      "Model override for this child. Runs on the parent's provider, so the " +
      "ID must be valid there — same format as the main model config. " +
      "Defaults to the subAgentModel config field, or the parent's model."
    ),
  }),
  execute: async ({ prompt, maxSteps, model }) => {
    if (!_registry) return "Error: sub-agents not available.";

    try {
      const handle = _registry.spawn(prompt, maxSteps ?? 20, model);
      return [
        `Sub-agent spawned: ${handle.id}`,
        `Status: running`,
        ``,
        `The child is working in the background. Its result will arrive as`,
        `a new turn when it finishes. Keep working; you can spawn more`,
        `sub-agents in parallel. Use the subagents tool to check status or`,
        `cancel if needed.`,
      ].join("\n");
    } catch (e: any) {
      return `Error spawning sub-agent: ${e.message}`;
    }
  },
});

export const subagentsTool = tool({
  description: [
    "Inspect and manage sub-agents you've spawned.",
    "",
    "Actions:",
    "  list    — show all sub-agents with status",
    "  status  — detailed status of a specific sub-agent (requires id)",
    "  cancel  — abort a running sub-agent (requires id)",
    "  result  — fetch the final result of a completed sub-agent (requires id)",
  ].join("\n"),
  inputSchema: z.object({
    action: z
      .enum(["list", "status", "cancel", "result"])
      .describe("What to do"),
    id: z
      .string()
      .optional()
      .describe("Sub-agent ID (required for status, cancel, result)"),
  }),
  execute: async ({ action, id }) => {
    if (!_registry) return "Error: sub-agents not available.";

    if (action === "list") {
      const all = _registry.list();
      if (all.length === 0) return "No sub-agents.";
      return all
        .map((r) => {
          const dur = r.finishedAt
            ? `${Math.round((+new Date(r.finishedAt) - +new Date(r.startedAt)) / 1000)}s`
            : `${Math.round((Date.now() - +new Date(r.startedAt)) / 1000)}s`;
          const preview = r.prompt.slice(0, 60).replace(/\n/g, " ");
          return `${r.id}  ${r.status.padEnd(10)}  ${dur.padStart(6)}  ${preview}${r.prompt.length > 60 ? "..." : ""}`;
        })
        .join("\n");
    }

    if (!id) return "Error: id required for this action.";

    if (action === "cancel") {
      const ok = _registry.cancel(id);
      if (!ok) return `Cannot cancel ${id} — not found or not running.`;
      return `Cancelled ${id}.`;
    }

    // status + result both need the record
    let record = _registry.get(id)?.record;
    if (!record) record = (await _registry.loadFromDisk(id)) ?? undefined;
    if (!record) return `Sub-agent ${id} not found.`;

    if (action === "result") {
      if (record.status === "running") return `Sub-agent ${id} is still running.`;
      if (record.status === "failed") return `Sub-agent ${id} failed: ${record.error || "unknown error"}`;
      if (record.status === "cancelled") return `Sub-agent ${id} was cancelled.`;
      return record.result || "(no result)";
    }

    // status
    const lines = [
      `id:         ${record.id}`,
      `status:     ${record.status}`,
      `started:    ${record.startedAt}`,
    ];
    if (record.model) lines.splice(2, 0, `model:      ${record.model}`);
    if (record.finishedAt) lines.push(`finished:   ${record.finishedAt}`);
    lines.push(`tool calls: ${record.toolCalls}`);
    if (record.inputTokens || record.outputTokens) {
      lines.push(`tokens:     ${record.inputTokens} in / ${record.outputTokens} out`);
    }
    lines.push(``, `prompt:`, record.prompt);
    if (record.error) lines.push(``, `error:`, record.error);
    return lines.join("\n");
  },
});
