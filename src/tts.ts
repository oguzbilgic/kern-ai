import { experimental_generateSpeech as generateSpeech } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { log } from "./log.js";

/**
 * Text-to-speech synthesis for voice replies.
 *
 * Deliberately zero-config: uses the standard OPENAI_API_KEY env var if
 * present, otherwise TTS is unavailable and callers skip voice output.
 * OpenAI is currently the only wired provider because it emits Ogg/Opus
 * natively (what Telegram sendVoice expects) — no transcoding needed.
 */

const TTS_MODEL = "gpt-4o-mini-tts";
// OpenAI speech API caps input at 4096 chars
const MAX_TTS_CHARS = 4000;

export function ttsAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Synthesize speech from text. Returns an Ogg/Opus audio buffer,
 * or null when no TTS provider is available.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  if (!ttsAvailable()) return null;
  const input = text.length > MAX_TTS_CHARS ? text.slice(0, MAX_TTS_CHARS) : text;
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = await generateSpeech({
    model: openai.speech(TTS_MODEL),
    text: input,
    outputFormat: "opus",
  });
  log("tts", `synthesized ${input.length} chars → ${result.audio.uint8Array.length} bytes (${result.audio.format})`);
  return Buffer.from(result.audio.uint8Array);
}
