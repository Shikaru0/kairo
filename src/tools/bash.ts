import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./tool.ts";

const shell = promisify(exec);

/**
 * Runs a shell command in the current working directory; output and non-zero
 * exits come back as the result so the model can react to them.
 */
export const bashTool: Tool = {
  name: "bash",
  description: "Run a shell command and return its output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      cwd: { type: "string", description: "Directory to run the command in. Defaults to the current working directory." },
      timeout: { type: "number", description: "Kill the command after this many milliseconds. Defaults to 100000." },
      maxBuffer: { type: "number", description: "Maximum output bytes allowed. Defaults to 10485760." },
    },
    required: ["command"],
  },
  execute: async ({ command, cwd, timeout, maxBuffer }) => {
    const cmd = String(command);
    const options = {
      cwd: cwd == null ? undefined : String(cwd),
      timeout: timeout == null ? 100_000 : Number(timeout),
      maxBuffer: maxBuffer == null ? 10 * 1024 * 1024 : Number(maxBuffer),
    };
    try {
      const { stdout, stderr } = await shell(cmd, options);
      const out = [stdout, stderr].filter(Boolean).join("\n");
      return out || "(no output)";
    } catch (error: any) {
      if (error.killed) return `timed out after ${options.timeout}ms`;
      // Non-zero exit: keep stdout/stderr so the model sees what actually happened.
      const out = [error.stdout, error.stderr].filter(Boolean).join("\n");
      return `exit ${error.code ?? "unknown"}\n${out || error.message}`;
    }
  },
};
