import * as readline from "node:readline/promises";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createChat } from "./chat.ts";
import { ollama } from "./provider/ollama.ts";
import { createTools } from "./tools/tool.ts";
import type { Message } from "./provider/provider.ts";

const SESSIONS_DIR = ".kairo-sessions";
const DEFAULT_SESSION = "default";

async function sessionPath(id: string) {
  await mkdir(SESSIONS_DIR, { recursive: true });
  return join(SESSIONS_DIR, `${id}.json`);
}

const sessionId = process.argv[2] || DEFAULT_SESSION;
let sessionFile = await sessionPath(sessionId);

const provider = ollama();
/** Model settings, shared with the subagents the `task` tool spawns. */
const settings = { model: "qwen3.5:4b", temperature: 0.5, thinking: true } as const;
const chat = createChat(provider, { ...settings, tools: createTools({ provider, ...settings }) });

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
  if (input === "/help") {
    process.stdout.write("/new /clear /history /use <id> /save <id> /ls /exit\n\n");
    if (!closed) rl.prompt();
    continue;
  }

  if (input) {
    let inThinking = false;
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
        process.stdout.write("\x1b[2m[stopped: tool calls kept failing]\x1b[0m\n\n");
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
    await save();
  }

  if (!closed) rl.prompt();
}

rl.close();
if (!exited) process.stdout.write("\x1b[2m[input closed - exiting]\x1b[0m\n");
