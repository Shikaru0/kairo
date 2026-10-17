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
    },
    required: ["command"],
  },
  execute: async ({ command }) => {
    const cmd = String(command);
    try {
      const { stdout, stderr } = await shell(cmd, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
      const out = [stdout, stderr].filter(Boolean).join("\n");
      return out || "(no output)";
    } catch (error: any) {
      // Non-zero exit: keep stdout/stderr so the model sees what actually happened.
      const out = [error.stdout, error.stderr].filter(Boolean).join("\n");
      return `exit ${error.code ?? "unknown"}\n${out || error.message}`;
    }
  },
};
