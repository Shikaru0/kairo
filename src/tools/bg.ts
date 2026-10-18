import type { Tool } from "./tool.ts";

/** One background tool call: the answer lands here whenever the run finishes. */
interface Run {
  answer: string;
  failed: boolean;
  ready: Promise<void>;
}

/**
 * Gives any tool call the subagent pattern: starting returns an id at once and
 * the call keeps running while the model takes its own steps; collecting
 * awaits, so a too-early collect blocks rather than spinning on a poll loop.
 */
export function bgTool(tools: () => Tool[]): Tool {
  const runs = new Map<number, Run>();
  let nextRun = 0;

  return {
    name: "bg",
    description:
      "Run another tool call in the background, like a subagent: start one with { tool, args } and it " +
      "keeps running while you take your own steps. Collect with { id }; collecting waits for the call " +
      "to finish, so only collect once you have no independent work left. " +
      "Use when: a command will run longer than a few seconds (build, test, install) and you have your own " +
      "steps to do meanwhile; anything quick, just call the tool directly. " +
      "Do not background a call your current steps depend on.",
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", description: "The tool to run, e.g. bash. Cannot be bg itself." },
        args: { type: "object", description: "The arguments for that tool, as with a direct call." },
        id: { type: "integer", description: "A background id from an earlier call. Collects its result instead of starting one." },
      },
    },
    execute: async ({ tool, args, id }) => {
      if (id !== undefined && id !== null) {
        const run = runs.get(Number(id));
        if (!run) return `Error: no background call #${String(id)}`;
        await run.ready;
        // A throw marks a strike, so re-collecting a dead call cannot loop forever.
        if (run.failed) throw new Error(run.answer);
        return run.answer;
      }

      const name = String(tool ?? "").trim();
      if (!name) return "Error: pass `tool` to start a background call, or `id` to collect one.";
      if (name === "bg") return "Error: bg cannot run itself.";
      const target = tools().find((candidate) => candidate.name === name);
      if (!target) return `Error: unknown tool "${name}"`;

      // Small models sometimes pass args pre-stringified; both shapes work.
      const input = (typeof args === "string" ? JSON.parse(String(args)) : args ?? {}) as Record<string, unknown>;
      const run: Run = { answer: "", failed: false, ready: Promise.resolve() };
      const runId = nextRun++;
      runs.set(runId, run);
      // .catch keeps a failure in the stored answer: nothing else awaits this
      // before the model collects, and an unobserved rejection would crash Bun.
      run.ready = Promise.resolve()
        .then(() => target.execute(input))
        .then((answer) => {
          run.answer = String(answer);
        })
        .catch((error) => {
          run.failed = true;
          run.answer = error instanceof Error ? error.message : String(error);
        });

      return `background #${runId} started: ${name}(${JSON.stringify(input)}). Work on your own independent steps, then call bg with {"id": ${runId}} to collect its result.`;
    },
  };
}
