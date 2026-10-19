import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Skill } from "../plugins/plugin.ts";
import type { Tool } from "./tool.ts";

/** How many bundled files are listed; the rest stay on disk for the model to find. */
const MAX_FILES = 20;

/**
 * Tier 2 of progressive disclosure, and OpenCode's `skill` tool: the system
 * prompt names the skills, and this pulls one body into the conversation at the
 * moment a task matches it. Only registered when skills exist, since the tool
 * description points at a catalog that would otherwise be empty.
 */
export function skillTool(skills: Skill[]): Tool {
  return {
    name: "skill",
    description:
      "Load a skill's instructions, plus a list of the files bundled with it. " +
      "Use when: the task matches one of the skills listed in the system prompt's available_skills - " +
      "pass its name to read the full workflow before doing the work. " +
      "Paths the skill mentions are relative to the base directory it reports.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of a skill from available_skills in the system prompt." },
      },
      required: ["name"],
    },
    execute: async ({ name }) => {
      const wanted = String(name ?? "");
      const skill = skills.find((candidate) => candidate.name === wanted);
      if (!skill) return `Error: no skill "${wanted}". Available: ${skills.map((s) => s.name).join(", ")}`;

      const dir = dirname(skill.location);
      const files = await bundledFiles(dir);
      return [
        `<skill_content name="${skill.name}">`,
        (await body(skill.location)).trim(),
        "",
        `Base directory for this skill: ${dir}`,
        "Relative paths in this skill (e.g. scripts/, references/) are relative to this base directory.",
        "<skill_files>",
        ...files.map((file) => `<file>${join(dir, file)}</file>`),
        "</skill_files>",
        "</skill_content>",
      ].join("\n");
    },
  };
}

/** The body without its frontmatter, which the model already read in the catalog. */
async function body(location: string): Promise<string> {
  const text = await readFile(location, "utf8");
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

/** Whatever sits next to SKILL.md, a bounded alphabetical sample of it. */
async function bundledFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name !== "SKILL.md")
      .map((entry) => relative(dir, join(entry.parentPath ?? dir, entry.name)))
      .sort()
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
}
