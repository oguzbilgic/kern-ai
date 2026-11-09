import { tool } from "ai";
import { z } from "zod";
import { loadSkillBody, type SkillInfo } from "./scanner.js";
import { isActive, activate, deactivate } from "./state.js";
import { log } from "../../log.js";

/** Reference to current skill catalog — set by plugin on startup/refresh */
let catalog: SkillInfo[] = [];

export function setCatalog(skills: SkillInfo[]) {
  catalog = skills;
}

export const skillTool = tool({
  description:
    "Manage agent skills. When a task matches a skill in the catalog, activate that skill before starting the work. " +
    "Use 'list' to see available skills. " +
    "Use 'activate' to load a skill's full instructions into your system prompt (persistent until deactivated). " +
    "The instructions are also returned in the tool result so you can act on them in the current turn. " +
    "Use 'deactivate' to unload a skill and free token budget.",
  inputSchema: z.object({
    action: z.enum(["list", "activate", "deactivate"]).describe("Action to perform"),
    name: z.string().optional().describe("Skill name (required for activate/deactivate)"),
  }),
  execute: async ({ action, name }) => {
    switch (action) {
      case "list": {
        if (catalog.length === 0) {
          return "No skills found. Create skills in skills/ or install from a registry.";
        }
        const lines = catalog.map((s) => {
          const status = isActive(s.name) ? "✦ active" : "○";
          const src = s.source === "installed" ? " [installed]" : "";
          return `${status} ${s.name}${src} — ${s.description || "(no description)"}`;
        });
        return lines.join("\n");
      }

      case "activate": {
        if (!name) return "Error: name is required for activate";
        const skill = catalog.find((s) => s.name === name);
        if (!skill) return `Error: skill "${name}" not found. Use list to see available skills.`;
        // Load the body before activating the skill.
        // If we can't read the body, return an error and leave the skill inactive
        // rather than marking a skill active whose instructions can't be loaded.
        let body: string;
        try {
          body = await loadSkillBody(skill);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("skills", `failed to load body for "${name}": ${msg}`);
          return `Error: failed to load instructions for skill "${name}": ${msg}. Skill not activated.`;
        }
        const wasNew = activate(name);
        if (!wasNew) return `Skill "${name}" is already active.`;
        // Return the full body so instructions take effect this turn, not next.
        // The system prompt will also include it from the next turn onward.
        return `Activated: ${name}\n\n${body}`;
      }

      case "deactivate": {
        if (!name) return "Error: name is required for deactivate";
        const wasActive = deactivate(name);
        if (!wasActive) return `Skill "${name}" is not active.`;
        return `Deactivated skill "${name}". Instructions removed from system prompt.`;
      }

      default:
        return `Unknown action: ${action}`;
    }
  },
});
