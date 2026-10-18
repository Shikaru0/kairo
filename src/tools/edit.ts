import { readFile, writeFile } from "node:fs/promises";
import type { Tool } from "./tool.ts";

/**
 * Replaces exact text in a file. Requires a unique match unless `replaceAll`
 * is set, so an ambiguous edit fails loudly instead of corrupting the file.
 */
export const editTool: Tool = {
  name: "edit",
  description:
    "Replace exact text in a file. " +
    "Use when: changing an existing file with a small, exact replacement; new files and full rewrites go to write. " +
    "Read the file first and copy oldString verbatim from that read, " +
    "stripping the line-number prefixes read adds - they are not part of the file. " +
    "oldString must match exactly once unless replaceAll is true; if it does not match, re-read instead of guessing.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory." },
      oldString: { type: "string", description: "Exact text to replace, including indentation." },
      newString: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
    },
    required: ["path", "oldString", "newString"],
  },
  execute: async ({ path, oldString, newString, replaceAll }) => {
    const file = String(path);
    const before = String(oldString);
    if (!before) throw new Error("oldString must not be empty");

    const text = await readFile(file, "utf8");
    const count = text.split(before).length - 1;
    if (!count) throw new Error(`oldString not found in ${file}`);
    if (count > 1 && !replaceAll) {
      throw new Error(`oldString matches ${count} times in ${file}; add more context or set replaceAll`);
    }

    // split/join, not replace: replacement text must stay literal.
    await writeFile(file, text.split(before).join(String(newString)), "utf8");
    return count > 1 ? `Edited ${file} (${count} replacements)` : `Edited ${file}`;
  },
};
