import type { KernPlugin, PluginContext, RouteHandler, BeforeContextInfo, ContextInjection } from "../types.js";
import { scanSkills, loadSkillBody, type SkillInfo } from "./scanner.js";
import { isActive, getActiveSkills } from "./state.js";
import { skillTool, setCatalog } from "./tool.js";
import { log } from "../../log.js";

/** Cached skill catalog */
let catalog: SkillInfo[] = [];

/**
 * Skills plugin — progressive disclosure skill system.
 *
 * Scans skills/ (agent-created) and .agents/skills/ (installed) directories.
 * Injects compact catalog into system prompt. Full skill content injected
 * only when agent explicitly activates a skill.
 */
export const skillsPlugin: KernPlugin = {
  name: "skills",

  tools: {
    skill: skillTool,
  },

  routes: [
    {
      method: "GET",
      path: "/skills",
      handler: (_req, res) => {
        const active = getActiveSkills();
        const result = catalog.map((s) => ({
          name: s.name,
          description: s.description,
          path: s.displayPath,
          source: s.source,
          active: active.has(s.name),
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      },
    },
    {
      method: "GET",
      path: /^\/skills\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const name = match?.[1];
        const skill = catalog.find((s) => s.name === name);
        if (!skill) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Skill not found" }));
          return;
        }
        try {
          const active = getActiveSkills();
          const body = await loadSkillBody(skill);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            name: skill.name,
            description: skill.description,
            path: skill.displayPath,
            source: skill.source,
            active: active.has(skill.name),
            body,
          }));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to load skill body" }));
        }
      },
    },
  ] as RouteHandler[],

  async onStartup(ctx) {
    // Scan skill directories
    catalog = await scanSkills(ctx.agentDir);
    setCatalog(catalog);

    if (catalog.length > 0) {
      const active = getActiveSkills();
      log("skills", `found ${catalog.length} skill(s), ${active.size} active`);
    }
  },

  async onBeforeContext(_info: BeforeContextInfo, ctx: PluginContext): Promise<ContextInjection[]> {
    // Rescan every turn — agent may have created/deleted skills mid-session
    catalog = await scanSkills(ctx.agentDir);
    setCatalog(catalog);

    if (catalog.length === 0) return [];

    const injections: ContextInjection[] = [];

    // Compact catalog with logical paths and active state
    const catalogLines = catalog.map((s) => {
      const state = isActive(s.name) ? "active" : "available";
      return `${state === "active" ? "✦" : "○"} ${s.name} (${state}): ${s.description || "(no description)"}\n  ${s.displayPath}`;
    });
    injections.push({
      label: "skills",
      content: catalogLines.join("\n"),
      placement: "system",
    });

    // Active skills: load body lazily and inject as <document> blocks
    for (const skill of catalog) {
      if (!isActive(skill.name)) continue;
      try {
        const body = await loadSkillBody(skill);
        injections.push({
          label: "",
          content: `<document path="${skill.displayPath}">\n${body}\n</document>`,
          placement: "system",
        });
      } catch (err: any) {
        log.warn("skills", `failed to load active skill ${skill.name}: ${err.message}`);
      }
    }

    return injections;
  },

  commands: {
    "/skills": {
      description: "list available skills",
      handler: async () => {
        if (catalog.length === 0) {
          return "```yaml\nskills: {}\n```";
        }
        const active = getActiveSkills();
        const lines = ["```yaml", "skills:"];
        for (const s of catalog) {
          const status = active.has(s.name) ? "active" : "available";
          lines.push(`  ${s.name}:`);
          lines.push(`    status: ${status}`);
          lines.push(`    source: ${s.source}`);
          if (s.description) {
            lines.push(`    desc: ${s.description}`);
          }
        }
        lines.push("```");
        return lines.join("\n");
      },
    },
  },

  onStatus(_ctx) {
    return {
      skills: `${getActiveSkills().size} active / ${catalog.length} total`,
    };
  },
};
