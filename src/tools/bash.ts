import { spawn } from "node:child_process";
import type { Tool } from "./tool.ts";

/** After a SIGTERM, anything still running gets this long before SIGKILL. */
const FORCE_KILL_MS = 3_000;

/**
 * Commands still running when the process exits: their groups are killed too,
 * or a detached background child outlives the agent that started it.
 */
const live = new Set<number>();
process.on("exit", () => {
  for (const pid of live) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

/**
 * Runs a shell command in the current working directory; output and non-zero
 * exits come back as the result so the model can react to them. The shell runs
 * as its own process group, so a timeout kills the command and everything it
 * spawned, not just the shell.
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
    const timeoutMs = timeout == null ? 100_000 : Number(timeout);
    const maxBytes = maxBuffer == null ? 10 * 1024 * 1024 : Number(maxBuffer);

    return await new Promise<string>((resolve) => {
      const child = spawn(cmd, {
        shell: true,
        detached: true,
        cwd: cwd == null ? undefined : String(cwd),
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      if (pid) live.add(pid);

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let overflow = false;
      let spawnError: (Error & { code?: string }) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      let done = false;

      const kill = (signal: NodeJS.Signals) => {
        if (!pid) return;
        try {
          process.kill(-pid, signal);
        } catch {
          /* already gone */
        }
      };
      const killForGood = () => {
        kill("SIGTERM");
        forceKill = setTimeout(() => kill("SIGKILL"), FORCE_KILL_MS);
      };

      const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
        if (overflow) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          overflow = true;
          killForGood();
          return;
        }
        chunks.push(chunk);
      };
      child.stdout?.on("data", collect(out));
      child.stderr?.on("data", collect(err));

      child.on("error", (error) => {
        spawnError = error as Error & { code?: string };
      });
      timer = setTimeout(() => {
        timedOut = true;
        killForGood();
      }, timeoutMs);

      child.on("close", (code, signal) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (forceKill) clearTimeout(forceKill);
        if (pid) live.delete(pid);
        const text = [Buffer.concat(out), Buffer.concat(err)].map((b) => b.toString("utf8")).filter(Boolean).join("\n");
        if (timedOut) return resolve(`timed out after ${timeoutMs}ms`);
        if (overflow) return resolve(`output exceeded ${maxBytes} bytes; command killed\n${text}`);
        if (spawnError) return resolve(`exit ${spawnError.code ?? "unknown"}\n${text || spawnError.message}`);
        if (code == null && signal) return resolve(`killed by ${signal}\n${text}`);
        // Non-zero exit keeps stdout/stderr so the model sees what actually happened.
        if (code !== 0) return resolve(text ? `exit ${code}\n${text}` : `exit ${code}`);
        return resolve(text || "(no output)");
      });
    });
  },
};
