import { generateText } from "ai";
import { createSummaryModel } from "./model.js";
import { log } from "./log.js";
import type { KernConfig } from "./config.js";

export type NarrationReason = "step_limit" | "timeout" | "wyd";

export interface ToolCallRecord {
  tool: string;
  detail?: string;
  input?: Record<string, unknown>;
  output?: string;
}

export interface TurnSnapshot {
  originalGoal: string;
  stepCount: number;
  maxSteps: number;
  toolCalls: ToolCallRecord[];
  lastEmittedText?: string;
  activeCommand?: string;
}

export function stripEnvelope(text: string): string {
  return text.replace(/^\[via [^\]]+\]\s*/, "").trim();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Render narration text as a markdown blockquote so it reads as a status aside, not a chat reply. */
export function quote(text: string): string {
  return text.trim().split("\n").map((l) => `> ${l}`).join("\n");
}

/**
 * Clean, safe fallback status lines if fast model narration is disabled or fails.
 */
export function buildFallbackNarration(reason: NarrationReason, snapshot: TurnSnapshot): string {
  const lastTool = snapshot.toolCalls.length > 0 ? snapshot.toolCalls[snapshot.toolCalls.length - 1] : null;
  const toolDesc = lastTool ? ` while running \`${lastTool.tool}${lastTool.detail ? ` ${lastTool.detail}` : ""}\`` : "";
  switch (reason) {
    case "step_limit":
      return `⏳ Reached step limit (${plural(snapshot.maxSteps, "step")}).\n${quote(`Work is partially completed${toolDesc}.`)}\n\nReply "continue" to proceed.`;
    case "timeout":
      return `⏱️ Idle timeout reached.\n${quote(`Partial progress was preserved${toolDesc}.`)}\n\nReply "continue" to resume.`;
    case "wyd":
      return quote(`Working on step ${snapshot.stepCount}/${snapshot.maxSteps}${toolDesc}.`);
  }
}

/**
 * Generate a concise, human-readable 1-2 sentence narrative status using the fast model.
 */
export async function narrateTurnStatus(
  reason: NarrationReason,
  snapshot: TurnSnapshot,
  config: KernConfig,
): Promise<string> {
  const fallback = buildFallbackNarration(reason, snapshot);

  try {
    const model = createSummaryModel(config);
    if (!model) return fallback;

    const recentTools = snapshot.toolCalls.slice(-5).map((t, idx) => {
      const out = t.output ? ` -> output: ${t.output.slice(0, 150)}` : "";
      return `  ${idx + 1}. ${t.tool}(${t.detail || ""})${out}`;
    }).join("\n");

    const prompt = `You are a homelab AI assistant summarizing active progress.
Trigger: ${reason}
Original user request: "${stripEnvelope(snapshot.originalGoal)}"
Steps completed: ${snapshot.stepCount} of ${snapshot.maxSteps}
Recent tool activity:
${recentTools || "  (none)"}
Last response fragment: "${(snapshot.lastEmittedText || "").slice(-200)}"

Explain in 1-2 concise, conversational sentences what was accomplished so far, what is currently in flight or stalled, and what the operator should know.
Tone: Terse, direct, factual. No preamble, no filler.`;

    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: 150,
      temperature: 0.2,
    });

    const narrative = result.text.trim();
    if (!narrative) {
      log.warn("narration", `model returned empty text for ${reason}, using fallback`);
      return fallback;
    }

    if (reason === "step_limit") {
      return `⏳ Reached step limit (${plural(snapshot.maxSteps, "step")}).\n${quote(narrative)}\n\nReply "continue" to proceed.`;
    }
    if (reason === "timeout") {
      return `⏱️ Idle timeout reached.\n${quote(narrative)}\n\nReply "continue" to resume.`;
    }
    return quote(narrative);
  } catch (err: any) {
    log.error("narration", `failed to generate AI narration: ${err.message}`);
    return fallback;
  }
}
