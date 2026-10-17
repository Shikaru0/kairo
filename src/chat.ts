import type { ChatRequest, Chunk, Message, Provider, ToolCall } from "./provider/provider.ts";
import type { Tool } from "./tools/tool.ts";

const DEFAULT_SYSTEM =
  "You are a coding agent working in a loop: understand, plan, act, verify. " +
  "Think before you act: reason step by step about what you know and what is unknown, " +
  "then say why the next action is the right one. " +
  "If a task needs more than one step, call the todo tool to write the plan before acting, " +
  "then update it as steps start and finish. Skip the plan for a single straightforward step. " +
  "Read each tool result before the next step, and revise the plan when a step fails " +
  "instead of repeating it. Be concise; prefer the smallest change that works.";

/**
 * How many tool rounds may fail in a row before the turn gives up. The point is
 * to stop the model retrying a broken call forever, so a round that works resets it.
 */
const MAX_TOOL_STRIKES = 8;

/** Why a turn ended, so callers can say so instead of going quiet. */
export type StopReason = "answered" | "stuck";

export interface Stop {
  type: "stop";
  reason: StopReason;
}

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
  async function* turn(): AsyncIterable<Chunk | Stop> {
    let strikes = 0;

    for (;;) {
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

      if (!calls.length) {
        yield { type: "stop", reason: "answered" };
        return;
      }

      // Calls in one response are independent, so run them together; results
      // still go back in call order, which is what the model expects.
      const results = await Promise.all(calls.map(async (call) => [call, await run(tools, call)] as const));
      for (const [call, result] of results) {
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
      }

      strikes = results.some(([, result]) => result.ok) ? 0 : strikes + 1;
      if (strikes > MAX_TOOL_STRIKES) {
        yield { type: "stop", reason: "stuck" };
        return;
      }
    }
  }

  return {
    async *send(input: string): AsyncIterable<Chunk | Stop> {
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

/**
 * Run one call. `ok` is false only when the tool itself failed — a command
 * that exits non-zero is a valid result, so it does not count as a strike.
 */
async function run(tools: Tool[], { name, arguments: args }: ToolCall): Promise<{ content: string; ok: boolean }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, content: `Error: unknown tool "${name}"` };
  try {
    return { ok: true, content: String(await tool.execute(JSON.parse(args || "{}"))) };
  } catch (error) {
    return { ok: false, content: `Error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
