import * as readline from "node:readline/promises";
import { createChat } from "./chat.ts";
import { ollama } from "./provider/ollama.ts";
import { tools } from "./tools/tool.ts";

const chat = createChat(ollama(), {
  model: "qwen3.5:4b",
  temperature: 0.5,
  thinking: "high",
  tools: tools,
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => {
  closed = true;
});

rl.setPrompt("> ");
rl.prompt();
for await (const line of rl) {
  const input = line.trim();
  if (input === "exit") break;

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
      else if (chunk.reason === "length") process.stdout.write("\x1b[2m[cut off: hit the model's context/token limit]\x1b[0m\n\n");
    }
    if (inThinking) process.stdout.write("\x1b[0m");
    process.stdout.write("\n\n");
  }

  if (!closed) rl.prompt();
}

rl.close();
