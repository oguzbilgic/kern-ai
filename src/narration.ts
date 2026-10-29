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

export type StopReason = Exclude<NarrationReason, "wyd">;

/**
 * Reply hint shown when a turn stops early. Any reply resumes with full history,
 * so lead with context and redirection; "continue" alone undersells it.
 */
export function continuationHint(reason: StopReason): string {
  const resume = reason === "timeout" ? "resume" : "keep going";
  return `Reply with more context, a different direction, or "continue" to ${resume}.`;
}

/** Full step-limit / timeout notice: header, optional quoted status, reply hint. */
export function formatStopNotice(reason: StopReason, maxSteps: number, status?: string): string {
  const header = reason === "timeout"
    ? "⏱️ Idle timeout reached."
    : `⏳ Reached step limit (${plural(maxSteps, "step")}).`;
  const body = status ? `\n${quote(status)}` : "";
  return `${header}${body}\n\n${continuationHint(reason)}`;
}

/**
 * Clean, safe fallback status lines if fast model narration is disabled or fails.
 */
export function buildFallbackNarration(reason: NarrationReason, snapshot: TurnSnapshot): string {
  const lastTool = snapshot.toolCalls.length > 0 ? snapshot.toolCalls[snapshot.toolCalls.length - 1] : null;
  const toolDesc = lastTool ? ` while running \`${lastTool.tool}${lastTool.detail ? ` ${lastTool.detail}` : ""}\`` : "";
  switch (reason) {
    case "step_limit":
      return formatStopNotice("step_limit", snapshot.maxSteps, `Work is partially completed${toolDesc}.`);
    case "timeout":
      return formatStopNotice("timeout", snapshot.maxSteps, `Partial progress was preserved${toolDesc}.`);
    case "wyd":
      return quote(`Working on step ${snapshot.stepCount}/${snapshot.maxSteps}${toolDesc}.`);
  }
}

/** Prompt for the summary model. Stop notices also ask what the operator could reply with to unblock the work. */
export function buildNarrationPrompt(reason: NarrationReason, snapshot: TurnSnapshot): string {
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

Explain in 1-2 concise, conversational sentences what was accomplished so far, what is currently in flight or stalled, and what the operator should know.${reason === "wyd" ? "" : `
If the work is stuck, uncertain, or waiting on a choice, add one final sentence naming the specific detail or decision the operator could reply with to unblock it (for example where something lives, which option they want, or a constraint to relax). Omit it if nothing they could say would help.`}
Tone: Terse, direct, factual. No preamble, no filler.`;
  return prompt;
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

    const prompt = buildNarrationPrompt(reason, snapshot);

    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: 200,
      temperature: 0.2,
    });

    const narrative = result.text.trim();
    if (!narrative) {
      log.warn("narration", `model returned empty text for ${reason}, using fallback`);
      return fallback;
    }

    if (reason === "wyd") return quote(narrative);
    return formatStopNotice(reason, snapshot.maxSteps, narrative);
  } catch (err: any) {
    log.error("narration", `failed to generate AI narration: ${err.message}`);
    return fallback;
  }
}
