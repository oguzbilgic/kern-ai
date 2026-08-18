import { readdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { log } from "../../log.js";

export type SkillSource = "local" | "installed" | "builtin";

export interface SkillInfo {
  /** Skill name (from frontmatter or folder name) */
  name: string;
  /** Short description from frontmatter */
  description: string;
  /** Absolute path to skill directory */
  path: string;
  /** Logical display path (e.g. skills/<name>/SKILL.md) */
  displayPath: string;
  /** Where it came from */
  source: SkillSource;
}

/** Resolve kern package root (where package.json lives) */
function getPackageRoot(): string {
  // This file is at <pkg>/dist/plugins/skills/scanner.js (built) or src/plugins/skills/scanner.ts
  const thisFile = fileURLToPath(import.meta.url);
  // Walk up to package root: dist/plugins/skills/ → dist/plugins/ → dist/ → pkg root
  return dirname(dirname(dirname(dirname(thisFile))));
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns { meta, body } where meta has name/description extracted from
 * `key: value` lines and block scalars (`>`, `>-`, `|`, `|-`).
 *
 * Block scalars matter: writing a multi-line description is the natural way to
 * document when a skill applies, and without this the catalog would show the
 * literal indicator (`>-`) as the description, leaving the model no basis to
 * pick the skill. Values are trimmed, so chomping indicators are accepted and
 * ignored.
 */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { meta, body: content };

  const lines = match[1].split("\n");
  const body = match[2];

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w_-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const raw = kv[2].trim();
    if (!raw) continue;

    // Block scalar header: `|`, `>`, optional indentation digit and chomping indicator.
    const block = raw.match(/^([|>])(?:\d*[-+]?|[-+]?\d*)$/);
    if (!block) {
      meta[key] = raw.replace(/^["']|["']$/g, "");
      continue;
    }

    // Consume the following more-indented (or blank) lines as the value.
    const collected: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") { collected.push(""); continue; }
      if (!/^\s/.test(line)) break;
      collected.push(line);
    }
    i = j - 1;
    while (collected.length && collected[collected.length - 1] === "") collected.pop();

    const indent = Math.min(
      ...collected.filter(l => l !== "").map(l => l.match(/^\s*/)![0].length),
      Infinity,
    );
    const text = collected.map(l => (l === "" ? "" : l.slice(indent === Infinity ? 0 : indent)));

    // `|` keeps newlines; `>` folds lines with spaces, blank line = paragraph break.
    meta[key] = block[1] === "|"
      ? text.join("\n").trim()
      : text.reduce((acc, line, idx) => {
          if (idx === 0) return line;
          if (line === "") return `${acc}\n`;
          return acc.endsWith("\n") ? acc + line : `${acc} ${line}`;
        }, "").trim();
  }

  return { meta, body };
}

/** Derive display path from source and name */
function getDisplayPath(name: string, source: SkillSource, absolutePath: string): string {
  switch (source) {
    case "local": return `skills/${name}/SKILL.md`;
    case "installed": return `.agents/skills/${name}/SKILL.md`;
    case "builtin": return `${absolutePath}/SKILL.md`;
  }
}

/**
 * Scan a single skills directory for subdirectories containing SKILL.md.
 * Only reads frontmatter for catalog — full body loaded lazily on activation.
 */
async function scanDir(dir: string, source: SkillSource): Promise<SkillInfo[]> {
  if (!existsSync(dir)) return [];

  const skills: SkillInfo[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    try {
      const content = await readFile(skillFile, "utf-8");
      const { meta } = parseFrontmatter(content);
      const name = meta.name || entry.name;

      skills.push({
        name,
        description: meta.description || "",
        path: skillDir,
        displayPath: getDisplayPath(entry.name, source, skillDir),
        source,
      });
    } catch (err: any) {
      log.warn("skills", `failed to read ${skillFile}: ${err.message}`);
    }
  }

  return skills;
}

/**
 * Load full SKILL.md body for a specific skill (below frontmatter).
 */
export async function loadSkillBody(skill: SkillInfo): Promise<string> {
  const skillFile = join(skill.path, "SKILL.md");
  const content = await readFile(skillFile, "utf-8");
  const { body } = parseFrontmatter(content);
  return body.trim() || content.trim();
}

/**
 * Scan all skill directories and return merged catalog.
 * Priority: local (agent) > installed (.agents) > builtin (kern package).
 * Same-name skills in higher priority shadow lower ones.
 */
export async function scanSkills(agentDir: string): Promise<SkillInfo[]> {
  const local = await scanDir(join(agentDir, "skills"), "local");
  const installed = await scanDir(join(agentDir, ".agents", "skills"), "installed");
  const builtin = await scanDir(join(getPackageRoot(), "skills"), "builtin");

  // Merge with dedup — first occurrence wins (highest priority first)
  const seen = new Set<string>();
  const merged: SkillInfo[] = [];
  for (const skill of [...local, ...installed, ...builtin]) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    merged.push(skill);
  }
  return merged;
}
