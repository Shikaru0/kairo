import { spawn } from "node:child_process";
import type { Tool } from "./tool.ts";

/** Matches one run may report; avoid dumping thousands of paths. */
const DEFAULT_LIMIT = 1000;
/** Bytes of output kept before the search is cut off. */
const MAX_OUTPUT = 30_000;

/**
 * Find files by glob pattern with ripgrep. Respects .gitignore.
 */
export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Respects .gitignore. " +
    "Use when: locating files by name/pattern (e.g. **/*.ts, src/**/*.json) - " +
    "prefer over find/ls via bash.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files against (e.g. **/*.ts)." },
      path: { type: "string", description: "Directory to search in. Defaults to the working directory." },
      limit: { type: "number", description: "Maximum number of files to return. Defaults to 1000." },
    },
    required: ["pattern"],
  },
  execute: async ({ pattern, path, limit }) => {
    const query = String(pattern ?? "");
    if (!query) return "Error: pass a pattern to search for.";
    const where = String(path ?? "").trim() || ".";
    const max = limit == null ? DEFAULT_LIMIT : Math.max(1, Number(limit));
    const args = [
      "--files",
      "--glob",
      query,
      "--color",
      "never",
    ];
    args.push("--", where);

    return await new Promise<string>((resolve) => {
      const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let overflow = false;
      let stderr = "";
      let count = 0;

      const take = (chunk: Buffer) => {
        if (overflow) return;
        const lines = chunk.toString("utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          count++;
          if (count > max) {
            overflow = true;
            child.kill("SIGTERM");
            return;
          }
          bytes += line.length + 1;
          if (bytes > MAX_OUTPUT) {
            overflow = true;
            child.kill("SIGTERM");
            return;
          }
          chunks.push(Buffer.from(line + "\n"));
        }
      };
      child.stdout?.on("data", take);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => resolve(`Error: ${error.message}`));

      child.on("close", (code) => {
        const text = Buffer.concat(chunks).toString("utf8").trimEnd();
        if (overflow) {
          const note = `output cut off at ${max} files or ${MAX_OUTPUT} bytes; narrow the pattern or path`;
          return resolve(text ? `${text}\n[${note}]` : `[${note}]`);
        }
        if (code === 2 || code == null) return resolve(stderr.trim() || `rg exited with code ${String(code)}`);
        if (code === 1 || !text) return resolve(`no files matching "${query}" in ${where}`);
        resolve(text);
      });
    });
  },
};
