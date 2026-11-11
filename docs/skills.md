# Skills

Skills are reusable instruction packages that extend an agent's capabilities. Each skill is a folder containing a `SKILL.md` file with frontmatter metadata and markdown instructions.

## Directories

Skills are loaded from three directories, in priority order:

| Directory | Purpose | Version controlled |
|---|---|---|
| `skills/` | Agent-created skills | Yes |
| `.agents/skills/` | Installed from registries | No |
| *(bundled)* | Ships with kern package | No |

If a local skill has the same name as a bundled or installed skill, the local one takes priority.

## SKILL.md format

```markdown
---
name: deploy-lxc
description: Create and configure Debian 12 LXC containers on Proxmox
---

# Deploy LXC

Step-by-step instructions, commands, checklists, etc.
```

The frontmatter `name` and `description` are optional — if omitted, the folder name is used and description is empty.

## How it works

### Catalog injection

A compact catalog of all available skills is always present in the agent's system prompt, under a short instruction to activate a matching skill before starting a task:

```
<skills>
Each skill holds tested instructions for one kind of task. Before you start a task, check this list. ...

○ deploy-lxc (available): Create and configure Debian 12 LXC containers on Proxmox
  skills/deploy-lxc/SKILL.md
○ backup-db (available): Backup PostgreSQL databases to S3
  .agents/skills/backup-db/SKILL.md
</skills>
```

This costs ~50-100 tokens per skill and lets the agent know what's available without loading full instructions.

### Activation

When the agent activates a skill, the full `SKILL.md` body is injected into the system prompt. This persists across turns until explicitly deactivated. Active skills are never subject to conversation trimming.

Skills are in-memory only — they reset on agent restart.

### Rescanning

Skill directories are rescanned every turn. If the agent creates a new `skills/foo/SKILL.md` mid-session, it appears in the catalog immediately on the next turn.

## Skill tool

The `skill` tool has three actions:

| Action | Description |
|---|---|
| `list` | Show all skills with active/inactive status |
| `activate` | Load a skill's full instructions into system prompt |
| `deactivate` | Unload a skill to free token budget |

## Slash command

`/skills` lists all available skills with active/inactive status icons. This command is registered by the skills plugin and appears in web UI autocomplete automatically.

## API

| Endpoint | Description |
|---|---|
| `GET /skills` | List all skills with name, description, source, active status |
| `GET /skills/:name` | Skill detail including full body |

## Creating a skill

1. Create a folder in `skills/`:
   ```
   skills/my-skill/SKILL.md
   ```

2. Add frontmatter and instructions:
   ```markdown
   ---
   name: my-skill
   description: What this skill does
   ---

   # My Skill

   Instructions the agent follows when this skill is active.
   ```

3. The skill appears in the catalog on the next turn — no restart needed.

## Bundled skills

kern ships with built-in skills that appear automatically in every agent's catalog. Currently bundled:

- **create-skill** — helps agents write new skills following the AgentSkills format

Bundled skills live inside the kern npm package and cannot be edited. To override a bundled skill, create a local skill with the same name in `skills/`.

## Installing skills

Skills from external registries are installed into `.agents/skills/`. This directory follows the [AgentSkills](https://agentskills.io/) universal spec, part of the [skills.sh](https://skills.sh) ecosystem.

Use `npx skills` with `-a universal` or `npx clawhub` with `--dir .agents/skills` to search, install, and manage community skills. Prefer official or widely-used skills over obscure ones.
