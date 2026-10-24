import * as readline from "node:readline/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createChat, DEFAULT_SYSTEM } from "./chat.ts";
import { compact } from "./compact.ts";
import { loadPlugins, mcpInstructions, skillCatalog } from "./plugins/plugin.ts";
import { loadConfig, splitRef } from "./provider/config.ts";
import { ollama } from "./provider/ollama.ts";
import { openaiCompatible } from "./provider/openai.ts";
import type { Provider, Thinking } from "./provider/provider.ts";
import { createTools } from "./tools/tool.ts";
import { skillTool } from "./tools/skill.ts";
import { projectSnapshot } from "./snapshot.ts";
import type { Message } from "./provider/provider.ts";

const SESSIONS_DIR = ".kairo-sessions";
const DEFAULT_SESSION = "default";

async function sessionPath(id: string) {
  await mkdir(SESSIONS_DIR, { recursive: true });
  return join(SESSIONS_DIR, `${id}.json`);
}

const sessionId = process.argv[2] || DEFAULT_SESSION;
let sessionFile = await sessionPath(sessionId);

// Providers come from `kairo.json`: what hosts exist, what they serve, how to
// reach them. Nothing configured still means the local Ollama.
const loaded = await loadConfig();
if (loaded.files.length) process.stdout.write(`\x1b[2m[config] ${loaded.files.join(" · ")}\x1b[0m\n`);
for (const note of loaded.notes) process.stdout.write(`\x1b[2m[config] ${note}\x1b[0m\n`);
const config = loaded.config;

/** Context window for a model, the provider's when it has no own; env overrides both. */
function contextOf(name: string, id: string): number | undefined {
  const enforced = Number(process.env.KAIRO_CONTEXT) || undefined;
  if (enforced) return enforced;
  const configured = config.providers[name];
  return configured?.models?.[id]?.context ?? configured?.context;
}

/** Wire one configured provider up to its host. */
function build(name: string, id: string): Provider {
  const configured = config.providers[name] ?? {};
  if ((configured.api ?? (name === "ollama" ? "ollama" : "openai")) === "ollama") {
    return ollama(configured.baseURL ?? process.env.OLLAMA_HOST, { id: name, contextSize: contextOf(name, id) });
  }
  const baseURL = configured.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  // Local hosts take any bearer token; OpenAI itself needs a real one.
  const apiKey = configured.apiKey ?? process.env.OPENAI_API_KEY ?? (baseURL === "https://api.openai.com/v1" ? undefined : "local");
  return openaiCompatible({ id: name, baseURL, apiKey });
}

const built = new Map<string, Provider>();
function providerFor(name: string, id: string): Provider {
  if (!config.providers[name]) {
    throw new Error(`unknown provider ${JSON.stringify(name)}; have ${Object.keys(config.providers).join(", ")}`);
  }
  // Ollama bakes its window into every request, so a model with another window
  // needs its own instance. Compatible hosts leave the window to the server.
  const key = `${name}|${contextOf(name, id) ?? ""}`;
  const ready = built.get(key);
  if (ready) return ready;
  const created = build(name, id);
  built.set(key, created);
  return created;
}

/** The model each provider last ran, so switching back does not lose it. */
const models: Record<string, string> = {};
function defaultModel(name: string): string {
  return process.env.KAIRO_MODEL || Object.keys(config.providers[name]?.models ?? {})[0] || (name === "ollama" ? "qwen3.5:4b" : "");
}

let active = process.env.KAIRO_PROVIDER ?? "";
let model = process.env.KAIRO_MODEL ?? (!active ? config.model : undefined) ?? "";
if (model) {
  // A prefixed model names its own provider; KAIRO_PROVIDER still wins.
  const ref = splitRef(config, model, active || "ollama");
  model = ref.model;
  active ||= ref.provider;
}
active ||= "ollama";
model ||= defaultModel(active);
let current: Provider;
try {
  current = providerFor(active, model);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stdout.write(`\x1b[2m[provider ${active}: ${reason}; using ollama]\x1b[0m\n`);
  active = "ollama";
  model = defaultModel(active);
  current = providerFor(active, model);
}
/**
 * The one thing every consumer holds. It forwards to whichever provider is
 * active now, so `/provider` reaches the chat, its tools and its subagents at
 * once without any of them being rebuilt.
 */
const provider: Provider = {
  get id() {
    return current.id;
  },
  get contextSize() {
    // Compatible hosts report no window, but a configured one still sizes the work.
    return current.contextSize ?? contextOf(active, model);
  },
  stream: (request) => current.stream(request),
};
models[active] = model;
if (!model) process.stdout.write(`\x1b[2m[provider ${active}: set a model with /model <id>]\x1b[0m\n`);
/** Sampling for the active model; `/model` and `/provider` refill it. */
const DEFAULTS = { temperature: 0.5, thinking: "high" as Thinking };
const start = config.providers[active]?.models?.[model];
const settings = {
  temperature: start?.temperature ?? DEFAULTS.temperature,
  thinking: start?.thinking ?? DEFAULTS.thinking,
};
// Agent Plugins: skills go into the prompt, MCP tools into every agent's list.
// Loading never throws; whatever went wrong is in `notes` and reported below.
const plugins = await loadPlugins();
for (const note of plugins.notes) process.stdout.write(`\x1b[2m[plugin] ${note}\x1b[0m\n`);
if (plugins.skills.length || plugins.tools.length || plugins.prompts.length) {
  process.stdout.write(
    `\x1b[2m[plugins: ${plugins.skills.length} skills, ${plugins.tools.length} tools, ${plugins.prompts.length} prompts]\x1b[0m\n`,
  );
}
// Where the work is, then the user's and project's own AGENTS.md, then each
// plugin's, then the skill catalog, then any MCP server instructions: facts
// first, what the model can look up next, and the standing rules last.
const contributed = [
  await projectSnapshot(),
  ...plugins.prompts.map((prompt) => prompt.text),
  skillCatalog(plugins.skills),
  mcpInstructions(plugins.instructions),
].filter(Boolean).join("\n\n");
const chat = createChat(provider, {
  model,
  ...settings,
  system: contributed ? `${DEFAULT_SYSTEM}\n\n${contributed}` : undefined,
  // Getters, not copies: a subagent started after `/model` runs on the new model and sampling.
  tools: createTools(
    {
      provider,
      get model() {
        return model;
      },
      get temperature() {
        return settings.temperature;
      },
      get thinking() {
        return settings.thinking;
      },
    },
    [...(plugins.skills.length ? [skillTool(plugins.skills)] : []), ...plugins.tools],
  ),
});

/** Make a provider/model live, with its configured sampling. Throws before changing anything. */
function activate(name: string, next: string) {
  const target = providerFor(name, next);
  models[active] = model;
  active = name;
  model = next;
  models[name] = next;
  current = target;
  const entry = config.providers[name]?.models?.[next];
  settings.temperature = entry?.temperature ?? DEFAULTS.temperature;
  settings.thinking = entry?.thinking ?? DEFAULTS.thinking;
  chat.setModel(next);
  chat.setOptions(settings);
}

if (existsSync(sessionFile)) {
  try {
    const data = await readFile(sessionFile, "utf8");
    const messages = JSON.parse(data) as Message[];
    if (Array.isArray(messages)) chat.load(messages);
  } catch (e) {
    // ignore load errors, start fresh
  }
}

async function save() {
  try {
    await writeFile(sessionFile, JSON.stringify(chat.dump(), null, 2), "utf8");
  } catch (e) {
    // ignore save errors
  }
}

/** Read a saved session into the chat. Returns an error message, or null on success. */
async function loadSession(id: string): Promise<string | null> {
  const path = await sessionPath(id);
  if (!existsSync(path)) return `no session ${id}`;
  try {
    const messages = JSON.parse(await readFile(path, "utf8")) as Message[];
    if (!Array.isArray(messages)) return `invalid session ${id}`;
    chat.load(messages);
    return null;
  } catch (e) {
    return `failed to use ${id}`;
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => {
  closed = true;
});

rl.setPrompt("> ");
rl.prompt();
let exited = false;
for await (const line of rl) {
  const input = line.trim();
  if (input === "/exit" || input === "exit") {
    exited = true;
    break;
  }
  if (input === "/new") {
    chat.reset();
    await save();
    process.stdout.write("\x1b[2m[new session]\x1b[0m\n\n");
    if (!closed) rl.prompt();
    continue;
  }
  if (input.startsWith("/use ")) {
    const id = input.slice(5).trim();
    if (id) {
      const error = await loadSession(id);
      if (error) {
        process.stdout.write(`\x1b[2m[${error}]\x1b[0m\n\n`);
      } else {
        // The point of switching: later turns are saved to this session, not the startup one.
        sessionFile = await sessionPath(id);
        process.stdout.write(`\x1b[2m[using ${id}]\x1b[0m\n\n`);
      }
    }
    if (!closed) rl.prompt();
    continue;
  }
  if (input.startsWith("/save ")) {
    const id = input.slice(6).trim();
    if (id) {
      const path = await sessionPath(id);
      await mkdir(SESSIONS_DIR, { recursive: true });
      try {
        await writeFile(path, JSON.stringify(chat.dump(), null, 2), "utf8");
        await save();
        process.stdout.write(`\x1b[2m[saved ${id}]\x1b[0m\n\n`);
      } catch (e) {
        process.stdout.write(`\x1b[2m[failed to save ${id}]\x1b[0m\n\n`);
      }
    }
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/model" || input.startsWith("/model ")) {
    const ref = input.slice(6).trim();
    if (!ref) {
      // Everything the config declares, so an unfamiliar id is one line away.
      const rows = Object.entries(config.providers).flatMap(([name, provider]) =>
        Object.entries(provider.models ?? {}).map(([id, entry]) => {
          const mark = name === active && id === model ? "*" : " ";
          const context = entry.context ? ` · ${Math.round(entry.context / 1000)}k` : "";
          return `${mark} ${name}/${id}${entry.name ? `  ${entry.name}` : ""}${context}`;
        }),
      );
      const body = rows.length ? rows.join("\n") : "[no models configured · /model <id> runs any model the provider serves]";
      process.stdout.write(`\x1b[2m[provider ${active} · ${model || "no model"}]\n${body}\x1b[0m\n\n`);
    } else {
      try {
        const next = splitRef(config, ref, active);
        activate(next.provider, next.model);
        process.stdout.write(`\x1b[2m[using ${active} · ${model}]\x1b[0m\n\n`);
      } catch (error) {
        process.stdout.write(`\x1b[2m[${error instanceof Error ? error.message : String(error)}]\x1b[0m\n\n`);
      }
    }
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/provider" || input.startsWith("/provider ")) {
    const [name = "", ...rest] = input.slice(9).trim().split(/\s+/);
    if (!name) {
      const names = Object.entries(config.providers)
        .map(([known, provider]) => {
          const api = provider.api ?? (known === "ollama" ? "ollama" : "openai");
          return `${known === active ? "*" : ""}${known} (${api})`;
        })
        .join(" · ");
      process.stdout.write(`\x1b[2m[provider ${active} · ${model || "no model"}] ${names}\x1b[0m\n\n`);
    } else {
      try {
        // `/provider openai gpt-4o-mini` switches and sets the model in one step.
        const next = rest.join(" ").trim() || models[name] || defaultModel(name);
        activate(name, next);
        process.stdout.write(
          `\x1b[2m[provider ${active}${model ? ` · ${model}` : " · set a model with /model <id>"}]\x1b[0m\n\n`,
        );
      } catch (error) {
        process.stdout.write(`\x1b[2m[${error instanceof Error ? error.message : String(error)}]\x1b[0m\n\n`);
      }
    }
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/compact") {
    const snapshot = chat.dump();
    const removed = await compact(snapshot, { provider, model, temperature: settings.temperature }, true);
    if (removed) {
      chat.load(snapshot);
      await save();
      process.stdout.write(`\x1b[2m[compacted: ${removed} messages -> summary]\x1b[0m\n\n`);
    } else {
      process.stdout.write("\x1b[2m[nothing to compact]\x1b[0m\n\n");
    }
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/clear") {
    chat.reset();
    await save();
    process.stdout.write("\x1b[2m[cleared]\x1b[0m\n\n");
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/history") {
    const msgs = chat.dump();
    process.stdout.write(JSON.stringify(msgs, null, 2) + "\n\n");
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/ls" || input === "/list") {
    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(SESSIONS_DIR);
      const sessions = files.filter(f => f.endsWith(".json")).map(f => f.slice(0, -5));
      process.stdout.write(sessions.join("\n") + "\n\n");
    } catch {
      process.stdout.write("\x1b[2m[no sessions]\x1b[0m\n\n");
    }
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/plugins") {
    for (const note of plugins.notes) process.stdout.write(`\x1b[2m[plugin] ${note}\x1b[0m\n`);
    for (const skill of plugins.skills) process.stdout.write(`\x1b[2m[skill] ${skill.name} - ${skill.location}\x1b[0m\n`);
    for (const tool of plugins.tools) process.stdout.write(`\x1b[2m[tool] ${tool.name}\x1b[0m\n`);
    for (const prompt of plugins.prompts) process.stdout.write(`\x1b[2m[prompt] ${prompt.source} (${prompt.text.length} chars)\x1b[0m\n`);
    for (const item of plugins.instructions) process.stdout.write(`\x1b[2m[mcp] ${item.server}: ${item.text.split("\n")[0]}\x1b[0m\n`);
    if (
      !plugins.skills.length &&
      !plugins.tools.length &&
      !plugins.prompts.length &&
      !plugins.instructions.length &&
      !plugins.notes.length
    ) {
      process.stdout.write("\x1b[2m[no plugins]\x1b[0m\n");
    }
    process.stdout.write("\n");
    if (!closed) rl.prompt();
    continue;
  }
  if (input === "/help") {
    process.stdout.write("/new /clear /history /use <id> /save <id> /model [name] /provider [name] [model] /compact /plugins /ls /exit\n\n");
    if (!closed) rl.prompt();
    continue;
  }

  if (input) {
    let inThinking = false;
    try {
      for await (const chunk of chat.send(input)) {
        if (chunk.type === "reasoning") {
          if (!inThinking) {
            inThinking = true;
            process.stdout.write("\x1b[2m[thinking] ");
          }
          process.stdout.write(chunk.text);
          continue;
        }
        if (inThinking) {
          inThinking = false;
          process.stdout.write("\x1b[0m\n\n");
        }
        if (chunk.type === "text") process.stdout.write(chunk.text);
        else if (chunk.type === "toolCall") process.stdout.write(`\x1b[2m[tool] ${chunk.call.name}(${chunk.call.arguments})\x1b[0m\n\n`);
        else if (chunk.type === "finish" && chunk.reason === "length") process.stdout.write("\x1b[2m[cut off: hit the model's context/token limit]\x1b[0m\n\n");
        else if (chunk.type === "stop" && chunk.reason === "stuck") {
          if (chunk.failures?.length) {
            const lines = chunk.failures.slice(-8).map((f) => `  - ${f.call}: ${f.error}`).join("\n");
            process.stdout.write(`\x1b[2m[stopped: tool calls kept failing]\n${lines}\x1b[0m\n\n`);
          } else {
            process.stdout.write("\x1b[2m[stopped: model kept replying with nothing]\x1b[0m\n\n");
          }
        } else if (chunk.type === "compact") {
          process.stdout.write(`\x1b[2m[context compacted: ${chunk.removed} messages -> summary]\x1b[0m\n\n`);
        } else if (chunk.type === "trim") {
          process.stdout.write(`\x1b[2m[context trimmed: ${chunk.elided} old tool results shortened]\x1b[0m\n\n`);
        } else if (chunk.type === "check") {
          process.stdout.write(
            chunk.revised
              ? `\x1b[2m[self-check] ${chunk.verdict}\x1b[0m\n\n`
              : "\x1b[2m[self-check] ok\x1b[0m\n\n",
          );
        }
      }
      if (inThinking) process.stdout.write("\x1b[0m");
      process.stdout.write("\n\n");
    } catch (error) {
      // A dead provider must not take the session with it: report, keep the history, stay in the REPL.
      if (inThinking) process.stdout.write("\x1b[0m");
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`\x1b[2m[provider error: ${message}]\x1b[0m\n\n`);
    }
    await save();
  }

  if (!closed) rl.prompt();
}

rl.close();
if (!exited) process.stdout.write("\x1b[2m[input closed - exiting]\x1b[0m\n");
