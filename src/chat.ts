import type { ChatRequest, Chunk, Message, Provider, ToolCall } from "./provider/provider.ts";
import type { Tool } from "./tools/tool.ts";

const DEFAULT_SYSTEM = "Think step by step. Reason about your own reasoning. Analyze, plan, act, reflect. Be minimal.";

/** How many times one turn may call tools before giving up. */
const MAX_TOOL_ROUNDS = 8;

/** Anything that configures one conversation; everything but the history. */
export interface ChatOptions extends Omit<ChatRequest, "messages" | "tools"> {
  system?: string;
  tools?: Tool[];
}

/**
 * A conversation with a provider: keeps the message history, appends each
 * exchange, and runs any tools the model asks for before answering.
 */
export function createChat(
  provider: Provider,
  { model, temperature, thinking, system = DEFAULT_SYSTEM, tools = [] }: ChatOptions,
) {
  const messages: Message[] = [{ role: "system", content: system }];

  /** One model turn, plus the tool rounds it asks for. */
  async function* turn(): AsyncIterable<Chunk> {
    for (let round = 0; ; round++) {
      let reply = "";
      let reasoning = "";
      const calls: ToolCall[] = [];
      try {
        for await (const chunk of provider.stream({ model, temperature, thinking, tools, messages })) {
          if (chunk.type === "text") reply += chunk.text;
          else if (chunk.type == "reasoning") reasoning += chunk.text;
          else if (chunk.type === "toolCall") calls.push(chunk.call);
          yield chunk;
        }
      } finally {
        // Runs even if the caller stops mid-stream, so history stays consistent.
        messages.push({ role: "assistant", content: reply, toolCalls: calls, reasoning });
      }

      if (!calls.length || round >= MAX_TOOL_ROUNDS) return;
      for (const call of calls) {
        messages.push({ role: "tool", toolCallId: call.id, content: await run(tools, call) });
      }
    }
  }

  return {
    async *send(input: string): AsyncIterable<Chunk> {
      messages.push({ role: "user", content: input });
      yield* turn();
    },
    /** Return a JSON-serializable snapshot of all messages in the conversation. */
    dump(): Message[] {
      return structuredClone(messages);
    },
    /** Replace the current conversation history with the provided messages. */
    load(dumped: Message[]) {
      messages.splice(0, messages.length, ...structuredClone(dumped));
    },
    /** Clear all messages and restore the system prompt. */
    reset() {
      messages.splice(0, messages.length, { role: "system", content: system });
    },
  };
}

/** Run one call; a failure becomes the tool result so the model can react to it. */
async function run(tools: Tool[], { name, arguments: args }: ToolCall): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return `Error: unknown tool "${name}"`;
  try {
    return String(await tool.execute(JSON.parse(args || "{}")));
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
