import { readFile, stat } from "node:fs/promises";
import type { Tool } from "./tool.ts";

/**
 * Above this size a read is refused: the whole file is loaded to number its
 * lines, and the window is not a file viewer. Grep finds the part that matters;
 * head/tail/sed through bash reads a range.
 */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/** Reads a text file from disk; failures surface to the model as an error result. */
export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file and return its contents, optionally a slice of its lines. " +
    "Each line is prefixed with its line number. " +
    "Use when: you need what is in a file - always before editing it. " +
    "Pass offset/limit if you only need a specific part of it.",
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
    const file = String(path);
    const { size } = await stat(file);
    if (size > MAX_READ_BYTES) {
      throw new Error(
        `${file} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_READ_BYTES / 1024 / 1024} MB read limit; ` +
          "use grep to find the lines you need, or bash with head/tail/sed to read a range",
      );
    }
    const lines = (await readFile(file, "utf8")).split("\n");
    const start = offset == null ? 0 : Math.max(0, Number(offset) - 1);
    const end = limit == null ? lines.length : start + Number(limit);
    // The number is the real file line, so offset/limit round-trip: what the
    // model cites is what the next read (or edit) will show.
    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}: ${line}`)
      .join("\n");
  },
};
