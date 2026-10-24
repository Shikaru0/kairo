import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface SubagentDef {
  name: string;
  description: string;
  system?: string;
  model?: string;
  temperature?: number;
  thinking?: boolean | "low" | "medium" | "high";
  tools?: string[]; // tool names to allow (empty = all)
  color?: string;
  location?: string;
}

const BUILTIN: SubagentDef[] = [
  {
    name: "general-purpose",
    description: "General-purpose agent for researching complex questions and executing multi-step tasks. Use this when you need to search, read, edit, and run commands.",
    system:
      "You are a general-purpose subagent with exactly one task. Nothing can answer a question back: make reasonable assumptions and state them instead of asking. " +
      "Search code with grep and glob, read files with read, and keep bash for commands, builds and tests rather than for making changes. " +
      "Before editing a file, read it first and copy oldString exactly from that read; never edit from memory. " +
      "Never rewrite or weaken a test to make it pass; if a test looks wrong, say so and leave it alone. " +
      "Run a check on any change before you call it done, and never create files nobody asked for. " +
      "Work the task with the tools, then answer with only what the caller needs: exact paths, values and conclusions, no preamble.",
  },
  {
    name: "explore",
    description: "Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase.",
    system:
      "You are an exploration subagent. Your job is to search and understand, not to edit files. " +
      "Use glob, grep, read, and web tools to gather information. " +
      "Be thorough but concise. Answer with a clear summary of findings, relevant file paths, and key code snippets. " +
      "Do not make changes to files. Focus on answering questions about the codebase structure and behavior.",
    tools: ["glob", "grep", "read", "websearch", "webfetch"],
  },
  {
    name: "plan",
    description: "Planning agent that researches the codebase and creates a detailed implementation plan without making changes.",
    system:
      "You are a planning subagent. Research thoroughly using glob, grep, and read. " +
      "Create a detailed, step-by-step implementation plan with specific files to modify, functions to change, and tests to run. " +
      "Consider edge cases and dependencies. Do not edit files or run commands that modify state. " +
      "Return a clear plan the main agent can follow.",
    tools: ["glob", "grep", "read", "websearch", "webfetch"],
  },
];

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kairo");
}

function agentRoots(): string[] {
  const project = process.cwd();
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(project, ".kairo", "agents"),
    join(project, "agents"),
    join(config, "kairo", "agents"),
    join(home, ".config", "opencode", "agents"),
    join(home, ".claude", "agents"),
  ];
}

function field(block: string, key: string): string {
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at < 0) return "";
  const inline = (lines[at] ?? "").slice(key.length + 1).trim();
  const folded = /^([>|])[-+]?$/.exec(inline);
  if (!folded) return inline.replace(/^["']|["']$/g, "");
  const continued: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    continued.push(line.trim());
  }
  return continued.join(folded[1] === ">" ? " " : "\n").trim();
}

async function readAgentFile(file: string): Promise<SubagentDef | null> {
  try {
    const text = await readFile(file, "utf8");
    const name = basename(file).replace(/\.(json|md)$/, "");
    
    if (file.endsWith(".json")) {
      const raw = JSON.parse(text);
      return {
        name: raw.name || name,
        description: raw.description || "",
        system: raw.system || raw.prompt || raw.instructions,
        model: raw.model,
        temperature: raw.temperature,
        thinking: raw.thinking,
        tools: raw.tools,
        color: raw.color,
        location: file,
      };
    }
    
    if (file.endsWith(".md")) {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      const block = frontmatter?.[1] ?? "";
      const body = frontmatter ? text.slice(frontmatter[0].length).trim() : text.trim();
      return {
        name: field(block, "name") || name,
        description: field(block, "description") || "",
        system: field(block, "system") || field(block, "prompt") || body,
        model: field(block, "model") || undefined,
        temperature: field(block, "temperature") ? Number(field(block, "temperature")) : undefined,
        thinking: field(block, "thinking") as any,
        tools: field(block, "tools") ? field(block, "tools").split(",").map(s => s.trim()).filter(Boolean) : undefined,
        color: field(block, "color") || undefined,
        location: file,
      };
    }
  } catch {}
  return null;
}

export async function loadSubagents(): Promise<SubagentDef[]> {
  const agents = new Map<string, SubagentDef>();
  // Built-ins first
  for (const agent of BUILTIN) {
    agents.set(agent.name, agent);
  }
  // Load from roots (project overrides user)
  for (const root of agentRoots()) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".json") && !entry.name.endsWith(".md")) continue;
        const file = join(root, entry.name);
        const agent = await readAgentFile(file);
        if (agent && agent.name) {
          agents.set(agent.name, { ...agent, location: file });
        }
      }
    } catch {}
  }
  return Array.from(agents.values());
}

export function getSubagent(agents: SubagentDef[], name: string): SubagentDef | undefined {
  return agents.find(a => a.name === name);
}
