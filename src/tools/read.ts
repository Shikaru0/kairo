import { readFile } from "node:fs/promises";
import type { Tool } from "./tool.ts";

/** Reads a text file from disk; failures surface to the model as an error result. */
export const readTool: Tool = {
  name: "read",
  description: "Read a text file and return its contents.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
    },
    required: ["path"],
  },
  execute: ({ path }) => readFile(String(path), "utf8"),
};
