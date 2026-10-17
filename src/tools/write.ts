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
      encoding: { type: "string", description: "Output encoding, e.g. utf8, utf16le, latin1, ascii, base64, hex. Defaults to utf8." },
    },
    required: ["path", "content"],
  },
  execute: async ({ path, content, encoding }) => {
    const file = String(path);
    const enc = encoding == null ? "utf8" : String(encoding) as BufferEncoding;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, String(content), enc);
    return `Wrote ${file} (${enc})`;
  },
};
