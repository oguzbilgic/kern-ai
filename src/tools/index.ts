import { bashTool } from "./bash.js";
import { pwshTool } from "./pwsh.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webfetchTool } from "./webfetch.js";
import { websearchTool } from "./websearch.js";
import { pdfTool } from "./pdf.js";
import { imageTool } from "./image.js";
import { audioTool } from "./audio.js";
import { kernTool } from "./kern.js";
import { messageTool } from "./message.js";

const isWindows = process.platform === "win32";

export const allTools = {
  // Platform-specific shell tool — one per platform
  ...(isWindows ? { pwsh: pwshTool } : { bash: bashTool }),
  read: readTool,
  write: writeTool,
  edit: editTool,
  glob: globTool,
  grep: grepTool,
  webfetch: webfetchTool,
  websearch: websearchTool,
  pdf: pdfTool,
  image: imageTool,
  audio: audioTool,
  kern: kernTool,
  message: messageTool,
};

export type ToolName = keyof typeof allTools;
