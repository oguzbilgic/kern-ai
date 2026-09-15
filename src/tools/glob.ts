import { tool } from "ai";
import { z } from "zod";
import { glob as fsGlob, stat } from "node:fs/promises";
import path from "node:path";

export const globTool = tool({
  description:
    'Find files matching a glob pattern. Returns matching file paths. Example patterns: "**/*.ts", "src/**/*.md".',
  inputSchema: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe("Directory to search in (default: working directory)"),
  }),
  execute: async ({ pattern, path: targetPath }) => {
    try {
      const cwd = targetPath || process.cwd();
      const matches: string[] = [];
      for await (const entry of fsGlob(pattern, { cwd })) {
        const fullPath = path.resolve(cwd, entry);
        try {
          const s = await stat(fullPath);
          if (!s.isDirectory()) {
            matches.push(fullPath);
          }
        } catch {
          // If stat fails (e.g. broken symlink), still report the match
          matches.push(fullPath);
        }
      }
      if (matches.length === 0) return "No files matched the pattern.";
      return matches.join("\n");
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});

