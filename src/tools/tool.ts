import type { ToolSpec } from "../provider/provider.ts";
import { readTool } from "./read.ts";
import { grepTool } from "./grep.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import { todoTool } from "./todo.ts";
import { taskTool, type Agent } from "./task.ts";
import { bgTool } from "./bg.ts";

/** A capability the app can run when the model asks for it. */
export interface Tool extends ToolSpec {
  /** Runs the call and returns its result, which is fed back to the model. */
  execute(args: Record<string, unknown>): Promise<string> | string;
}

/** Spawn levels: the top agent, one subagent below it, and one more below that. */
const MAX_SPAWN_DEPTH = 2;

/**
 * The tools one agent runs with. Order is not decoration: a small model reaches
 * for the first tools it reads, so planning (`todo`) and delegation (`task`) sit
 * where the model will find them. Each spawn re-enters with `depth - 1`, and at
 * zero there is no `task` tool at all — so nesting is bounded by construction
 * rather than by asking the model to behave.
 */
export function createTools(agent: Agent, depth = MAX_SPAWN_DEPTH): Tool[] {
  const tools: Tool[] = [todoTool, grepTool, readTool, writeTool, editTool, bashTool];
  if (depth <= 0) return tools;
  // `bg` closes over the finished list, so it backgrounds exactly the calls its own agent has.
  const all: Tool[] = [
    todoTool,
    taskTool(agent, (model) => createTools({ ...agent, model }, depth - 1)),
    bgTool(() => all),
    ...tools.slice(1),
  ];
  return all;
}
