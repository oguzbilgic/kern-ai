import { experimental_generateSpeech as generateSpeech } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { Mp3Encoder } from "@breezystack/lamejs";
import { log } from "./log.js";

/**
 * Text-to-speech synthesis for voice replies.
 *
 * Deliberately zero-config — tries available providers in order:
 *   1. OpenRouter (OPENROUTER_API_KEY): openai/gpt-audio-mini via streamed
 *      chat completion with audio output (pcm16), encoded to MP3 in-process.
 *   2. OpenAI (OPENAI_API_KEY): gpt-4o-mini-tts speech endpoint with native
 *      Ogg/Opus output.
 * If neither key is present, TTS is unavailable and callers skip voice output.
 *
 * Both output formats (MP3, Ogg/Opus) are accepted by Telegram sendVoice.
 * No ffmpeg or native dependencies — MP3 encoding is pure JS (lamejs).
 */

const OPENROUTER_TTS_MODEL = "openai/gpt-audio-mini";
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
// OpenAI speech API caps input at 4096 chars
const MAX_TTS_CHARS = 4000;
// gpt-audio pcm16 output: 24kHz mono 16-bit signed LE
const PCM_SAMPLE_RATE = 24000;

export interface SynthesizedAudio {
  data: Buffer;
  filename: string;
  mimeType: string;
}

export function ttsAvailable(): boolean {
  return !!(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);
}

/** Strip markdown syntax so it isn't read aloud (code fences, bold, lists, etc.). */
export function stripForSpeech(text: string): string {
  let plain = text;
  plain = plain.replace(/```\w*\n([\s\S]*?)```/g, "$1");
  plain = plain.replace(/`([^`]+)`/g, "$1");
  plain = plain.replace(/\*\*(.+?)\*\*/g, "$1");
  plain = plain.replace(/(?<![*])(\*)(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$2");
  plain = plain.replace(/~~(.+?)~~/g, "$1");
  plain = plain.replace(/^[-*] /gm, "");
  plain = plain.replace(/^#+ /gm, "");
  plain = plain.replace(/^> /gm, "");
  plain = plain.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  return plain;
}

/**
 * Synthesize speech from text using the first available provider.
 * Returns null when no TTS provider is available.
 */
export async function synthesizeSpeech(text: string): Promise<SynthesizedAudio | null> {
  // Don't truncate: callers delete the text reply once voice is sent, so a
  // capped voice note would silently lose the remainder. Oversized replies
  // fall back to text instead.
  if (text.length > MAX_TTS_CHARS) return null;
  const input = text;

  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await synthesizeViaOpenRouter(input);
    } catch (err: any) {
      log.warn("tts", `openrouter synthesis failed: ${err.message}`);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      return await synthesizeViaOpenAI(input);
    } catch (err: any) {
      log.warn("tts", `openai synthesis failed: ${err.message}`);
    }
  }
  return null;
}

/**
 * OpenRouter path: audio-output chat completion. Audio output requires
 * stream:true, and streaming only supports pcm16 — so we collect the PCM
 * chunks and encode MP3 locally.
 */
async function synthesizeViaOpenRouter(text: string): Promise<SynthesizedAudio> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_TTS_MODEL,
      stream: true,
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "pcm16" },
      messages: [
        {
          role: "user",
          content: `Read the following text aloud exactly as written. Do not add, omit, or comment on anything:\n\n${text}`,
        },
      ],
    }),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`openrouter HTTP ${resp.status}`);
  }

  // Parse the SSE stream, collecting base64 pcm16 audio deltas
  const chunks: Buffer[] = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed.slice(6));
      } catch {
        continue;
      }
      if (parsed.error) throw new Error(parsed.error.message || "provider error");
      const data = parsed.choices?.[0]?.delta?.audio?.data;
      if (data) chunks.push(Buffer.from(data, "base64"));
    }
  }
  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) throw new Error("no audio in response");

  const mp3 = encodeMp3(pcm);
  log("tts", `openrouter: ${text.length} chars → ${pcm.length} pcm bytes → ${mp3.length} mp3 bytes`);
  return { data: mp3, filename: "reply.mp3", mimeType: "audio/mpeg" };
}

/** OpenAI path: dedicated speech endpoint, native Ogg/Opus output. */
async function synthesizeViaOpenAI(text: string): Promise<SynthesizedAudio> {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = await generateSpeech({
    model: openai.speech(OPENAI_TTS_MODEL),
    text,
    outputFormat: "opus",
  });
  const data = Buffer.from(result.audio.uint8Array);
  log("tts", `openai: ${text.length} chars → ${data.length} bytes (${result.audio.format})`);
  return { data, filename: "reply.ogg", mimeType: "audio/ogg" };
}

/** Encode 24kHz mono pcm16le to MP3 (pure JS, no native deps). */
function encodeMp3(pcm: Buffer): Buffer {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const encoder = new Mp3Encoder(1, PCM_SAMPLE_RATE, 64);
  const frames: Buffer[] = [];
  const blockSize = 1152;
  for (let i = 0; i < samples.length; i += blockSize) {
    const chunk = samples.subarray(i, i + blockSize);
    const encoded = encoder.encodeBuffer(chunk);
    if (encoded.length > 0) frames.push(Buffer.from(encoded));
  }
  const flushed = encoder.flush();
  if (flushed.length > 0) frames.push(Buffer.from(flushed));
  return Buffer.concat(frames);
}
