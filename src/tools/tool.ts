import type { ToolSpec } from "../provider/provider.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

/** A capability the app can run when the model asks for it. */
export interface Tool extends ToolSpec {
  /** Runs the call and returns its result, which is fed back to the model. */
  execute(args: Record<string, unknown>): Promise<string> | string;
}

export const tools: Tool[] = [
  readTool,
  writeTool,
];