import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "./tool.ts";

/** Writes text to disk, creating parent dirs; failures surface to the model as an error result. */
export const writeTool: Tool = {
  name: "write",
  description: "Write text content to a file, overwriting it if it exists.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      content: { type: "string", description: "Text to write to the file." },
    },
    required: ["path", "content"],
  },
  execute: async ({ path, content }) => {
    const file = String(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, String(content), "utf8");
    return `Wrote ${file}`;
  },
};
