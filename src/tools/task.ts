import { createChat } from "../chat.ts";
import type { ChatRequest, Provider } from "../provider/provider.ts";
import type { Tool } from "./tool.ts";

const SUBAGENT_SYSTEM =
  "You are a subagent with exactly one task. Work it with the tools, then answer with only what the " +
  "caller needs: exact paths, values and conclusions, no preamble. Nothing can answer a question back.";

/** What a subagent runs on: the parent's provider and defaults, overridable per spawn. */
export interface Agent extends Omit<ChatRequest, "messages" | "tools"> {
  provider: Provider;
}

/** One background subagent: the answer lands here whenever the run finishes. */
interface Run {
  answer: string;
  failed: boolean;
  ready: Promise<void>;
}

/**
 * Offloads work instead of stalling on it: starting a subagent returns an id at
 * once and the run continues in the background while the parent takes its own
 * steps. Collecting awaits, so a too-early collect blocks rather than spinning
 * on a poll loop. Only the answer comes back — the child's transcript never
 * reaches the parent's history.
 *
 * `spawn(model)` builds the child's tool list fresh for every run, which is what
 * gives each subagent its own nested `task` instance, its own background runs
 * and, at depth zero, no `task` at all. The `model` lets the caller hand easy
 * work to a smaller model; it then sticks as the default for that subtree.
 */
export function taskTool(agent: Agent, spawn: (model: string) => Tool[]): Tool {
  const runs = new Map<number, Run>();
  let nextRun = 0;

  async function start(task: string, model: string): Promise<string> {
    const child = createChat(agent.provider, {
      model,
      temperature: agent.temperature,
      thinking: agent.thinking,
      system: SUBAGENT_SYSTEM,
      tools: spawn(model),
      // The caller judges the summary, so the subagent skips its own critic pass.
      verify: false,
    });

    let answer = "";
    for await (const chunk of child.send(task)) {
      if (chunk.type === "text") answer += chunk.text;
      if (chunk.type === "stop" && chunk.reason === "stuck") {
        answer += "\n(subagent stopped: its tool calls kept failing)";
      }
    }
    return answer.trim() || "(subagent returned nothing)";
  }

  return {
    name: "task",
    description:
      "Start a subagent on one self-contained task; it runs in the background and hands back an id " +
      "immediately, so it works while you take your own steps. Call again with { id } to collect the " +
      "answer. `model` runs it on a different pulled model — bash `ollama list` shows what is pulled — " +
      "so easy work can go to a fast small model and hard work to a bigger one. Nesting: a subagent " +
      "gets this same tool one level shallower, and at the bottom it is simply absent, so depth is " +
      "enforced by the tool list, not by trust.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The task, plus everything the subagent needs to know. Starts a new subagent.",
        },
        id: {
          type: "integer",
          description: "A subagent id from an earlier call. Collects its answer instead of starting one.",
        },
        model: {
          type: "string",
          description: "Run this subagent on another pulled model. Defaults to the one you run on.",
        },
      },
    },
    execute: async ({ task, id, model }) => {
      if (id !== undefined && id !== null) {
        const run = runs.get(Number(id));
        if (!run) return `Error: no subagent #${String(id)}`;
        await run.ready;
        // A throw marks a strike, so re-collecting a dead subagent cannot loop forever.
        if (run.failed) throw new Error(run.answer);
        return run.answer;
      }

      const text = String(task ?? "").trim();
      if (!text) return "Error: pass `task` to start a subagent, or `id` to collect one.";
      const chosen = String(model ?? agent.model);

      const run: Run = { answer: "", failed: false, ready: Promise.resolve() };
      const runId = nextRun++;
      runs.set(runId, run);
      // .catch keeps a failure in the stored answer: nothing else may await this
      // before the model collects, and an unobserved rejection would crash Bun.
      run.ready = start(text, chosen)
        .then((answer) => {
          run.answer = answer;
        })
        .catch((error) => {
          run.failed = true;
          run.answer = error instanceof Error ? error.message : String(error);
        });

      return `subagent #${runId} started on ${chosen}. Work on your own steps, then call task with {"id": ${runId}} to collect its answer.`;
    },
  };
}
