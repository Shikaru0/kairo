import type { ChatRequest, Chunk, Message, Provider, ToolCall } from "./provider/provider.ts";
import type { Tool } from "./tools/tool.ts";

const DEFAULT_SYSTEM =
  "You are a coding agent working in a loop: understand, plan, act, verify. " +
  "Think before you act: reason step by step about what you know and what is unknown, " +
  "then say why the next action is the right one. " +
  "If a task needs more than one step, call the todo tool to write the plan before acting, " +
  "then update it as steps start and finish. Skip the plan for a single straightforward step. " +
  "Read each tool result before the next step, and revise the plan when a step fails " +
  "instead of repeating it. " +
  "Subagents can take work off your hands: start a task subagent for a bulky step, keep going on your " +
  "own steps while it runs, then collect its answer. " +
  "Be concise; prefer the smallest change that works.";

/**
 * Prompt for the critic pass: it judges the answer against the task and what the
 * tools actually returned, not against how confident the answer sounds.
 */
const CRITIC_SYSTEM =
  "You check one answer against the task and the tool results in this conversation. " +
  "Reply with exactly OK if it is correct, complete and supported by the tool results. " +
  "Otherwise reply with one short paragraph naming what is wrong or unsupported.";

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

/** Chat-level chunk: the verdict of the critic pass, and whether it asked for a fix. */
export interface Check {
  type: "check";
  verdict: string;
  revised: boolean;
}

/** Anything that configures one conversation; everything but the history. */
export interface ChatOptions extends Omit<ChatRequest, "messages" | "tools"> {
  system?: string;
  tools?: Tool[];
  /**
   * Run one critic pass after a turn that used tools. Off for subagents, whose
   * answer is judged by whoever called them.
   */
  verify?: boolean;
}

/**
 * A conversation with a provider: keeps the message history, appends each
 * exchange, and runs any tools the model asks for before answering.
 */
export function createChat(
  provider: Provider,
  { model, temperature, thinking, system = DEFAULT_SYSTEM, tools = [], verify = true }: ChatOptions,
) {
  const messages: Message[] = [{ role: "system", content: system }];

  /** One model turn, plus the tool rounds it asks for. */
  async function* turn(): AsyncIterable<Chunk | Stop | Check> {
    let strikes = 0;
    let usedTools = false;
    let checked = false;

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
        // One critic pass per turn, and only once tools were involved: that is
        // where an answer can outrun what the tools actually returned.
        if (verify && usedTools && !checked) {
          checked = true;
          const verdict = await critic();
          const revised = !/^ok\b/i.test(verdict);
          yield { type: "check", verdict, revised };
          if (revised) {
            messages.push({
              role: "user",
              content: `That answer was checked and needs fixing: ${verdict}\nRevise it now.`,
            });
            continue;
          }
        }
        yield { type: "stop", reason: "answered" };
        return;
      }

      // Calls in one response are independent, so run them together; results
      // still go back in call order, which is what the model expects.
      const results = await Promise.all(calls.map(async (call) => [call, await run(tools, call)] as const));
      for (const [call, result] of results) {
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
      }
      usedTools = true;

      strikes = results.some(([, result]) => result.ok) ? 0 : strikes + 1;
      if (strikes > MAX_TOOL_STRIKES) {
        yield { type: "stop", reason: "stuck" };
        return;
      }
    }
  }

  /** One tool-free model call that judges the answer so far. */
  async function critic(): Promise<string> {
    let verdict = "";
    for await (const chunk of provider.stream({
      model,
      temperature,
      thinking,
      messages: [{ role: "system", content: CRITIC_SYSTEM }, ...messages],
    })) {
      if (chunk.type === "text") verdict += chunk.text;
    }
    // A silent critic is not a "no"; do not burn a revision on an empty reply.
    return verdict.trim() || "OK";
  }

  return {
    async *send(input: string): AsyncIterable<Chunk | Stop | Check> {
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
