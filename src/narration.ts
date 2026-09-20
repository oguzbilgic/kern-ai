import { generateText } from "ai";
import { createSummaryModel } from "./model.js";
import { log } from "./log.js";
import type { KernConfig } from "./config.js";

export type NarrationReason = "step_limit" | "timeout" | "wyd";

export interface ToolCallRecord {
  tool: string;
  detail?: string;
}

/** What we last told the operator, and where in the turn we were when we said it. */
export interface NarrationCheckpoint {
  text: string;
  step: number;
  toolIndex: number;
  textLen: number;
}

export interface TurnSnapshot {
  originalGoal: string;
  stepCount: number;
  maxSteps: number;
  /** Every tool call this turn — only name + short detail, never outputs. */
  toolCalls: ToolCallRecord[];
  /** All assistant text emitted this turn (append-only). */
  lastEmittedText?: string;
  activeCommand?: string;
  /** Set after each successful narration so the next one describes only the delta. */
  lastNarration?: NarrationCheckpoint;
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
 * Build the summary-model prompt. Includes every tool call since the last narration
 * checkpoint (or turn start) — names and short detail only, never tool outputs, so
 * nothing the operator hasn't already seen leaves the main provider.
 */
export function buildNarrationPrompt(reason: NarrationReason, snapshot: TurnSnapshot): string {
  const prev = snapshot.lastNarration;
  const fromTool = prev?.toolIndex ?? 0;
  const fromText = prev?.textLen ?? 0;

  const tools = snapshot.toolCalls.slice(fromTool).map((t, i) =>
    `  ${fromTool + i + 1}. ${t.tool}(${t.detail || ""})`
  ).join("\n");
  const textDelta = (snapshot.lastEmittedText || "").slice(fromText).trim();

  const lines = [
    "You are a homelab AI assistant summarizing active progress.",
    `Trigger: ${reason}`,
    `Original user request: "${stripEnvelope(snapshot.originalGoal)}"`,
    `Steps completed: ${snapshot.stepCount} of ${snapshot.maxSteps}`,
  ];
  if (prev) {
    lines.push(`Previous status (given at step ${prev.step}): "${prev.text}"`);
    lines.push("Tool activity since then:");
  } else {
    lines.push("Tool activity this turn:");
  }
  lines.push(tools || "  (none)");
  lines.push(`Agent text ${prev ? "since then" : "so far"}: "${textDelta.slice(-400)}"`);
  lines.push("");
  lines.push(prev
    ? "Update the status: explain in 1-2 concise sentences what changed since the previous status, what is in flight or stalled, and what the operator should know. Do not repeat the previous status."
    : "Explain in 1-2 concise, conversational sentences what was accomplished so far, what is currently in flight or stalled, and what the operator should know.");
  lines.push("Tone: Terse, direct, factual. No preamble, no filler.");
  return lines.join("\n");
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
      maxOutputTokens: 150,
      temperature: 0.2,
    });

    const narrative = result.text.trim();
    if (!narrative) {
      log.warn("narration", `model returned empty text for ${reason}, using fallback`);
      return fallback;
    }

    // Checkpoint so the next narration (another !wyd, or the step-limit/timeout
    // notice) picks up from here instead of re-describing the whole turn.
    snapshot.lastNarration = {
      text: narrative,
      step: snapshot.stepCount,
      toolIndex: snapshot.toolCalls.length,
      textLen: (snapshot.lastEmittedText || "").length,
    };

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
