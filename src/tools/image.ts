import { tool, generateText } from "ai";
import { z } from "zod";
import { readFile } from "fs/promises";
import { join, extname } from "path";
import { existsSync } from "fs";
import { createModel } from "../model.js";
import { loadConfig } from "../config.js";

const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".tiff": "image/tiff",
  ".tif": "image/tiff", ".avif": "image/avif", ".heic": "image/heic",
};

export const imageTool = tool({
  description:
    "Analyze an image file using the AI model. Can examine any image on disk or in .kern/media/. Returns the model's analysis.",
  inputSchema: z.object({
    file: z.string().describe("Path to image file, or filename from .kern/media/"),
    prompt: z
      .string()
      .optional()
      .describe('What to analyze (default: "Describe this image.")'),
  }),
  execute: async ({ file, prompt = "Describe this image." }) => {
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

      const buffer = await readFile(filePath);
      const ext = extname(filePath).toLowerCase();
      const mimeType = EXT_TO_MIME[ext] || "image/png";

      if (!mimeType.startsWith("image/")) {
        return `Error: not an image file (${mimeType})`;
      }

      const agentDir = process.cwd();
      const config = await loadConfig(agentDir);
      const model = createModel(config, config.mediaModel || config.model);

      const result = await generateText({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", image: buffer, mediaType: mimeType },
              { type: "text", text: prompt },
            ],
          },
        ],
        maxOutputTokens: 2000,
      });

      return result.text.trim();
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});
