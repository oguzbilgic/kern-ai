import { streamText, stepCountIs, type ModelMessage } from "ai";
import { mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { log } from "../../log.js";
import { createModel } from "../../model.js";
import { allTools, type ToolName } from "../../tools/index.js";
import type { KernConfig } from "../../config.js";

/**
 * Sub-agent worker — runs the LLM loop for a single child.
 *
 * Design choices (v1):
 * - In-process: shares prompt cache, MCP connections, no IPC overhead.
 * - Read-only tools only: no bash/edit/write — crash surface is tiny.
 * - No plugin hooks: children don't get notes, skills, recall, or MCP.
 *   They're stateless workers, not full agents.
 * - No nested spawning: children can't spawn grandchildren (enforced by
 *   tool allowlist — spawn is not in SUBAGENT_TOOLS).
 * - AbortSignal for cancellation: no process kill needed.
 *
 * On-disk layout for each child:
 *   .kern/subagents/<id>/
 *     prompt.md          — original task
 *     session.jsonl      — running transcript (rewritten per step)
 *     record.json        — final metadata (written on finish)
 */

/** Tools sub-agents are allowed to use in v1. Read-only + research. */
const SUBAGENT_TOOLS: ToolName[] = [
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "pdf",
  "image",
  "audio",
];

const SUBAGENT_SYSTEM_PROMPT = [
  "You are a sub-agent spawned by a parent kern agent to complete a focused task.",
  "",
  "You have access to read-only tools: read, glob, grep, webfetch, websearch, pdf, image, audio.",
  "You cannot execute shell commands, edit files, or spawn further sub-agents.",
  "",
  "Complete the task given to you, then reply with a concise result.",
  "The parent will see your final text response. Be direct and factual.",
  "If the task is ambiguous or impossible, say so clearly.",
].join("\n");

export interface RunOptions {
  id: string;
  prompt: string;
  config: KernConfig;
  agentDir: string;
  maxSteps: number;
  signal: AbortSignal;
  onToolCall?: () => void;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

/**
 * Run a sub-agent to completion. Throws on cancellation or error.
 * Returns the child's final text response on success.
 */
export async function runSubAgent(opts: RunOptions): Promise<string> {
  const { id, prompt, config, agentDir, maxSteps, signal, onToolCall, onUsage } = opts;

  const subDir = join(agentDir, ".kern", "subagents", id);
  await mkdir(subDir, { recursive: true });
  await writeFile(join(subDir, "prompt.md"), prompt, "utf-8");

  const tools: Record<string, any> = {};
  for (const name of SUBAGENT_TOOLS) {
    if (name in allTools) {
      tools[name] = allTools[name as ToolName];
    }
  }

  const messages: ModelMessage[] = [{ role: "user", content: prompt }];
  const model = createModel(config);
  let fullText = "";
  const persistedMessages: ModelMessage[] = [...messages];

  const result = streamText({
    model,
    system: SUBAGENT_SYSTEM_PROMPT,
    messages,
    tools,
    abortSignal: signal,
    stopWhen: stepCountIs(maxSteps),
    onStepFinish: async (step) => {
      const allMsgs = step.response.messages as ModelMessage[];
      // response.messages is cumulative across steps; skip what we already
      // wrote. Offset by 1 because persistedMessages starts with the user prompt,
      // which isn't in response.messages.
      const already = persistedMessages.length - 1;
      const newMsgs = allMsgs.slice(already);
      if (newMsgs.length > 0) {
        persistedMessages.push(...newMsgs);
        await writeSessionFile(subDir, persistedMessages).catch((e) =>
          log.warn("subagent", `session write failed for ${id}: ${e.message}`),
        );
      }
    },
  });

  for await (const part of result.fullStream) {
    if (signal.aborted) break;
    if (part.type === "text-delta") {
      const text = ("delta" in part ? part.delta : (part as any).text) || "";
      fullText += text;
    } else if (part.type === "tool-call") {
      onToolCall?.();
    }
  }

  try {
    const usage = await result.totalUsage;
    onUsage?.(usage.inputTokens || 0, usage.outputTokens || 0);
  } catch {
    // usage unavailable — non-critical
  }

  if (signal.aborted) {
    throw new Error("Cancelled by parent");
  }

  log("subagent", `${id} finished: ${fullText.length} chars`);
  return fullText || "(no text response)";
}

async function writeSessionFile(subDir: string, messages: ModelMessage[]): Promise<void> {
  const path = join(subDir, "session.jsonl");
  const lines = messages.map((m) => JSON.stringify(m));
  await writeFile(path, lines.join("\n") + "\n", "utf-8");
}

export async function loadRecord(agentDir: string, id: string): Promise<any | null> {
  const path = join(agentDir, ".kern", "subagents", id, "record.json");
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function writeRecord(agentDir: string, record: any): Promise<void> {
  const subDir = join(agentDir, ".kern", "subagents", record.id);
  await mkdir(subDir, { recursive: true });
  await writeFile(join(subDir, "record.json"), JSON.stringify(record, null, 2), "utf-8");
}
