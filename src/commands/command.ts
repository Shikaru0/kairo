import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Command {
  name: string;
  description: string;
  prompt: string;
  location?: string;
}

export interface CommandContext {
  input: string;
  args: string[];
  rawArgs: string;
  chat: any;
  save: () => Promise<void>;
  print: (text: string) => void;
  [key: string]: any;
}

export interface TsCommand {
  name: string;
  description?: string;
  run: (ctx: CommandContext) => Promise<void> | void;
}

function commandRoots(): string[] {
  const project = process.cwd();
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(project, ".kairo", "commands"),
    join(project, "commands"),
    join(config, "kairo", "commands"),
    join(home, ".config", "opencode", "commands"),
    join(home, ".claude", "commands"),
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

async function readCommandFile(file: string): Promise<Command | null> {
  try {
    const text = await readFile(file, "utf8");
    const name = basename(file).replace(/\.md$/, "");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    const block = frontmatter?.[1] ?? "";
    const body = frontmatter ? text.slice(frontmatter[0].length).trim() : text.trim();
    return {
      name: field(block, "name") || name,
      description: field(block, "description") || "",
      prompt: body,
      location: file,
    };
  } catch {}
  return null;
}

export async function loadPromptCommands(): Promise<Command[]> {
  const commands = new Map<string, Command>();
  for (const root of commandRoots()) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const file = join(root, entry.name);
        const cmd = await readCommandFile(file);
        if (cmd && cmd.name) {
          commands.set(cmd.name, { ...cmd, location: file });
        }
      }
    } catch {}
  }
  return Array.from(commands.values());
}

export async function loadTsCommands(): Promise<TsCommand[]> {
  const commands = new Map<string, TsCommand>();
  for (const root of commandRoots()) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js") && !entry.name.endsWith(".mjs")) continue;
        if (entry.name.endsWith(".d.ts")) continue;
        const file = join(root, entry.name);
        try {
          const mod = await import(pathToFileURL(file).href + "?t=" + Date.now());
          const cmd = mod.default ?? mod.command ?? mod;
          if (cmd && typeof cmd.run === "function" && cmd.name) {
            commands.set(cmd.name, {
              name: cmd.name,
              description: cmd.description,
              run: cmd.run,
            });
          }
        } catch (e) {
          // skip broken command files
        }
      }
    } catch {}
  }
  return Array.from(commands.values());
}

export function expandCommand(cmd: Command, args: string): string {
  let prompt = cmd.prompt;
  const trimmedArgs = args.trim();
  prompt = prompt.replaceAll("$ARGUMENTS", trimmedArgs);
  const parts = trimmedArgs ? trimmedArgs.split(/\s+/) : [];
  for (let i = 0; i < parts.length; i++) {
    prompt = prompt.replaceAll(`$${i + 1}`, parts[i] ?? "");
  }
  return prompt;
}
