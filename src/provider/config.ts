import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Thinking } from "./provider.ts";

/**
 * Provider configuration, read from `kairo.json` in the working directory on
 * top of `~/.config/kairo/kairo.json`. A project file only has to say what it
 * changes: providers merge per name and their `models` merge per id.
 *
 * Nothing here may fail the client. A broken file costs its own settings and a
 * note, the way a broken plugin costs its own components.
 */

/** One model a provider serves. */
export interface ModelConfig {
  /** Label for `/model`; the id is the key. */
  name?: string;
  /** Context window in tokens, overriding the provider's. */
  context?: number;
  /** Sampling temperature for this model. */
  temperature?: number;
  /** Reasoning effort; `false` requests none. */
  thinking?: Thinking;
}

export interface ProviderConfig {
  /** Wire protocol; a provider named `ollama` defaults to `ollama`, others to `openai`. */
  api?: "ollama" | "openai";
  /** API root, e.g. `https://openrouter.ai/api/v1` or `http://127.0.0.1:11434`. */
  baseURL?: string;
  /** Bearer token; `${VAR}` reads it from the environment. */
  apiKey?: string;
  /** Context window for its models; a model's own value wins. */
  context?: number;
  models?: Record<string, ModelConfig>;
}

export interface Config {
  /** `provider/model` the session starts on. */
  model?: string;
  providers: Record<string, ProviderConfig>;
}

export interface LoadedConfig {
  config: Config;
  /** Every file that contributed, in load order. */
  files: string[];
  /** What was wrong, already prefixed with the file it came from. */
  notes: string[];
}

const THINKING: Thinking[] = [true, false, "low", "medium", "high"];

/** Read both config files, merge them, and make sure `ollama` exists. */
export async function loadConfig(cwd = process.cwd()): Promise<LoadedConfig> {
  const config: Config = { providers: {} };
  const loaded: LoadedConfig = { config, files: [], notes: [] };
  const override = process.env.KAIRO_CONFIG;
  const candidates = override
    ? [resolve(override)]
    : [join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "kairo", "kairo.json"), join(cwd, "kairo.json")];

  for (const file of candidates) {
    const one = await readConfig(file, loaded.notes);
    if (!one) continue;
    merge(config, one);
    loaded.files.push(file);
  }

  // Zero config stays zero config: the local Ollama is always available.
  config.providers.ollama ??= { api: "ollama" };
  return loaded;
}

/** Split `provider/model` at the first slash that names a configured provider. */
export function splitRef(config: Config, ref: string, fallback: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const name = ref.slice(0, slash);
    if (config.providers[name]) return { provider: name, model: ref.slice(slash + 1) };
  }
  return { provider: fallback, model: ref };
}

async function readConfig(file: string, notes: string[]): Promise<Config | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null; // absent is the normal case
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    notes.push(`${file}: not valid JSON`);
    return null;
  }
  if (!isRecord(raw)) {
    notes.push(`${file}: expected a JSON object`);
    return null;
  }

  const config: Config = { providers: {} };
  if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model.trim();
  else if (raw.model !== undefined) notes.push(`${file}: model must be a string`);

  if (raw.providers === undefined) return config;
  if (!isRecord(raw.providers)) {
    notes.push(`${file}: providers must be an object`);
    return config;
  }
  for (const [name, value] of Object.entries(raw.providers)) {
    const where = `${file}: provider ${name}`;
    if (!isRecord(value)) {
      notes.push(`${where} must be an object`);
      continue;
    }
    config.providers[name] = readProvider(value, where, notes);
  }
  return config;
}

function readProvider(raw: Record<string, unknown>, where: string, notes: string[]): ProviderConfig {
  const provider: ProviderConfig = {};
  if (raw.api === "ollama" || raw.api === "openai") provider.api = raw.api;
  else if (raw.api !== undefined) notes.push(`${where}: api must be "ollama" or "openai"`);
  const baseURL = text(raw.baseURL, "baseURL", where, notes);
  if (baseURL !== undefined) provider.baseURL = baseURL;
  const apiKey = text(raw.apiKey, "apiKey", where, notes);
  if (apiKey !== undefined) provider.apiKey = apiKey;
  const context = count(raw.context, "context", where, notes);
  if (context !== undefined) provider.context = context;
  if (raw.models !== undefined) {
    if (!isRecord(raw.models)) notes.push(`${where}: models must be an object`);
    else {
      provider.models = {};
      for (const [id, value] of Object.entries(raw.models)) {
        if (!isRecord(value)) {
          notes.push(`${where}, model ${id} must be an object`);
          continue;
        }
        provider.models[id] = readModel(value, `${where}, model ${id}`, notes);
      }
    }
  }
  return provider;
}

function readModel(raw: Record<string, unknown>, where: string, notes: string[]): ModelConfig {
  const model: ModelConfig = {};
  const name = text(raw.name, "name", where, notes);
  if (name !== undefined) model.name = name;
  const context = count(raw.context, "context", where, notes);
  if (context !== undefined) model.context = context;
  if (typeof raw.temperature === "number" && raw.temperature >= 0 && raw.temperature <= 2) {
    model.temperature = raw.temperature;
  } else if (raw.temperature !== undefined) notes.push(`${where}: temperature must be between 0 and 2`);
  if (THINKING.includes(raw.thinking as Thinking)) model.thinking = raw.thinking as Thinking;
  else if (raw.thinking !== undefined) notes.push(`${where}: thinking must be true, false, "low", "medium" or "high"`);
  return model;
}

/** A string field, with `${VAR}` replaced by the environment. */
function text(value: unknown, field: string, where: string, notes: string[]): string | undefined {
  if (typeof value !== "string") {
    if (value !== undefined) notes.push(`${where}: ${field} must be a string`);
    return undefined;
  }
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

/** A positive number field. */
function count(value: unknown, field: string, where: string, notes: string[]): number | undefined {
  if (typeof value === "number" && value > 0 && Number.isFinite(value)) return value;
  if (value !== undefined) notes.push(`${where}: ${field} must be a positive number`);
  return undefined;
}

function merge(into: Config, from: Config) {
  if (from.model) into.model = from.model;
  for (const [name, provider] of Object.entries(from.providers)) {
    const base = into.providers[name];
    const merged: ProviderConfig = { ...base, ...provider };
    const models: Record<string, ModelConfig> = { ...base?.models };
    for (const [id, model] of Object.entries(provider.models ?? {})) {
      models[id] = { ...models[id], ...model };
    }
    if (Object.keys(models).length) merged.models = models;
    into.providers[name] = merged;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
