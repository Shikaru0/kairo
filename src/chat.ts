import type { ChatRequest, Chunk, Message, Provider, Thinking, ToolCall } from "./provider/provider.ts";
import type { Tool } from "./tools/tool.ts";
import { compact, freeSpace, trim, type Compact, type Trim } from "./compact.ts";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

export const DEFAULT_SYSTEM =
  "You are Kairo, a coding agent working in a loop: think, act with a tool, read the result, repeat until the task is done. " +
  "A <system-reminder> block may arrive with a round; it is context from the application, not a message from the user. " +
  "Don't guess projects: get the needed context first. " +
  "Use tools in batches or in parallel when you already know which tool calls you want to do. " +
  "Search code with grep and glob, read files with read, and keep bash for commands, builds and tests rather than for making changes. " +
  "Before editing a file, read it first and copy oldString exactly from that read; never edit from memory. " +
  "When a tool call fails or its result surprises you, re-read the situation and change the approach instead of repeating the call. " +
  "Plan multi-step work with todo and update it as steps finish; skip the plan for a single step. " +
  "Self-contained bulky work can go to task (a subagent) or bg (a background call) so your own steps keep moving; collect when you run out of them. " +
  "Think in your reasoning about what is known, what is unknown, and why the next action is the right one. " +
  // A worked round: a small model copies a shape far more reliably than it follows a rule.
  "A round that goes well: grep {pattern: \"total\"} -> read {path: \"src/cart.ts\"} -> edit {path, oldString: text copied from that read} " +
  "-> bash {command: \"bun test\"} -> one sentence naming the change and the test result. " +
  // The ways a round goes wrong: the test bent to fit the code, the done never checked, the file nobody asked for.
  "Never rewrite or weaken a test to make it pass; if a test looks wrong, say so and leave it alone. " +
  "Never say a task is done without running a check on it, and never create files nobody asked for. " +
  "Keep replies short; when done, state what changed in one or two sentences. " +
  "Keep going until the task is done: stop when the check passes or you are blocked, not when the work looks finished.";

/**
 * Prompt for the critic pass: it judges the answer against the task and what the
 * tools actually returned, not against how confident the answer sounds.
 */
const CRITIC_SYSTEM =
  "You check one answer against the task it was given. Four checks, in order: " +
  "1) it does what the task actually asked, " +
  "2) every claim in it matches a tool result in this conversation - nothing invented, " +
  "3) any change it calls done was checked by a command that passed, and no test was weakened to make it pass, " +
  "4) it is complete, not cut off mid-solution. " +
  "Judge the task as given: a gap you would have added yourself is not a failure. " +
  "If all four hold, reply with exactly OK. Otherwise name the single most important problem in one sentence.";

/**
 * How many tool rounds may fail in a row before the turn gives up. The point is
 * to stop the model retrying a broken call forever, so a round that works resets it.
 */
const MAX_TOOL_STRIKES = 8;

/**
 * How many times one identical call (same tool, same arguments) may run in a
 * single turn. The one after that is refused: re-issuing a call whose result is
 * already in the history is a loop, not progress. Counted per turn, so the same
 * call in a later turn — a test rerun after an edit, say — is fine.
 */
const MAX_IDENTICAL_CALLS = 4;

/**
 * A tool result larger than this has its full text saved to a file, and only a
 * head and a tail of it stay in context, noted with the path so the model can
 * read the rest with offset/limit. High on purpose: ordinary results never
 * reach it, but one huge bash dump must not own the window forever.
 */
const MAX_TOOL_OUTPUT = 32_000;
/** How much of a spilled result stays in context: this many chars at each end. */
const KEPT_EDGES = 2_000;

/** Why a turn ended, so callers can say so instead of going quiet. */
export type StopReason = "answered" | "stuck";

export interface Stop {
  type: "stop";
  reason: StopReason;
  failures?: Array<{ call: string; error: string }>;
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
  { model: startModel, temperature, thinking, system = DEFAULT_SYSTEM, tools = [], verify = true }: ChatOptions,
) {
  /** Swappable at runtime (`/model`), so a let: future turns run on whatever it holds. */
  let model = startModel;
  const messages: Message[] = [{ role: "system", content: system }];

  /** One model turn, plus the tool rounds it asks for. */
  async function* turn(): AsyncIterable<Chunk | Stop | Check | Compact | Trim> {
    let strikes = 0;
    let usedTools = false;
    const recentFailures: Array<{ call: string; error: string }> = [];
    let checked = false;
    let retriedFull = false;
    /** Identical calls seen this turn, with the verdict `run`-or-block for each. */
    const seen = new Map<string, number>();

    for (;;) {
      // Small compaction first: eliding the middles of old tool results is cheap
      // and keeps recent turns verbatim; the summariser is what runs when that
      // alone does not free enough.
      const elided = trim(messages, provider);
      if (elided) yield { type: "trim", elided };

      // A tool-heavy turn can outgrow the window mid-flight, so the history is
      // weighed before every round, not only when a turn starts.
      const removed = await compact(messages, { provider, model, temperature });
      if (removed) {
        yield { type: "compact", removed };
        // The notes are the model's whole memory now; it continues from a user turn.
        messages.push({ role: "user", content: "Continue the task from these notes." });
      }

      // The prompt itself never changes between rounds, so a provider can reuse
      // everything before this point from its cache and prefill only what is new.
      // The volatile part rides as the request's last message: per-request, never
      // stored, so it cannot pile up or reach a saved session.
      const request: Message[] = [...messages, { role: "user", content: turnContext(freeSpace(messages, provider)) }];

      let reply = "";
      let reasoning = "";
      let finish: string | undefined;
      const calls: ToolCall[] = [];
      try {
        for await (const chunk of provider.stream({ model, temperature, thinking, tools, messages: request })) {
          if (chunk.type === "text") reply += chunk.text;
          else if (chunk.type == "reasoning") reasoning += chunk.text;
          else if (chunk.type === "toolCall") calls.push(chunk.call);
          // A full window is recovered from below; only the final cut-off is reported.
          else if (chunk.type === "finish") {
            finish = chunk.reason;
            if (chunk.reason !== "length") yield chunk;
            continue;
          }
          yield chunk;
        }
      } finally {
        // Runs even if the caller stops mid-stream, so history stays consistent.
        // A fully empty message (no text, no calls, no reasoning) is kept out:
        // there is nothing in it to show or to answer from.
        if (reply.trim() || reasoning.trim() || calls.length) {
          messages.push({ role: "assistant", content: reply, toolCalls: calls, reasoning });
        }
      }

      if (!calls.length) {
        // The window filled mid-answer: the history becomes notes and this round
        // runs once more on top of them; a second cut-off means there is no way on.
        if (finish === "length") {
          if (retriedFull) {
            yield { type: "finish", reason: "length" };
            return;
          }
          retriedFull = true;
          const freed = await compact(messages, { provider, model, temperature }, true);
          if (!freed) {
            yield { type: "finish", reason: "length" };
            return;
          }
          yield { type: "compact", removed: freed };
          messages.push({ role: "user", content: "Your context window filled. Continue the task from these notes." });
          continue;
        }
        // No text and no call is the model stalling, not an answer — ask again.
        // Counting against the strikes ends the turn if it keeps stalling.
        if (!reply.trim()) {
          strikes++;
          if (strikes > MAX_TOOL_STRIKES) {
            yield { type: "stop", reason: "stuck" };
            return;
          }
          messages.push({
            role: "user",
            content: "You replied with nothing. Continue the task: call a tool or give your answer.",
          });
          continue;
        }
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
      const results = await Promise.all(
        calls.map(async (call) => {
          // Same tool, same arguments, again: the answer is already in the
          // history, so running it once more buys nothing. Say so instead.
          const key = `${call.name} ${call.arguments}`;
          const nth = (seen.get(key) ?? 0) + 1;
          seen.set(key, nth);
          if (nth > MAX_IDENTICAL_CALLS) {
            return [
              call,
              {
                ok: false,
                content:
                  `Error: blocked identical ${call.name} call #${nth} this turn - the result of the exact same call ` +
                  "is already in the history. You are in a loop: change the arguments, use a different tool, or " +
                  "explain what new information you still expect from it.",
              },
            ] as const;
          }
          return [call, await run(tools, call)] as const;
        }),
      );
      for (const [call, result] of results) {
        messages.push({ role: "tool", toolCallId: call.id, content: await spillResult(call.name, result.content) });
      }
      usedTools = true;

      const failed = results.filter(([, result]) => !result.ok);
      if (results.some(([, result]) => result.ok)) {
        strikes = 0;
        recentFailures.length = 0;
      } else {
        strikes++;
        for (const [call, result] of failed) {
          recentFailures.push({call: `${call.name}(${call.arguments})`, error: (result.content.split("\n")[0] ?? "").slice(0, 300)});
        }
      }
      if (strikes > MAX_TOOL_STRIKES) {
        yield { type: "stop", reason: "stuck", failures: recentFailures };
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
      // One system message, the critic's own. The coding prompt sits at index 0
      // of the history; leaving it in front of this one gives a small model two
      // sets of instructions, and it tends to keep coding instead of judging.
      messages: [{ role: "system", content: CRITIC_SYSTEM }, ...messages.filter((message) => message.role !== "system")],
    })) {
      if (chunk.type === "text") verdict += chunk.text;
    }
    // A silent critic is not a "no"; do not burn a revision on an empty reply.
    return verdict.trim() || "OK";
  }

  return {
    async *send(input: string): AsyncIterable<Chunk | Stop | Check | Compact | Trim> {
      // Compaction runs inside the turn, before every round: the new input
      // joins the history and the first round weighs it like the rest.
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
    /** Swap the model future turns run on; the history carries over as-is. */
    setModel(next: string) {
      model = next;
    },
    /** Swap sampling for future turns and critic passes; the history carries over. */
    setOptions({ temperature: nextTemperature, thinking: nextThinking }: { temperature?: number; thinking?: Thinking }) {
      temperature = nextTemperature ?? temperature;
      thinking = nextThinking ?? thinking;
    },
  };
}

/**
 * Ordinary results pass through untouched; anything over the limit is written
 * to /tmp/kairo/<tool>-<id>.txt and only its ends are reported back, with a
 * note naming the file. A failed save still truncates rather than throwing —
 * a tmp write must not be able to kill the turn.
 */
async function spillResult(name: string, content: string): Promise<string> {
  if (content.length <= MAX_TOOL_OUTPUT) return content;
  const head = content.slice(0, KEPT_EDGES);
  const tail = content.slice(-KEPT_EDGES);
  let where: string;
  try {
    const file = `/tmp/kairo/${name}-${randomUUID().slice(0, 8)}.txt`;
    await mkdir("/tmp/kairo", { recursive: true });
    await writeFile(file, content, "utf8");
    where = `full output saved to ${file}`;
  } catch {
    where = "could not save the full output";
  }
  return `${head}\n[output too large (${content.length} chars); ${where}]\n${tail}`;
}

/**
 * Sent as a round's last message, never stored. None of this is knowable to the
 * model otherwise, and one-call-per-round is exactly what a model does when it
 * cannot see the clock or how much window is left. It rides at the end so the
 * prompt and the history before it stay byte-identical between rounds, which is
 * what lets a local provider reuse its cache for them instead of re-reading the
 * whole conversation. The tags tell the model this is the application talking.
 */
function turnContext(free: number): string {
  return (
    "<system-reminder>\n" +
    `[turn context — ${new Date().toISOString().slice(11, 16)} UTC · cwd ${process.cwd()} · ` +
    `${Math.round(free * 100)}% of the window free] ` +
    "Batch the independent tool calls you already know you need into one response; " +
    "when the window runs low, stop gathering and answer from what you have.\n" +
    "</system-reminder>"
  );
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
