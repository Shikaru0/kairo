import { readFile } from "node:fs/promises";
import type { Tool } from "./tool.ts";

/** Reads a text file from disk; failures surface to the model as an error result. */
export const readTool: Tool = {
  name: "read",
  description: "Read a text file and return its contents, optionally a slice of its lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      offset: { type: "number", description: "First line to return (1-based). Defaults to the start of the file." },
      limit: { type: "number", description: "Maximum number of lines to return. Defaults to the rest of the file." },
    },
    required: ["path"],
  },
  execute: async ({ path, offset, limit }) => {
    const text = await readFile(String(path), "utf8");
    if (offset == null && limit == null) return text;

    const lines = text.split("\n");
    const start = offset == null ? 0 : Math.max(0, Number(offset) - 1);
    const end = limit == null ? undefined : start + Number(limit);
    return lines.slice(start, end).join("\n");
  },
};
