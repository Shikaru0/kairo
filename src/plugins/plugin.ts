import { readdir, readFile, realpath, stat, mkdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Tool } from "../tools/tool.ts";
import { connect, type McpSession, type McpTool, type ServerConfig } from "./mcp.ts";

/**
 * Agent Plugins loader (https://agent-plugins.org). A plugin is a directory
 * with a `plugin.json`, plus optional `skills/<name>/SKILL.md` and `mcp.json`.
 *
 * Nothing here may fail the client: the specification asks each bad piece to be
 * reported and skipped instead, so a broken plugin costs its own components and
 * not the session. Everything said about a load ends up in `notes`.
 */

/** The one Agent Plugins version this client implements; other versions are rejected. */
const SPEC = "1.0.0";
const PLUGIN_SCHEMA = `https://agent-plugins.org/schemas/${SPEC}/plugin.schema.json`;
const MCP_SCHEMA = `https://agent-plugins.org/schemas/${SPEC}/mcp.schema.json`;

/** The closed set of portable manifest fields. */
const MANIFEST_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];
/** Metadata fields validated by JSON type alone, never by content. */
const MANIFEST_TYPED: Array<[string, string]> = [
  ["version", "string"],
  ["description", "string"],
  ["homepage", "string"],
  ["repository", "string"],
  ["license", "string"],
];
/** Plugin names: lowercase, alphanumeric at both ends, no `--` and no `..`. */
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** A skill the model may read on demand. */
export interface Skill {
  name: string;
  description: string;
  /** Absolute path of the SKILL.md, both to read it and to resolve its relative paths. */
  location: string;
}

/** A note an MCP server asked the client to pass on to the model. */
export interface Instruction {
  server: string;
  text: string;
}

/** Standing instructions for every session, whether a plugin or a plain `AGENTS.md` shipped them. */
export interface Prompt {
  /** Where they came from: a plugin name, or the path of an `AGENTS.md`. */
  source: string;
  text: string;
}

/** What the plugins contribute to a session. */
export interface Plugins {
  tools: Tool[];
  skills: Skill[];
  prompts: Prompt[];
  instructions: Instruction[];
  /** Everything worth telling the user: rejections, skips, failed connections. */
  notes: string[];
}

/** A plugin's standing instructions are re-sent every round, so they have a ceiling. */
const MAX_PROMPT = 32_768;

/** The user-level config directory, `$XDG_CONFIG_HOME/kairo` when set. */
function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kairo");
}

/** Where plugin packages are looked for; earlier entries shadow later ones by name. */
function searchPaths(): string[] {
  return [
    join(process.cwd(), ".kairo", "plugins"),
    join(configDir(), "plugins"),
    ...(process.env.KAIRO_PLUGINS ?? "")
      .split(":")
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => resolve(path)),
  ];
}

/** Persistent per-plugin state, handed to stdio servers as `PLUGIN_DATA`. */
function dataDir(name: string): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "kairo", "plugins", name);
}

/** Load every plugin package found, project ones first. Read-only apart from `PLUGIN_DATA`. */
export async function loadPlugins(): Promise<Plugins> {
  const tools: Tool[] = [];
  const skills: Skill[] = [];
  const prompts: Prompt[] = [];
  const instructions: Instruction[] = [];
  const notes: string[] = [];
  const plugins = new Set<string>();
  const skillNames = new Set<string>();
  const toolNames = new Set<string>();

  // Plain AGENTS.md first: the user's rules, then the project's, then each plugin's.
  prompts.push(...(await configPrompts(notes)));

  for (const search of searchPaths()) {
    for (const root of await pluginDirs(search, notes)) {
      const plugin = await loadPlugin(root, notes);
      if (!plugin) continue;
      if (plugins.has(plugin.name)) {
        notes.push(`${root}: plugin "${plugin.name}" is shadowed by an earlier one of the same name`);
        continue;
      }
      plugins.add(plugin.name);
      for (const skill of plugin.skills) collectSkill(skill, skills, skillNames, notes);
      for (const tool of plugin.tools) collectTool(tool, root, tools, toolNames, notes);
      if (plugin.prompt) prompts.push({ source: plugin.name, text: plugin.prompt });
      instructions.push(...plugin.instructions);
    }
  }

  // Skills also live loose in the directories OpenCode and Claude Code already
  // read, so one installed for either of them is usable here without a package.
  for (const skill of await looseSkills(notes)) collectSkill(skill, skills, skillNames, notes);

  return { tools, skills, prompts, instructions, notes };
}

/** First of a name wins: a shadowed duplicate is reported, since silence looks like a bug. */
function collectSkill(skill: Skill, into: Skill[], seen: Set<string>, notes: string[]) {
  if (seen.has(skill.name)) {
    notes.push(`skill "${skill.name}" at ${skill.location} is shadowed by an earlier one of the same name`);
    return;
  }
  seen.add(skill.name);
  into.push(skill);
}

function collectTool(tool: Tool, where: string, into: Tool[], seen: Set<string>, notes: string[]) {
  if (seen.has(tool.name)) {
    notes.push(`${where}: tool "${tool.name}" is shadowed by an earlier one of the same name`);
    return;
  }
  seen.add(tool.name);
  into.push(tool);
}

/**
 * Tier 1 of progressive disclosure: the model is told which skills exist and
 * what they are for, and reads a body only when a task calls for it. Empty when
 * there are none — `skill` is not even registered then. The catalog lives in the
 * system prompt, which is rebuilt every round, so the names and locations
 * survive compaction even after an old skill body is trimmed. The verbose XML is
 * OpenCode's, and models read it more reliably than a terse list.
 */
export function skillCatalog(skills: Skill[]): string {
  if (!skills.length) return "";
  const entries = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.location)}</location>`,
      "  </skill>",
    ]);
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
}

/** Server-level guidance from the handshake, in the block OpenCode uses for it. */
export function mcpInstructions(instructions: Instruction[]): string {
  if (!instructions.length) return "";
  return [
    "<mcp_instructions>",
    ...instructions.flatMap((item) => [
      `  <server name="${escapeXml(item.server)}">`,
      ...item.text.split("\n").map((line) => `    ${line}`),
      "  </server>",
    ]),
    "</mcp_instructions>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Immediate child directories of a search path. A missing one is simply no plugins. */
async function pluginDirs(search: string, notes: string[]): Promise<string[]> {
  if ((await exists(search)) && !(await isDir(search))) {
    notes.push(`${search}: not a directory, skipping`);
    return [];
  }
  try {
    const entries = await readdir(search, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(search, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** One package: manifest first, then each component type it actually carries. */
async function loadPlugin(
  root: string,
  notes: string[],
): Promise<
  { name: string; skills: Skill[]; tools: Tool[]; prompt?: string; instructions: Instruction[] } | undefined
> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return undefined;
  }

  const manifestPath = join(realRoot, "plugin.json");
  if (!(await contained(realRoot, manifestPath))) {
    notes.push(`${root}: plugin.json is missing or resolves outside the plugin, rejected`);
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    notes.push(`${root}: plugin.json is unreadable (${message(error)}), rejected`);
    return undefined;
  }
  const name = validateManifest(raw, root, notes);
  if (!name) return undefined;

  const servers = await loadServers(realRoot, name, notes);
  return {
    name,
    skills: await loadSkills(realRoot, name, notes),
    tools: servers.tools,
    prompt: await promptFor(realRoot, name, notes),
    instructions: servers.instructions,
  };
}

/**
 * The plugin's own `AGENTS.md`: instructions it wants in the system prompt of
 * every session, the same file Claude Code, Codex and OpenCode read as project
 * instructions — and what ponytail ships for clients whose plugin API is data
 * only. Optional and independent of the other components.
 */
async function promptFor(root: string, plugin: string, notes: string[]): Promise<string | undefined> {
  const file = join(root, "AGENTS.md");
  if (!(await exists(file))) return undefined;
  if (!(await contained(root, file))) {
    notes.push(`${plugin}: AGENTS.md resolves outside the plugin, ignored`);
    return undefined;
  }
  return promptText(file, `${plugin}: AGENTS.md`, notes);
}

/**
 * The `AGENTS.md` files Kairo reads for itself, no plugin involved: the user's
 * standing rules and the project's, the convention Claude Code, Codex and
 * OpenCode share. Project second, so its rules come after the general ones.
 * Only the working directory is scanned, not every ancestor of it.
 */
async function configPrompts(notes: string[]): Promise<Prompt[]> {
  const files: Array<[string, string]> = [
    [join(configDir(), "AGENTS.md"), "~/.config/kairo/AGENTS.md"],
    [join(process.cwd(), "AGENTS.md"), "./AGENTS.md"],
  ];
  const prompts: Prompt[] = [];
  for (const [file, source] of files) {
    const text = await promptText(file, source, notes);
    if (text) prompts.push({ source, text });
  }
  return prompts;
}

/** The text of a standing-instructions file, or nothing if it is absent or unusable. */
async function promptText(file: string, label: string, notes: string[]): Promise<string | undefined> {
  if (!(await exists(file))) return undefined;
  if (!(await isFile(file))) {
    notes.push(`${label} is not a file, ignored`);
    return undefined;
  }
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    notes.push(`${label} is unreadable (${message(error)}), ignored`);
    return undefined;
  }
  if (text.length > MAX_PROMPT) {
    notes.push(`${label} is ${text.length} chars, past the ${MAX_PROMPT} prompt limit, ignored`);
    return undefined;
  }
  return text.trim() || undefined;
}

/** The manifest's `name`, or nothing if the manifest is fatally wrong. */
function validateManifest(raw: unknown, where: string, notes: string[]): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    notes.push(`${where}: plugin.json is not an object, rejected`);
    return undefined;
  }
  const manifest = raw as Record<string, unknown>;
  // An unknown field is non-fatal: report it and carry on.
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.includes(field)) notes.push(`${where}: ignoring unknown manifest field "${field}"`);
  }
  if (manifest.$schema !== PLUGIN_SCHEMA) {
    notes.push(`${where}: unsupported plugin.json $schema ${JSON.stringify(manifest.$schema)}, rejected`);
    return undefined;
  }
  const { name } = manifest;
  if (typeof name !== "string" || !PLUGIN_NAME.test(name)) {
    notes.push(`${where}: invalid plugin name ${JSON.stringify(name)}, rejected`);
    return undefined;
  }
  const wrongType = MANIFEST_TYPED.find(([field, kind]) => manifest[field] !== undefined && typeof manifest[field] !== kind);
  if (wrongType) {
    notes.push(`${where}: "${wrongType[0]}" must be a ${wrongType[1]}, rejected`);
    return undefined;
  }
  if (manifest.keywords !== undefined && !isStringArray(manifest.keywords)) {
    notes.push(`${where}: "keywords" must be an array of strings, rejected`);
    return undefined;
  }
  if (manifest.author !== undefined && !isAuthor(manifest.author)) {
    notes.push(`${where}: "author" must be an object of name/email/url strings, rejected`);
    return undefined;
  }
  // A non-object `extensions` is the other non-fatal violation.
  if (manifest.extensions !== undefined && (!manifest.extensions || typeof manifest.extensions !== "object" || Array.isArray(manifest.extensions))) {
    notes.push(`${where}: ignoring non-object "extensions"`);
  }
  return name;
}

/** `skills/` holds one directory per skill; a non-conforming one is skipped, not fatal. */
async function loadSkills(root: string, plugin: string, notes: string[]): Promise<Skill[]> {
  const dir = join(root, "skills");
  // Present but not a directory is a wrong-kind location: that component type is invalid.
  if ((await exists(dir)) && !(await isDir(dir))) {
    notes.push(`${plugin}: skills is not a directory, no skills loaded`);
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "SKILL.md");
    if (!(await isFile(file))) continue;
    const real = await contained(root, file);
    if (!real) {
      notes.push(`${plugin}: skills/${entry.name}/SKILL.md resolves outside the plugin, skipped`);
      continue;
    }
    const skill = await readSkill(real);
    if ("error" in skill) {
      notes.push(`${plugin}: skills/${entry.name} skipped (${skill.error})`);
      continue;
    }
    skills.push({ ...skill, location: real });
  }
  return skills;
}

/**
 * Where loose skills live: OpenCode's conventions, which Claude Code and the
 * Agent Skills guide share, plus Kairo's own config dirs. Project beats user.
 */
function skillRoots(): string[] {
  const project = process.cwd();
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [
    join(project, ".kairo", "skill"),
    join(project, ".kairo", "skills"),
    join(project, ".agents", "skills"),
    join(project, ".claude", "skills"),
    join(config, "kairo", "skill"),
    join(config, "kairo", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
  ];
}

/** `**\/SKILL.md` under every root, a few levels deep at most, as the guide suggests. */
async function looseSkills(notes: string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const root of skillRoots()) {
    if (!(await isDir(root))) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      notes.push(`${root}: skills could not be listed (${message(error)})`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== "SKILL.md") continue;
      const file = join(entry.parentPath ?? root, entry.name);
      if (file.slice(root.length).split(sep).length > 4) continue;
      const skill = await readSkill(file);
      if ("error" in skill) {
        notes.push(`${file} skipped (${skill.error})`);
        continue;
      }
      skills.push({ ...skill, location: file });
    }
  }
  return skills;
}

/**
 * `SKILL.md` is YAML frontmatter plus a body, but only `name` and `description`
 * matter here and each is one line, so a value holding a colon — the usual
 * cross-client breakage — still parses without a YAML dependency. A skill with
 * no description cannot be disclosed, so it is skipped instead of listed.
 */
async function readSkill(file: string): Promise<{ name: string; description: string } | { error: string }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { error: message(error) };
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) return { error: "no YAML frontmatter" };
  const block = frontmatter[1] ?? "";
  const description = field(block, "description");
  if (!description) return { error: "the description field is missing or empty" };
  // A missing or non-conforming name is only a warning: the directory names the skill.
  return { name: field(block, "name") || basename(dirname(file)), description };
}

/**
 * One frontmatter field: either an inline value or a `>`/`|` block scalar whose
 * value is the indented lines below. Skills written for other clients use the
 * folded form, and reading it as the literal ">" is how a catalog ends up
 * describing every skill as ">".
 */
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

/** `mcp.json` servers, connected and turned into tools. One bad entry never disables its siblings. */
async function loadServers(
  root: string,
  plugin: string,
  notes: string[],
): Promise<{ tools: Tool[]; instructions: Instruction[] }> {
  const nothing = { tools: [] as Tool[], instructions: [] as Instruction[] };
  const file = join(root, "mcp.json");
  if (!(await exists(file))) return nothing;
  if (!(await isFile(file))) {
    notes.push(`${plugin}: mcp.json is not a regular file, MCP disabled`);
    return nothing;
  }
  if (!(await contained(root, file))) {
    notes.push(`${plugin}: mcp.json resolves outside the plugin, MCP disabled`);
    return nothing;
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    notes.push(`${plugin}: mcp.json is invalid JSON (${message(error)}), MCP disabled`);
    return nothing;
  }
  const unknown = Object.keys(config ?? {}).find((field) => field !== "$schema" && field !== "mcpServers");
  const servers = config?.mcpServers;
  if (config?.$schema !== MCP_SCHEMA || !servers || typeof servers !== "object" || Array.isArray(servers) || unknown) {
    notes.push(`${plugin}: mcp.json does not match ${MCP_SCHEMA}, MCP disabled`);
    return nothing;
  }

  const data = dataDir(plugin);
  // Servers are independent, so they are connected together: N slow servers cost one wait, not N.
  const connected = await Promise.all(
    Object.entries(servers as Record<string, unknown>).map(async ([key, entry]) => {
      const server = await validateServer(entry, root, data);
      if ("error" in server) {
        notes.push(`${plugin}: mcp server "${key}" skipped (${server.error})`);
        return nothing;
      }
      try {
        return await toolsFrom(plugin, key, await connect(server), notes);
      } catch (error) {
        notes.push(`${plugin}: mcp server "${key}" failed to start (${message(error)})`);
        return nothing;
      }
    }),
  );
  return {
    tools: connected.flatMap((part) => part.tools),
    instructions: connected.flatMap((part) => part.instructions),
  };
}

/** One server's tools, named the way OpenCode names them: the server is the namespace. */
async function toolsFrom(
  plugin: string,
  key: string,
  session: McpSession,
  notes: string[],
): Promise<{ tools: Tool[]; instructions: Instruction[] }> {
  let offered: McpTool[];
  try {
    offered = await session.listTools();
  } catch (error) {
    notes.push(`${plugin}: mcp server "${key}" did not list its tools (${message(error)})`);
    session.stop();
    return { tools: [], instructions: [] };
  }

  return {
    tools: offered.map((tool) => ({
      name: `${slug(key)}_${slug(tool.name)}`,
      description: `${tool.description ?? `MCP tool "${tool.name}".`}\nFrom the "${plugin}" plugin's MCP server "${key}".`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      execute: (args) => session.call(tool.name, args),
    })),
    instructions: session.instructions ? [{ server: key, text: session.instructions }] : [],
  };
}

/** A server entry as the first stage of validation: shape, then the fields its transport allows. */
async function validateServer(entry: unknown, root: string, data: string): Promise<ServerConfig | { error: string }> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: "not an object" };
  const config = entry as Record<string, unknown>;
  if (config.type === "stdio") return stdioServer(config, root, data);
  if (config.type === "streamable-http") return httpServer(config);
  // The spec makes legacy HTTP+SSE optional, and this client does not implement it.
  if (config.type === "sse") return { error: "the legacy sse transport is unsupported" };
  return { error: `unknown transport ${JSON.stringify(config.type)}` };
}

async function stdioServer(config: Record<string, unknown>, root: string, data: string): Promise<ServerConfig | { error: string }> {
  const unknown = unknownField(config, ["type", "command", "args", "env", "cwd"]);
  if (unknown) return { error: `unknown field "${unknown}"` };

  const { command } = config;
  // One executable token: a shell string would hide arguments and quoting from the spec's rules.
  if (typeof command !== "string" || !command || /\s/.test(command)) return { error: "command must be one executable token" };
  let executable = command;
  if (command.startsWith("./")) {
    const path = resolve(root, command);
    if (!(await exists(path))) return { error: `command "${command}" does not exist in the plugin` };
    const real = await contained(root, path);
    if (!real) return { error: `command "${command}" resolves outside the plugin` };
    executable = real;
  } else if (command.includes("/")) {
    return { error: `command "${command}" must be a bare name or start with ./` };
  }

  const args = config.args ?? [];
  if (!isStringArray(args)) return { error: "args must be an array of strings" };

  const env = config.env ?? {};
  if (!env || typeof env !== "object" || Array.isArray(env)) return { error: "env must be an object of strings" };
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    // The two reserved names are the client's to set; a plugin setting them is invalid.
    if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA") return { error: `env must not set ${key}` };
    if (typeof value !== "string") return { error: `env value for "${key}" must be a string` };
    variables[key] = expand(value, root, data);
  }

  // The data directory exists before launch, whatever the server ends up using it for.
  await mkdir(data, { recursive: true });
  // A missing cwd means the plugin root, which is where a bundled server expects to run.
  const cwd = config.cwd === undefined ? root : expand(String(config.cwd), root, data);
  if (config.cwd !== undefined && !(await contained(root, cwd)) && !(await contained(data, cwd))) {
    return { error: `cwd ${JSON.stringify(config.cwd)} does not resolve inside the plugin or its data directory` };
  }

  return {
    type: "stdio",
    command: executable,
    args: args.map((arg) => expand(arg, root, data)),
    // Configured values overlay the ambient environment; the reserved two are set last.
    env: { ...process.env, ...variables, PLUGIN_ROOT: root, PLUGIN_DATA: data } as Record<string, string>,
    cwd,
  };
}

function httpServer(config: Record<string, unknown>): ServerConfig | { error: string } {
  const unknown = unknownField(config, ["type", "url", "headers"]);
  if (unknown) return { error: `unknown field "${unknown}"` };

  let url: URL;
  try {
    url = new URL(String(config.url));
  } catch {
    return { error: "url must be an absolute HTTP(S) URL" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) {
    return { error: "url must be an absolute HTTP(S) URL without user info or a fragment" };
  }
  // Plain HTTP is only tolerated on the machine itself; anything else carries the configured headers.
  const anywhere = url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
  if (url.protocol === "http:" && !anywhere) return { error: "plain http is only allowed on a loopback endpoint" };

  const headers = config.headers ?? {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return { error: "headers must be an object of strings" };
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== "string") return { error: `header "${name}" must be a string` };
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `header "${name}" is declared twice` };
    seen.add(key);
  }

  return { type: "streamable-http", url: url.href, headers: headers as Record<string, string> };
}

/** The first field the entry carries that its transport does not define. */
function unknownField(config: Record<string, unknown>, allowed: string[]): string | undefined {
  return Object.keys(config).find((field) => !allowed.includes(field));
}

/**
 * The filesystem-resolved path, or nothing when it is missing or escapes the
 * root. Every package path goes through this: a symlink pointing out of the
 * plugin is not a package file.
 */
async function contained(root: string, path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    return real === root || real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Single-pass textual replacement; what a value expands to is never rescanned. */
function expand(value: string, root: string, data: string): string {
  return value.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${PLUGIN_DATA}", data);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The author object is closed: three optional strings, nothing else. */
function isAuthor(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const author = value as Record<string, unknown>;
  return (
    Object.keys(author).every((field) => ["name", "email", "url"].includes(field)) &&
    Object.values(author).every((field) => typeof field === "string")
  );
}

/** Tool names keep to what every provider accepts; the server key namespaces them. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
