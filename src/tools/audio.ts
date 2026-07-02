import { tool, generateText } from "ai";
import { z } from "zod";
import { readFile } from "fs/promises";
import { join, extname } from "path";
import { existsSync, statSync } from "fs";
import { createAudioModel } from "../model.js";
import { loadConfig } from "../config.js";
import type { KernConfig } from "../config.js";

export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/opus",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".flac": "audio/flac", ".mp4": "audio/mp4",
  ".webm": "audio/webm", ".aiff": "audio/aiff",
};

/**
 * Known audio-input-capable models per provider, used as last-resort fallback.
 * The main chat model usually can't hear audio (Claude/GPT-5.x text models
 * reject audio parts), so this fallback matters more than it does for vision.
 * Gemini accepts ogg/opus natively — no transcoding needed for Telegram voice.
 */
export const AUDIO_FALLBACKS: Record<string, string> = {
  openrouter: "google/gemini-3.1-flash-lite",
  openai: "gpt-audio-mini",
};

/** Max audio file size we'll send to a model (base64 inflates ~33%). */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Build the model fallback chain for audio.
 * Order: audioModel (if set) → agent model → hardcoded provider fallback.
 * Deduplicates while preserving order.
 */
export function getAudioModelChain(config: KernConfig): string[] {
  const chain: string[] = [];
  if (config.audioModel) chain.push(config.audioModel);
  chain.push(config.model);
  const fallback = AUDIO_FALLBACKS[config.provider];
  if (fallback) chain.push(fallback);
  return [...new Set(chain)];
}

export const audioTool = tool({
  description:
    "Analyze or transcribe an audio file using the AI model. Can examine any audio file on disk or in .kern/media/ (voice messages, recordings). Returns a transcript by default, or the model's answer to a specific question about the audio.",
  inputSchema: z.object({
    file: z.string().describe("Path to audio file, or filename from .kern/media/"),
    prompt: z
      .string()
      .optional()
      .describe('Question about the audio (default: transcribe it)'),
  }),
  execute: async ({ file, prompt = "Transcribe this audio verbatim. If it is not speech, briefly describe what you hear." }) => {
    try {
      // Resolve file path — check .kern/media/ if not absolute/relative existing
      let filePath = file;
      if (!existsSync(filePath)) {
        const mediaPath = join(process.cwd(), ".kern", "media", file);
        if (existsSync(mediaPath)) {
          filePath = mediaPath;
        } else {
          return `Error: file not found: ${file}`;
        }
      }

      const size = statSync(filePath).size;
      if (size > MAX_AUDIO_BYTES) {
        return `Error: audio file too large (${(size / 1024 / 1024).toFixed(1)} MB > ${MAX_AUDIO_BYTES / 1024 / 1024} MB limit)`;
      }

      const ext = extname(filePath).toLowerCase();
      const mimeType = AUDIO_EXT_TO_MIME[ext];
      if (!mimeType) {
        return `Error: not a recognized audio file (${ext || "no extension"})`;
      }

      const buffer = await readFile(filePath);
      const agentDir = process.cwd();
      const config = await loadConfig(agentDir);
      const chain = getAudioModelChain(config);

      let lastError = "";
      for (const modelId of chain) {
        try {
          const model = createAudioModel(config, modelId);
          const result = await generateText({
            model,
            messages: [
              {
                role: "user",
                content: [
                  { type: "file", data: buffer, mediaType: mimeType },
                  { type: "text", text: prompt },
                ],
              },
            ],
            maxOutputTokens: 4000,
          });
          const text = result.text.trim();
          if (text) return text;
          lastError = `empty response from ${modelId}`;
        } catch (e: any) {
          lastError = `${modelId}: ${e.message}`;
        }
      }
      return `Error: all audio models failed — ${lastError}`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});
