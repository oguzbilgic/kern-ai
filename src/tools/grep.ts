import { tool } from "ai";
import { z } from "zod";
import { shellExec } from "./shell.js";

export const grepTool = tool({
  description:
    "Search file contents using a regex pattern. Returns file paths and matching lines.",
  inputSchema: z.object({
    pattern: z.string().describe("The regex pattern to search for"),
    path: z
      .string()
      .optional()
      .describe("Directory to search in (default: working directory)"),
    include: z
      .string()
      .optional()
      .describe('File pattern to include (e.g. "*.ts", "*.md")'),
    options: z
      .string()
      .optional()
      .describe('Additional grep flags (e.g. "-C 3 -i -l")'),
  }),
  execute: async ({ pattern, path, include, options }) => {
    if (process.platform === "win32") {
      return "grep tool requires Unix (uses /bin/sh). Use pwsh with Select-String instead.";
    }

    const target = path || process.cwd();
    const escapedPattern = pattern.replace(/'/g, "'\\''");
    const extra = options || "";

    // Detect if target is a file (has extension) vs directory
    const isFile = /\.[a-zA-Z0-9]+$/.test(target);
    const recursive = isFile ? "" : "-r";
    const includeArg = !isFile && include ? `--include='${include}'` : "";
    const excludeDirs = isFile ? "" : "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist";
    const cmd = `grep ${recursive} -n --color=always ${excludeDirs} ${includeArg} ${extra} '${escapedPattern}' '${target}' 2>/dev/null`;

    const result = await shellExec(cmd);
    const stdout = result.stdout.trim();

    if (stdout) {
      const lines = stdout.split("\n");
      return lines.length > 100
        ? lines.slice(0, 100).join("\n") +
            `\n... (${lines.length - 100} more matches)`
        : lines.join("\n");
    } else {
      return "No matches found.";
    }
  },
});
