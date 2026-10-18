import { spawn } from "node:child_process";
import type { Tool } from "./tool.ts";

/** Matches one file may report; a broad pattern must not own the context. */
const DEFAULT_LIMIT = 100;
/** Bytes of output kept before the search is cut off, well under the spill size. */
const MAX_OUTPUT = 30_000;

/**
 * Search file contents with ripgrep. Results are `path:line:text`, the same
 * numbering read() reports, so a hit can be read back verbatim.
 */
export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a ripgrep regex; results are path:line:text and .gitignore is respected. " +
    "`path` scopes the search (defaults to the working directory), `include` filters files by glob " +
    "like **/*.ts, and `limit` caps matches per file.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex to search for." },
      path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
      include: { type: "string", description: "Only search files matching this glob, e.g. **/*.ts." },
      limit: { type: "number", description: "Maximum matches per file. Defaults to 100." },
    },
    required: ["pattern"],
  },
  execute: async ({ pattern, path, include, limit }) => {
    const query = String(pattern ?? "");
    if (!query) return "Error: pass a pattern to search for.";
    const where = String(path ?? "").trim() || ".";
    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      String(limit == null ? DEFAULT_LIMIT : Math.max(1, Number(limit))),
      // -e, so a pattern that starts with a dash is still a pattern.
      "-e",
      query,
    ];
    if (String(include ?? "")) args.push("--glob", String(include));
    args.push("--", where);

    // Args array instead of a shell string: no quoting footguns, and rg itself
    // spawns nothing, so a plain kill is the whole story.
    return await new Promise<string>((resolve) => {
      const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let overflow = false;
      let stderr = "";

      const take = (chunk: Buffer) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT) {
          overflow = true;
          child.kill("SIGTERM");
          return;
        }
        chunks.push(chunk);
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      // Resolving twice is harmless; a dead rg binary must surface as text, not a throw.
      child.on("error", (error) => resolve(`Error: ${error.message}`));

      child.on("close", (code) => {
        const text = Buffer.concat(chunks).toString("utf8").trimEnd();
        if (overflow) {
          const note = `output cut off at ${MAX_OUTPUT} bytes; narrow the search: a smaller path, an include glob, or a tighter pattern`;
          return resolve(text ? `${text}\n[${note}]` : `[${note}]`);
        }
        // rg exits 1 for "no matches"; anything else non-zero is a real error.
        if (code === 2 || code == null) return resolve(stderr.trim() || `rg exited with code ${String(code)}`);
        if (code === 1 || !text) return resolve(`no matches for "${query}" in ${where}`);
        resolve(text);
      });
    });
  },
};
