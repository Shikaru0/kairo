import type { ToolSpec } from "../provider/provider.ts";
import { readTool } from "./read.ts";
import { grepTool } from "./grep.ts";
import { globTool } from "./glob.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import { todoTool } from "./todo.ts";
import { taskTool, type Agent } from "./task.ts";
import { bgTool } from "./bg.ts";
import { webFetchTool } from "./web/webfetch.ts";
import { webSearchTool } from "./web/websearch.ts";

/** A capability the app can run when the model asks for it. */
export interface Tool extends ToolSpec {
  /** Runs the call and returns its result, which is fed back to the model. */
  execute(args: Record<string, unknown>): Promise<string> | string;
}

/** Depth of subagents */
const MAX_SPAWN_DEPTH = 6;

/**
 * The tools one agent runs with. Order is not decoration: a small model reaches
 * for the first tools it reads, so planning (`todo`) and delegation (`task`) sit
 * where the model will find them. Each spawn re-enters with `depth - 1`, and at
 * zero there is no `task` tool at all — so nesting is bounded by construction
 * rather than by asking the model to behave. `extra` is what the plugins brought:
 * every agent may use them, subagents included; they sit last because a model
 * looks for a builtin first.
 */
export function createTools(agent: Agent, extra: Tool[] = [], depth = MAX_SPAWN_DEPTH): Tool[] {
  const baseTools: Tool[] = [todoTool, globTool, grepTool, readTool, webSearchTool, webFetchTool, writeTool, editTool, bashTool, ...extra];
  if (depth <= 0) return baseTools;
  // `bg` closes over the finished list, so it backgrounds exactly the calls its own agent has.
  const all: Tool[] = [
    todoTool,
    taskTool(agent, (model, allowedTools?: string[]) => {
      const spawned = createTools({ ...agent, model }, extra, depth - 1);
      if (!allowedTools?.length) return spawned;
      const allowed = new Set(allowedTools);
      return spawned.filter(t => allowed.has(t.name) || t.name === "task" || t.name === "bg");
    }),
    bgTool(() => all),
    ...baseTools.slice(1),
  ];
  return all;
}
